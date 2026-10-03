import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  formatBackupFilename,
  parseBackupFilename,
  isValidBackupFilename,
  resolveBackupPath,
  resolveExistingBackupPath,
  resolveBackupsRoot,
  listBackups,
  planPrune,
  wouldViolateFloor,
  isValidSqliteFile,
  sweepOrphanedBackupTempFiles,
  openExistingBackupFd,
  copyFdToPathSync,
  unlinkBackupSidecars,
  RETAIN_COUNT,
  RETAIN_AGE_DAYS,
  PRE_RESTORE_KEEP,
} from "../../src/server/backups/storage";
import type { BackupListItem, BackupType } from "../../src/shared";
import { useIsolatedDb } from "../helpers/db";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** — filename codec + path-safety + retention-matrix unit tests
 * (BACKUPS-INV-01, BACKUPS-INV-05, BACKUPS-INV-07, BACKUPS-AC-05, FR-001/
 * FR-003/FR-012). Every date is DERIVED from a fixed anchor instant, never
 * an absolute wall-clock literal (the timestamp-time-bomb lesson) —
 * `ANCHOR_MS` is arbitrary but fixed, and every scenario computes offsets
 * from it.
 */

// Arbitrary, fixed anchor — 2026-06-15T12:00:00Z. All matrix scenarios below
// derive their instants as offsets from this, never as separate absolute
// literals.
const ANCHOR_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): number {
  return ANCHOR_MS - n * DAY_MS;
}

function makeItem(
  filename: string,
  type: BackupType,
  createdAt: number,
  sizeBytes = 1024
): BackupListItem {
  return { filename, type, createdAt, sizeBytes };
}

describe("backups filename codec (BACKUPS-INV-01, FR-001)", () => {
  useIsolatedDb();

  it("BACKUPS-INV-01: format -> parse round-trips type, dateStr, and createdAt for a fixed instant", () => {
    const tz = "Europe/Madrid";
    const filename = formatBackupFilename("snapshot", ANCHOR_MS, [], tz);
    expect(filename).toMatch(/^snapshot-\d{8}-\d{6}-\d{3}\.db$/);

    const parsed = parseBackupFilename(filename, tz);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("snapshot");
    // 2026-06-15T12:00:00Z is 2026-06-15T14:00:00+02:00 (CEST) in Madrid.
    expect(parsed?.dateStr).toBe("2026-06-15");
    expect(parsed?.createdAt).toBe(ANCHOR_MS);
  });

  it("BACKUPS-INV-01: round-trips across every declared BackupType prefix", () => {
    const types: BackupType[] = ["scheduled", "snapshot", "pre-restore", "upload"];
    for (const type of types) {
      const filename = formatBackupFilename(type, ANCHOR_MS, []);
      const parsed = parseBackupFilename(filename);
      expect(parsed?.type).toBe(type);
    }
  });

  it("FR-002 collision safety: two formats at the SAME instant append an incrementing -N suffix", () => {
    const first = formatBackupFilename("snapshot", ANCHOR_MS, []);
    const second = formatBackupFilename("snapshot", ANCHOR_MS, [first]);
    const third = formatBackupFilename("snapshot", ANCHOR_MS, [first, second]);
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(second).toMatch(/-2\.db$/);
    expect(third).toMatch(/-3\.db$/);
    // Every generated name still parses to the exact same instant.
    expect(parseBackupFilename(first)?.createdAt).toBe(ANCHOR_MS);
    expect(parseBackupFilename(second)?.createdAt).toBe(ANCHOR_MS);
    expect(parseBackupFilename(third)?.createdAt).toBe(ANCHOR_MS);
  });

  it("rejects an impossible calendar date embedded in an otherwise well-formed name", () => {
    // 2026-02-30 does not exist — the pattern matches structurally but the
    // calendar-date probe must reject it (mirrors household-date.ts's
    // isStrictCalendarDate intent).
    expect(parseBackupFilename("snapshot-20260230-033000-000.db")).toBeNull();
  });

  it("rejects a filename with an unrecognized type prefix", () => {
    expect(isValidBackupFilename("archive-20260615-120000-000.db")).toBe(false);
    expect(parseBackupFilename("archive-20260615-120000-000.db")).toBeNull();
  });
});

describe("backups path safety (BACKUPS-INV-07, BACKUPS-AC-05, FR-012)", () => {
  useIsolatedDb();

  it("BACKUPS-INV-07/BACKUPS-AC-05: a well-formed filename resolves INSIDE the backups root", () => {
    const root = resolveBackupsRoot();
    const filename = "snapshot-20260615-120000-000.db";
    const resolved = resolveBackupPath(filename);
    expect(resolved).toBe(path.join(root, filename));
    expect(resolved?.startsWith(root)).toBe(true);
  });

  it("BACKUPS-INV-07/BACKUPS-AC-05: the traversal + malformed-charset corpus is rejected — raw, mixed, and non-.db forms", () => {
    const corpus = [
      "../etc/passwd",
      "../../etc/passwd",
      "..",
      "snapshot-20260615-120000-000.db/../../../etc/passwd",
      "/etc/passwd",
      "snapshot-20260615-120000-000.sql", // wrong extension
      "snapshot-20260615-120000-000", // no extension
      "snapshot-20260615-120000-000.db.sql",
      "..%2Fetc%2Fpasswd", // already-encoded traversal (never decoded further here — rejected as a literal charset mismatch)
      "snapshot-2026-06-15-120000-000.db", // dashes in the date component — wrong shape
      "scheduled-20260615-120000-000-x.db", // non-numeric collision suffix
      "", // empty
      "snapshot-20260615-120000-000.db\0.db", // embedded NUL
      "unknown-20260615-120000-000.db", // unrecognized type prefix
    ];
    for (const candidate of corpus) {
      expect(isValidBackupFilename(candidate)).toBe(false);
      expect(resolveBackupPath(candidate)).toBeNull();
    }
  });

  it("BACKUPS-INV-07: re-validates per call — a path is never trusted from a prior resolution", () => {
    const good = "snapshot-20260615-120000-000.db";
    const bad = "../etc/passwd";
    // Calling resolveBackupPath repeatedly, interleaved, never caches a
    // stale verdict across calls.
    expect(resolveBackupPath(good)).not.toBeNull();
    expect(resolveBackupPath(bad)).toBeNull();
    expect(resolveBackupPath(good)).not.toBeNull();
  });
});

describe("backups hardened existing-file resolver (review carry-forward #637/#633 F9)", () => {
  useIsolatedDb();

  it("resolves a genuine regular file that passes the allowlist and sits inside the root", () => {
    const root = resolveBackupsRoot();
    const filename = "snapshot-20260615-120000-000.db";
    fs.writeFileSync(path.join(root, filename), "not a real sqlite file, just bytes");
    expect(resolveExistingBackupPath(filename)).toBe(path.join(root, filename));
  });

  it("returns null for a well-formed filename that does not exist on disk (never written)", () => {
    expect(resolveExistingBackupPath("snapshot-20260615-120000-000.db")).toBeNull();
  });

  it("returns null for the traversal + malformed-charset corpus, same as resolveBackupPath", () => {
    const corpus = [
      "../etc/passwd",
      "../../etc/passwd",
      "..",
      "/etc/passwd",
      "snapshot-20260615-120000-000.sql",
      "unknown-20260615-120000-000.db",
    ];
    for (const candidate of corpus) {
      expect(resolveExistingBackupPath(candidate)).toBeNull();
    }
  });

  it("F9: rejects a SYMLINK planted inside the backups root under an allowlisted name, even when it points at a file OUTSIDE the root", () => {
    const root = resolveBackupsRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-outside-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(
      secretPath,
      "outside-root contents that must never be readable via a backup filename"
    );

    const symlinkName = "snapshot-20260615-120000-000.db";
    const symlinkPath = path.join(root, symlinkName);
    fs.symlinkSync(secretPath, symlinkPath);

    // The allowlist + plain resolve+prefix check alone would NOT catch this (the symlink's own
    // path IS inside root) — resolveExistingBackupPath must reject it via the lstat regular-file
    // check regardless.
    expect(resolveExistingBackupPath(symlinkName)).toBeNull();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("F9: rejects a symlink even when it points at another file genuinely INSIDE the root", () => {
    const root = resolveBackupsRoot();
    const realName = "snapshot-20260615-120000-001.db";
    fs.writeFileSync(path.join(root, realName), "genuine backup bytes");
    const symlinkName = "snapshot-20260615-120000-000.db";
    fs.symlinkSync(path.join(root, realName), path.join(root, symlinkName));

    expect(resolveExistingBackupPath(symlinkName)).toBeNull();
    // The genuine, non-symlink file is unaffected and still resolves normally.
    expect(resolveExistingBackupPath(realName)).toBe(path.join(root, realName));
  });

  it("rejects a directory planted under an allowlisted name", () => {
    const root = resolveBackupsRoot();
    const dirName = "snapshot-20260615-120000-000.db";
    fs.mkdirSync(path.join(root, dirName));
    expect(resolveExistingBackupPath(dirName)).toBeNull();
  });

  it("P3-1: rejects a HARDLINKED file under an allowlisted name (nlink !== 1)", () => {
    const root = resolveBackupsRoot();
    const originalName = "snapshot-20260615-120000-001.db";
    const originalPath = path.join(root, originalName);
    fs.writeFileSync(originalPath, "genuine backup bytes");
    expect(resolveExistingBackupPath(originalName)).toBe(originalPath); // sanity: nlink===1 baseline

    const hardlinkName = "snapshot-20260615-120000-000.db";
    const hardlinkPath = path.join(root, hardlinkName);
    fs.linkSync(originalPath, hardlinkPath);

    // The hardlink is a second directory entry for the SAME inode — a genuine backup is created
    // only via rename/copy, never linkSync, so nlink > 1 is itself a rejection signal.
    expect(resolveExistingBackupPath(hardlinkName)).toBeNull();
    // The ORIGINAL path is now ALSO nlink=2 (both entries share one inode) — also rejected. This
    // is intentional, conservative behavior: once any extra link exists, neither path is trusted.
    expect(resolveExistingBackupPath(originalName)).toBeNull();
  });
});

describe("openExistingBackupFd — O_NOFOLLOW open + fstat re-check (F1, review #639/#640)", () => {
  useIsolatedDb();

  it("returns an open, readable fd for a genuine regular single-link file", () => {
    const root = resolveBackupsRoot();
    const filePath = path.join(root, "snapshot-20260615-120000-000.db");
    fs.writeFileSync(filePath, "genuine backup bytes");

    const fd = openExistingBackupFd(filePath);
    expect(fd).not.toBeNull();
    expect(fs.fstatSync(fd as number).isFile()).toBe(true);
    fs.readSync(fd as number, Buffer.alloc(4), 0, 4, 0); // fd is genuinely usable for reads
    fs.closeSync(fd as number);
  });

  it("returns null for a path that does not exist", () => {
    const root = resolveBackupsRoot();
    expect(openExistingBackupFd(path.join(root, "does-not-exist.db"))).toBeNull();
  });

  it("returns null for a directory", () => {
    const root = resolveBackupsRoot();
    const dirPath = path.join(root, "a-directory.db");
    fs.mkdirSync(dirPath);
    expect(openExistingBackupFd(dirPath)).toBeNull();
  });

  it("returns null for a hardlinked file (nlink !== 1)", () => {
    const root = resolveBackupsRoot();
    const originalPath = path.join(root, "original.db");
    fs.writeFileSync(originalPath, "genuine bytes");
    const hardlinkPath = path.join(root, "hardlink.db");
    fs.linkSync(originalPath, hardlinkPath);
    expect(openExistingBackupFd(hardlinkPath)).toBeNull();
  });

  it("returns null for a plain symlink target (baseline — O_NOFOLLOW rejects it directly)", () => {
    const root = resolveBackupsRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-outside-fd-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretPath, "must never be readable via a backup filename");
    const symlinkPath = path.join(root, "symlink.db");
    fs.symlinkSync(secretPath, symlinkPath);

    expect(openExistingBackupFd(symlinkPath)).toBeNull();
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("F1 RED-first: a path that PASSED resolveExistingBackupPath()'s validation is rejected at the fd layer once swapped to a symlink AFTER that validation (the actual TOCTOU race)", () => {
    const root = resolveBackupsRoot();
    const name = "snapshot-20260615-120000-000.db";
    const genuinePath = path.join(root, name);
    fs.writeFileSync(genuinePath, "genuine bytes at validation time");

    // Step 1: the earlier validation (resolveExistingBackupPath, e.g. inside a route handler)
    // sees a genuine regular file and approves it — this is the state BEFORE the fix's own
    // defense existed; a plain fs.createReadStream/fs.copyFileSync on this same path moments
    // later would have followed whatever now sits at this path.
    const resolved = resolveExistingBackupPath(name);
    expect(resolved).toBe(genuinePath);

    // Step 2: an attacker (or a concurrent process) swaps the target to a symlink pointing
    // outside the root — simulating the window between validation and the actual open.
    fs.unlinkSync(genuinePath);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-outside-toctou-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretPath, "must never be readable via a backup filename");
    fs.symlinkSync(secretPath, genuinePath);

    // Step 3: the fix — the actual open re-validates via the fd layer and rejects it, even
    // though the PATH already passed validation in step 1.
    expect(openExistingBackupFd(resolved as string)).toBeNull();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("copyFdToPathSync — fd-sourced chunked copy (F1, review #639/#640)", () => {
  useIsolatedDb();

  it("copies the exact bytes of a genuine fd-validated source to a destination path, across a multi-chunk file", () => {
    const root = resolveBackupsRoot();
    const sourcePath = path.join(root, "source.db");
    // Larger than the function's internal 1 MiB chunk size — exercises the read/write loop
    // across at least 3 chunk boundaries, not just a single-chunk happy path.
    const size = 1024 * 1024 * 2 + 12345;
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i++) content[i] = i % 256;
    fs.writeFileSync(sourcePath, content);

    const fd = openExistingBackupFd(sourcePath);
    expect(fd).not.toBeNull();
    const destPath = path.join(root, "dest.db");
    try {
      copyFdToPathSync(fd as number, destPath);
    } finally {
      fs.closeSync(fd as number);
    }

    const written = fs.readFileSync(destPath);
    expect(written.length).toBe(size);
    expect(Buffer.compare(written, content)).toBe(0);
  });

  it("copies a genuinely empty source without error", () => {
    const root = resolveBackupsRoot();
    const sourcePath = path.join(root, "empty.db");
    fs.writeFileSync(sourcePath, "");
    const fd = openExistingBackupFd(sourcePath);
    expect(fd).not.toBeNull();
    const destPath = path.join(root, "empty-dest.db");
    try {
      copyFdToPathSync(fd as number, destPath);
    } finally {
      fs.closeSync(fd as number);
    }
    expect(fs.readFileSync(destPath).length).toBe(0);
  });
});

describe("unlinkBackupSidecars placement (F2, review #637/#640; corrected per Codex P2 on #681)", () => {
  useIsolatedDb();

  it("unlinkBackupSidecars removes -wal and -shm companions, is a no-op when neither exists", () => {
    const root = resolveBackupsRoot();
    const base = path.join(root, "snapshot-20260615-120000-000.db");
    fs.writeFileSync(`${base}-wal`, "wal bytes");
    fs.writeFileSync(`${base}-shm`, "shm bytes");

    unlinkBackupSidecars(base);

    expect(fs.existsSync(`${base}-wal`)).toBe(false);
    expect(fs.existsSync(`${base}-shm`)).toBe(false);
    expect(() => unlinkBackupSidecars(base)).not.toThrow(); // no-op the second time
  });

  it("P2 (Codex on #681, review fold): isValidSqliteFile does NOT sweep -wal/-shm sidecars — this open may race a concurrent reader of the SAME shelf file, on BOTH the accept and reject paths", () => {
    const root = resolveBackupsRoot();

    const goodPath = path.join(root, "genuine.db");
    const db = new Database(goodPath);
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    } finally {
      db.close();
    }
    // Simulate sidecars belonging to ANOTHER, still-open connection on this exact shelf file
    // (e.g. a concurrent download-sql export) — isValidSqliteFile must leave them alone; sweeping
    // them here would race that other connection's shared SQLite lock/state.
    fs.writeFileSync(`${goodPath}-wal`, "another connection's live wal bytes");
    fs.writeFileSync(`${goodPath}-shm`, "another connection's live shm bytes");
    expect(isValidSqliteFile(goodPath)).toBe(true);
    expect(fs.existsSync(`${goodPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${goodPath}-shm`)).toBe(true);

    const badPath = path.join(root, "garbage.db");
    fs.writeFileSync(badPath, "-- this is a .sql text script, not a database\nSELECT 1;\n");
    fs.writeFileSync(`${badPath}-wal`, "another connection's live wal bytes");
    expect(isValidSqliteFile(badPath)).toBe(false);
    expect(fs.existsSync(`${badPath}-wal`)).toBe(true);
  });

  it("F2: sweepOrphanedBackupTempFiles also sweeps orphaned -wal/-shm sidecars of a valid backup name, but leaves an unrelated -wal/-shm file untouched", () => {
    const root = resolveBackupsRoot();
    const genuineName = "scheduled-20260615-033000-000.db";
    fs.writeFileSync(path.join(root, genuineName), "a real backup");
    // Orphaned sidecars — the base name is a valid backup filename, but nothing ever swept them
    // (a hard kill left them behind, per the module's own doc comment).
    fs.writeFileSync(path.join(root, `${genuineName}-wal`), "orphaned wal");
    fs.writeFileSync(path.join(root, `${genuineName}-shm`), "orphaned shm");
    // An unrelated file that merely happens to end in -wal/-shm but whose base is NOT a valid
    // backup filename — must never be touched by this sweep.
    fs.writeFileSync(path.join(root, "unrelated-file.txt-wal"), "leave me alone");

    sweepOrphanedBackupTempFiles();

    expect(fs.existsSync(path.join(root, genuineName))).toBe(true); // the real backup survives
    expect(fs.existsSync(path.join(root, `${genuineName}-wal`))).toBe(false);
    expect(fs.existsSync(path.join(root, `${genuineName}-shm`))).toBe(false);
    expect(fs.existsSync(path.join(root, "unrelated-file.txt-wal"))).toBe(true);
  });
});

describe("backups listing (BACKUPS-INV-01 — file-derived, mtime never read)", () => {
  useIsolatedDb();

  it("F8: createdAt and ordering are derived from the FILENAME alone — mutating mtime changes nothing", () => {
    const root = resolveBackupsRoot();
    const older = formatBackupFilename("scheduled", Date.UTC(2026, 5, 14, 3, 30, 0), []);
    const newer = formatBackupFilename("snapshot", Date.UTC(2026, 5, 15, 3, 30, 0), [older]);
    fs.writeFileSync(path.join(root, older), "older backup bytes");
    fs.writeFileSync(path.join(root, newer), "newer backup bytes");

    const before = listBackups();
    const olderCreatedAtBefore = before.find((b) => b.filename === older)?.createdAt;
    const newerCreatedAtBefore = before.find((b) => b.filename === newer)?.createdAt;
    expect(before[0].filename).toBe(newer); // newest-first

    // Set the OLDER file's mtime to be far in the FUTURE (epoch 0 would also work — either
    // direction proves mtime is never consulted) — if listBackups ever read mtime, this alone
    // would flip the ordering and the reported createdAt.
    fs.utimesSync(path.join(root, older), new Date(0), new Date(0));

    const after = listBackups();
    expect(after.find((b) => b.filename === older)?.createdAt).toBe(olderCreatedAtBefore);
    expect(after.find((b) => b.filename === newer)?.createdAt).toBe(newerCreatedAtBefore);
    expect(after[0].filename).toBe(newer); // ordering unchanged
    expect(after[1].filename).toBe(older);
  });

  it("BACKUPS-INV-01: derives entirely from filenames — foreign files in the root are silently skipped", () => {
    const root = resolveBackupsRoot();
    const good1 = formatBackupFilename("scheduled", daysAgo(2), []);
    const good2 = formatBackupFilename("snapshot", daysAgo(1), [good1]);
    fs.writeFileSync(path.join(root, good1), "fake db bytes 1");
    fs.writeFileSync(path.join(root, good2), "fake db bytes 22");
    fs.writeFileSync(path.join(root, "README.txt"), "not a backup");
    fs.writeFileSync(path.join(root, "marplanner.db"), "not a backup either");

    const listing = listBackups();
    expect(listing.map((b) => b.filename).sort()).toEqual([good1, good2].sort());
    // Newest-first ordering.
    expect(listing[0].filename).toBe(good2);
    expect(listing[1].filename).toBe(good1);
    // Size comes from stat, never a fabricated/default value.
    const item2 = listing.find((b) => b.filename === good2);
    expect(item2?.sizeBytes).toBe(Buffer.byteLength("fake db bytes 22"));
  });
});

describe("backups retention matrix — planPrune (BACKUPS-INV-05, FR-003, research D3)", () => {
  it("count-primary: with more than RETAIN_COUNT regular backups all YOUNGER than the age cutoff, nothing beyond count is pruned", () => {
    const listing: BackupListItem[] = [];
    for (let i = 0; i < RETAIN_COUNT + 5; i++) {
      listing.push(makeItem(`scheduled-day${i}.db`, "scheduled", daysAgo(i)));
    }
    const plan = planPrune(listing, ANCHOR_MS);
    // The 5 oldest (beyond the newest 14) are all well under 30 days old here
    // (RETAIN_COUNT+4 = 18 days), so age-secondary does not fire yet.
    expect(plan).toEqual([]);
  });

  it("age-secondary: beyond-count backups OLDER than RETAIN_AGE_DAYS are thinned; young beyond-count survivors are not", () => {
    const listing: BackupListItem[] = [];
    // Newest 14 (index 0..13), well within the count floor.
    for (let i = 0; i < RETAIN_COUNT; i++) {
      listing.push(makeItem(`scheduled-recent-${i}.db`, "scheduled", daysAgo(i)));
    }
    // Beyond-count, but YOUNG (31 days — just past count, not past age).
    listing.push(makeItem("scheduled-beyond-young.db", "scheduled", daysAgo(RETAIN_COUNT + 1)));
    // Beyond-count AND old (well past RETAIN_AGE_DAYS).
    listing.push(makeItem("scheduled-beyond-old.db", "scheduled", daysAgo(RETAIN_AGE_DAYS + 10)));

    const plan = planPrune(listing, ANCHOR_MS);
    expect(plan).toEqual(["scheduled-beyond-old.db"]);
  });

  it("boundary: a beyond-count backup exactly AT the age cutoff survives (strictly-older, not equal)", () => {
    const listing: BackupListItem[] = [];
    for (let i = 0; i < RETAIN_COUNT; i++) {
      listing.push(makeItem(`scheduled-recent-${i}.db`, "scheduled", daysAgo(i)));
    }
    const cutoff = ANCHOR_MS - RETAIN_AGE_DAYS * DAY_MS;
    listing.push(makeItem("scheduled-at-cutoff.db", "scheduled", cutoff));
    const plan = planPrune(listing, ANCHOR_MS);
    expect(plan).toEqual([]);
  });

  it("floor: when total regular count is at or below RETAIN_COUNT, prune never touches the last surviving regular backup", () => {
    const listing: BackupListItem[] = [
      makeItem("scheduled-only.db", "scheduled", daysAgo(RETAIN_AGE_DAYS + 200)),
    ];
    const plan = planPrune(listing, ANCHOR_MS);
    expect(plan).toEqual([]);

    const single = listing.filter((b) => b.type === "scheduled" || b.type === "snapshot");
    expect(single.length - plan.length).toBeGreaterThanOrEqual(1);
  });

  it("pre-restore lane: its own count-only rule (keep newest PRE_RESTORE_KEEP), independent of the regular lane and age", () => {
    const listing: BackupListItem[] = [];
    for (let i = 0; i < PRE_RESTORE_KEEP + 3; i++) {
      // All very old — proves the pre-restore lane is COUNT-only, no age factor.
      listing.push(makeItem(`pre-restore-${i}.db`, "pre-restore", daysAgo(400 + i)));
    }
    const plan = planPrune(listing, ANCHOR_MS);
    expect(plan).toHaveLength(3);
    // The 3 OLDEST pre-restore files are the ones pruned (newest PRE_RESTORE_KEEP survive).
    const survivors = listing
      .filter((b) => !plan.includes(b.filename))
      .sort((a, b) => b.createdAt - a.createdAt);
    expect(survivors).toHaveLength(PRE_RESTORE_KEEP);
    expect(survivors[0].filename).toBe("pre-restore-0.db"); // newest (smallest daysAgo offset)
  });

  it("upload lane: upload- backups are EXEMPT from automatic prune regardless of age or count", () => {
    const listing: BackupListItem[] = [];
    for (let i = 0; i < RETAIN_COUNT + 10; i++) {
      listing.push(makeItem(`upload-${i}.db`, "upload", daysAgo(400 + i)));
    }
    const plan = planPrune(listing, ANCHOR_MS);
    expect(plan).toEqual([]);
  });

  it("mixed lanes: regular pruning, pre-restore pruning, and upload exemption all apply independently in one pass", () => {
    const listing: BackupListItem[] = [];
    for (let i = 0; i < RETAIN_COUNT; i++) {
      listing.push(makeItem(`scheduled-recent-${i}.db`, "scheduled", daysAgo(i)));
    }
    listing.push(makeItem("scheduled-old.db", "scheduled", daysAgo(RETAIN_AGE_DAYS + 1)));
    for (let i = 0; i < PRE_RESTORE_KEEP + 1; i++) {
      listing.push(makeItem(`pre-restore-${i}.db`, "pre-restore", daysAgo(500 + i)));
    }
    listing.push(makeItem("upload-ancient.db", "upload", daysAgo(1000)));

    const plan = planPrune(listing, ANCHOR_MS);
    expect(plan).toContain("scheduled-old.db");
    expect(plan).toContain("pre-restore-5.db"); // oldest of the 6 pre-restore files (index 0 = newest)
    expect(plan).not.toContain("upload-ancient.db");
    expect(plan).toHaveLength(2);
  });

  it("failed-cycle-no-prune plan: planPrune is a PURE read of the listing it is given — a listing that does not yet reflect a new backup produces the same plan whether or not a write attempt happened", () => {
    // planPrune itself has no notion of "did the write succeed" — that gating
    // lives entirely in createSnapshot's control flow (storage.ts,
    // tests/integration/backups-snapshot.test.ts). This test pins the pure
    // function's own contract: calling it twice with an IDENTICAL listing
    // (as would happen if a snapshot write failed and the shelf was
    // therefore never re-listed with a new entry) is deterministic and
    // side-effect-free.
    const listing: BackupListItem[] = [
      makeItem("scheduled-old.db", "scheduled", daysAgo(RETAIN_AGE_DAYS + 1)),
    ];
    const first = planPrune(listing, ANCHOR_MS);
    const second = planPrune(listing, ANCHOR_MS);
    expect(first).toEqual(second);
    // The listing array itself is never mutated by planPrune.
    expect(listing).toHaveLength(1);
  });
});

describe("wouldViolateFloor (BACKUPS-INV-05 — explicit-delete floor reuse, research D3)", () => {
  it("refuses to violate the floor when exactly one regular backup remains", () => {
    const listing: BackupListItem[] = [makeItem("scheduled-only.db", "scheduled", ANCHOR_MS)];
    expect(wouldViolateFloor(listing, "scheduled-only.db")).toBe(true);
  });

  it("allows deleting a regular backup when others remain", () => {
    const listing: BackupListItem[] = [
      makeItem("scheduled-a.db", "scheduled", daysAgo(1)),
      makeItem("scheduled-b.db", "scheduled", daysAgo(2)),
    ];
    expect(wouldViolateFloor(listing, "scheduled-a.db")).toBe(false);
  });

  it("never flags a pre-restore or upload backup as a floor violation (their own lanes)", () => {
    const listing: BackupListItem[] = [
      makeItem("scheduled-only.db", "scheduled", ANCHOR_MS),
      makeItem("pre-restore-1.db", "pre-restore", ANCHOR_MS),
      makeItem("upload-1.db", "upload", ANCHOR_MS),
    ];
    expect(wouldViolateFloor(listing, "pre-restore-1.db")).toBe(false);
    expect(wouldViolateFloor(listing, "upload-1.db")).toBe(false);
  });
});

describe("backups upload validation + boot sweep (F10 follow-up)", () => {
  useIsolatedDb();

  it("isValidSqliteFile: accepts a genuine SQLite file and rejects plain text / garbage bytes", () => {
    const root = resolveBackupsRoot();
    const goodPath = path.join(root, "genuine.db");
    const db = new Database(goodPath);
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    } finally {
      db.close();
    }
    expect(isValidSqliteFile(goodPath)).toBe(true);

    const badPath = path.join(root, "garbage.db");
    fs.writeFileSync(badPath, "-- this is a .sql text script, not a database\nSELECT 1;\n");
    expect(isValidSqliteFile(badPath)).toBe(false);

    expect(isValidSqliteFile(path.join(root, "does-not-exist.db"))).toBe(false);
  });

  it("sweepOrphanedBackupTempFiles: removes every .tmp-* entry, leaves genuine backups untouched", () => {
    const root = resolveBackupsRoot();
    const orphan1 = path.join(root, ".tmp-scheduled-20260615-030000-000.db");
    const orphan2 = path.join(root, ".tmp-snapshot-20260615-090000-000.db");
    const genuine = path.join(root, "scheduled-20260615-033000-000.db");
    fs.writeFileSync(orphan1, "partial write left behind by a killed process");
    fs.writeFileSync(orphan2, "another partial write");
    fs.writeFileSync(genuine, "a real, already-completed backup");

    sweepOrphanedBackupTempFiles();

    expect(fs.existsSync(orphan1)).toBe(false);
    expect(fs.existsSync(orphan2)).toBe(false);
    expect(fs.existsSync(genuine)).toBe(true);
  });

  it("sweepOrphanedBackupTempFiles: a no-op (never throws) when the root has no temp files", () => {
    expect(() => sweepOrphanedBackupTempFiles()).not.toThrow();
  });
});
