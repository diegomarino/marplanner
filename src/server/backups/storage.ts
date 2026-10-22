/** Backups shelf storage module ( ADR-017 + ADR-042).
 * File truth (BACKUPS-INV-01): every list/type/creation-time derives from the filename alone —
 * mtime is advisory and NEVER read. Core infrastructure (peer of `../scheduler/`, `../telemetry/`)
 * — imports `getDb` from `../db/client` directly, same as `../telemetry/index.ts`; only the
 * scheduler *registration* seam (`job.ts`) goes through the host-api barrel (Rule B), mirroring
 * `telemetry/job.ts`'s documented rationale.
 * carry-forward ("the missing reverse guard"): `restore.ts` already
 * refuses to START a restore while `isSnapshotInProgress` (this module's own flag) is set —
 * that was the only direction wired. This module closes the reverse: `createSnapshot` now
 * refuses to START a NEW snapshot while a restore is in progress, UNLESS it is the restore
 * engine's own `type: "pre-restore"` call — `restoreDatabase` sets `restoreInProgressState`
 * BEFORE calling `createSnapshot("pre-restore")` for its own required pre-restore step (FR-006
 * step 6), so an unconditional refusal would deadlock every restore against itself. Gating on
 * `type !== "pre-restore"` distinguishes "an external caller (scheduled fire / manual
 * snapshot-now) racing an in-progress restore" from "the restore engine's own internal call"
 * without needing an extra parameter or a lock re-entrancy token — the type tag already carries
 * that information. This DOES introduce a two-way import between this module and `./restore`
 * (`./restore` already imports from here) — safe here because `isRestoreInProgress` is only ever
 * called from inside a function body at runtime (never at module-top-level eval), which both
 * CommonJS and native ESM circular-import resolution handle correctly.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb } from "../db/client";
import { readHouseholdTimezone } from "../lib/household-date";
import { isRestoreInProgress } from "./restore";
import type { BackupListItem, BackupType } from "../../shared";

// ─── Retention constants ( hardcoded + documented — FR-003) ─────

/** Newest N regular (scheduled|snapshot) backups are ALWAYS kept, regardless of age. */
export const RETAIN_COUNT = 14;
/** Beyond-count regular backups are pruned only once older than this many days. */
export const RETAIN_AGE_DAYS = 30;
/** Pre-restore lane: pure count, own rule, no age factor. */
export const PRE_RESTORE_KEEP = 5;
/** Household-local wall-clock nightly backup time. */
export const BACKUP_HOUR = "03:30";
/** Upload size cap, enforced BEFORE any disk write — used by the upload route. */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

// ─── Filename codec (— the metadata store) ────────────────────────

const FILENAME_PATTERN =
  /^(scheduled|snapshot|pre-restore|upload)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})(?:-(\d+))?\.db$/;

export interface ParsedBackupFilename {
  type: BackupType;
  /** Household-local calendar date encoded in the filename, "YYYY-MM-DD" — a plain string
   * comparison against the scheduler's `isMissed(date)` argument (the "string prefix
   * test"), never re-derived from `createdAt` to avoid any tz-inversion drift. */
  dateStr: string;
  /** Epoch ms, reconstructed from the household-tz-encoded components (display/sort only — the
   * codec's source of truth is the STRING, this is a best-effort inversion; see `localToEpoch`). */
  createdAt: number;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Household-local Y/M/D/H/M/S parts for `instantMs` in `tz` (Intl formatToParts technique,
 * mirrors `../lib/household-date.ts`'s `localDateParts` but also carries time-of-day). */
function localDateTimeParts(
  instantMs: number,
  tz: string
): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    y: part("year"),
    m: part("month"),
    d: part("day"),
    hh: part("hour"),
    mm: part("minute"),
    ss: part("second"),
  };
}

/** The UTC offset (ms) in effect for `tz` at `instantMs` (mirrors household-date.ts's private
 * `offsetMsAt`, duplicated here since that module exports no reusable primitive for an arbitrary
 * local-instant round trip — only the fixed-"HH:MM"-trigger case). */
function offsetMsAt(instantMs: number, tz: string): number {
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(wholeSecondMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const asUtcMs = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return asUtcMs - wholeSecondMs;
}

/** Invert household-local Y-M-D-H-M-S(.mmm) back to an epoch instant via a short fixed-point
 * offset probe. Unlike `household-date.ts`'s `nextOccurrenceInTz` (which resolves DST gap/overlap
 * ambiguity precisely, because a mis-fired scheduler trigger is a correctness bug), this is a
 * best-effort DISPLAY/sort inversion for an already-happened event's own filename — a backup
 * created inside a rare DST transition window may display a `createdAt` off by its zone's shift,
 * which is cosmetic only: `dateStr` (used by `isMissed`) is read directly from the filename
 * string, never through this inversion. */
function localToEpoch(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  ms: number,
  tz: string
): number {
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  let offset = offsetMsAt(naiveUtc, tz);
  let candidate = naiveUtc - offset;
  for (let i = 0; i < 3; i++) {
    const nextOffset = offsetMsAt(candidate, tz);
    if (nextOffset === offset) break;
    offset = nextOffset;
    candidate = naiveUtc - offset;
  }
  return candidate;
}

/** Format a backup filename: `{type}-{YYYYMMDD}-{HHMMSS}-{mmm}[-N].db`, household-tz date/time
 * components. `existingFilenames` is the current directory listing (or any
 * candidate set) — on a base-name collision (two backups in the same household-local
 * millisecond), an incrementing `-N` suffix is appended until the name is free.
 */
export function formatBackupFilename(
  type: BackupType,
  nowMs: number,
  existingFilenames: Iterable<string> = [],
  tz: string = readHouseholdTimezone()
): string {
  const { y, m, d, hh, mm, ss } = localDateTimeParts(nowMs, tz);
  const ms = ((nowMs % 1000) + 1000) % 1000;
  const base = `${type}-${pad(y, 4)}${pad(m, 2)}${pad(d, 2)}-${pad(hh, 2)}${pad(mm, 2)}${pad(ss, 2)}-${pad(ms, 3)}`;
  const existing = new Set(existingFilenames);
  if (!existing.has(`${base}.db`)) return `${base}.db`;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}.db`)) suffix += 1;
  return `${base}-${suffix}.db`;
}

/** Allowlist test only — `.db` + the exact codec charset. No traversal character (`/`, `..`,
 * space, etc.) can ever match this pattern (BACKUPS-INV-07/FR-012). */
export function isValidBackupFilename(filename: string): boolean {
  return typeof filename === "string" && FILENAME_PATTERN.test(filename);
}

/** Parse a filename into its codec-derived metadata, or `null` for anything that fails the
 * allowlist OR encodes an impossible calendar date (defensive — mirrors
 * `household-date.ts`'s `isStrictCalendarDate` intent). */
export function parseBackupFilename(
  filename: string,
  tz: string = readHouseholdTimezone()
): ParsedBackupFilename | null {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) return null;
  const [, type, yy, mo, dd, hh, mi, ss, ms] = match;
  const y = Number(yy);
  const m = Number(mo);
  const d = Number(dd);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null; // impossible calendar date (e.g. 2026-02-30) — reject, never normalize
  }
  const createdAt = localToEpoch(y, m, d, Number(hh), Number(mi), Number(ss), Number(ms), tz);
  return { type: type as BackupType, dateStr: `${yy}-${mo}-${dd}`, createdAt };
}

// ─── Root resolution + path safety ( FR-012) ────────────────────

/** `BACKUPS_ROOT` env override → default `${DATA_DIR}/backups`; created on demand. Always
 * returns an ABSOLUTE path (required for the in-root resolution check below). */
export function resolveBackupsRoot(): string {
  const root = process.env.BACKUPS_ROOT
    ? path.resolve(process.env.BACKUPS_ROOT)
    : path.resolve(process.env.DATA_DIR ?? process.cwd(), "backups");
  // Snapshots are full household copies: a root created here is owner-only (an existing,
  // operator-managed root keeps its mode).
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Resolve `filename` to an absolute path INSIDE the backups root, re-validating BOTH the
 * allowlist AND the resolved-inside-root property every call (FR-012 — "re-validated per
 * action", never cached from a prior list read). Returns `null` for anything invalid or that
 * would resolve outside the root. */
export function resolveBackupPath(filename: string): string | null {
  if (!isValidBackupFilename(filename)) return null;
  const root = resolveBackupsRoot();
  const resolved = path.resolve(root, filename);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

/** Hardened resolver for actions that OPEN or
 * COPY the BYTES of an EXISTING backup file — the restore engine's execution-time version-gate
 * read and its copy-source for the swap/rollback, plus a future delete/download route.
 * `resolveBackupPath` above is intentionally a PURE string/allowlist validator with NO
 * existence check — used for write TARGETS that legitimately don't exist yet (e.g. an upload's
 * destination path) — and is NOT sufficient here: it never dereferences the final path
 * component, so a filename that passes the allowlist but is actually a SYMLINK planted inside the
 * backups root (pointing anywhere on the filesystem) would sail through its plain
 * `path.resolve` + prefix check undetected, letting a destructive caller read/copy content it
 * was never authorized to touch. This resolver additionally: (1) `lstat`s the candidate and
 * rejects anything that is not a plain regular file — a genuine backup is created ONLY via
 * `fs.renameSync`/`fs.copyFileSync` from a same-directory temp file (this module's own
 * `createSnapshot`), so it can never legitimately be a symlink, directory, device file, etc;
 * (2) `realpath`s BOTH the backups root and the candidate and re-checks containment on the
 * REALPATH'd values — defense-in-depth against a symlinked root or an intermediate path
 * component, on top of the lstat check; (3) rejects anything with more than one hard link
 * (`stat.nlink !== 1`) — a genuine backup's inode is referenced from exactly one
 * directory entry (created only via `fs.renameSync`/`fs.copyFileSync`, never `fs.linkSync`), so
 * an extra link is itself a signal the file may be shared with — or planted to alias — something
 * outside this module's control. None of these checks is exhaustive against every conceivable
 * filesystem trick; together they close the concrete symlink/hardlink vectors this module's
 * threat model cares about. Returns `null` for anything invalid, non-existent, non-regular,
 * multiply-linked, or that escapes the root at either check — the caller maps that uniformly to
 * `not_found` (never leaking WHY the path was rejected).
 */
export function resolveExistingBackupPath(filename: string): string | null {
  if (!isValidBackupFilename(filename)) return null;
  const root = resolveBackupsRoot();
  const candidate = path.resolve(root, filename);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!candidate.startsWith(rootWithSep)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return null; // vanished between list and action — caller reports not_found
  }
  if (!stat.isFile()) return null; // rejects symlinks, directories, and anything else non-regular
  if (stat.nlink !== 1) return null; // rejects hardlinked files

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(root);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!realCandidate.startsWith(realRootWithSep)) return null;

  return candidate;
}

function safeReadDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone or never existed — fine */
  }
}

/** O_NOFOLLOW open + fstat re-check: closes the validate-then-reopen-by-path TOCTOU window between
 * `resolveExistingBackupPath`'s lstat/realpath validation and the actual byte-level open a
 * caller performs — sometimes moments later (a download route), sometimes SECONDS later (the
 * restore engine, after quiesce+drain+pre-restore-snapshot). Opening with `O_NOFOLLOW` makes the
 * open itself fail (`ELOOP`) if the final path component has, in the meantime, become a symlink;
 * the immediate `fstatSync(fd)` re-check re-confirms `isFile` + `nlink===1` against the SAME
 * inode the fd is now bound to — nothing can race a change to what the fd refers to after this
 * point (unlike a second `lstatSync`/`realpathSync` call on the PATH, which would itself still be
 * racing the filesystem). Returns the open fd on success (the CALLER owns closing it) or `null`
 * (never throws) for any rejection — ELOOP, ENOENT, non-regular, or multiply-linked.
 */
export function openExistingBackupFd(candidatePath: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(candidatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      fs.closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
    return null;
  }
}

/** Copy the entire contents of an ALREADY fd-validated source (see `openExistingBackupFd`
 * immediately above) to `destPath`, in bounded-size chunks — never buffering the whole backup
 * file in memory. This is the -hardened replacement for a plain
 * `fs.copyFileSync(sourcePath, destPath)` at the restore engine's swap step: reading through the
 * ALREADY-OPEN fd means the bytes actually copied can never be re-pointed at a different inode
 * after validation, regardless of what happens to the PATH the fd was originally opened from.
 * Does not close `sourceFd` — the caller owns its lifecycle (mirrors `openExistingBackupFd`'s own
 * contract).
 */
export function copyFdToPathSync(sourceFd: number, destPath: string): void {
  // Created owner-only: the copy is a full household database.
  const destFd = fs.openSync(destPath, "w", 0o600);
  try {
    const CHUNK_BYTES = 1024 * 1024; // 1 MiB — bounded, never the whole file at once
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      //: fs.writeSync is not guaranteed to write the full buffer in
      // one call (a short write is legal, e.g. on a signal interruption or a constrained target
      // filesystem) — loop until every byte of THIS chunk has actually landed before reading the
      // next one.
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destFd, buffer, written, bytesRead - written);
      }
      position += bytesRead;
    }
  } finally {
    fs.closeSync(destFd);
  }
}

/** Best-effort removal of a backup file's `-wal`/`-shm` companions: a READONLY open of a WAL-mode SQLite file — `isValidSqliteFile`,
 * the download-sql route's in-process dump, and `restore.ts`'s `checkVersionGate` — can still
 * create these sidecars; SQLite's shared-memory/WAL machinery activates independent of read/write
 * intent. Neither sidecar's name matches `FILENAME_PATTERN` (this module's own allowlist), so
 * nothing else on the shelf — `listBackups`, retention — ever notices or removes them on its own.
 * `-wal`/`-shm` are SHARED SQLite lock/state
 * files, not per-connection temporaries. Fastify serves overlapping requests even single-instance,
 * so two concurrent readers of the SAME shelf backup (e.g. two download-sql exports, or a
 * download-sql racing a restore's version gate) can each have a live connection against it at
 * once; unlinking the sidecars while ANOTHER connection still has them open can split lock state
 * or break that connection's subsequent reads. This function is therefore called ONLY from points
 * where NO connection can be using the backup:
 * - `sweepOrphanedBackupTempFiles` (below) — a BOOT-time sweep, between process lifetimes,
 * when nothing has any file open yet.
 * - the DELETE route (`routes/backups.ts`) — deleting the backup's own main file already implies
 * the same "nobody else can legitimately still be reading this exact file" precondition; a
 * concurrent reader losing its sidecars there is the same race class as losing the file itself.
 * It is deliberately NOT called from `isValidSqliteFile`, the download-sql dump generator, or
 * `checkVersionGate` — each of those opens a SHELF file that may have a concurrent reader, so
 * they leave any sidecar their own open creates for the boot sweep or a later DELETE to collect.
 */
export function unlinkBackupSidecars(fullPath: string): void {
  safeUnlink(`${fullPath}-wal`);
  safeUnlink(`${fullPath}-shm`);
}

/** Boot-time sweep for orphaned `.tmp-*` snapshot files and `-wal`/`-shm` sidecars that a prior
 * process lifetime left behind without ever reaching its own `unlinkBackupSidecars` call (e.g.
 * a hard kill mid-read). `createSnapshot`'s own try/catch removes ITS OWN temp file on any
 * failure it can observe (backup throwing, rename throwing, the post-rename fsync throwing) —
 * but a hard kill (SIGKILL, power loss) landing between `getDb.backup(tmpPath)` starting and the
 * rename can leave a `.tmp-*` file behind with nothing left to observe the failure and clean it
 * up. A `.tmp-*` name is never reused (the codec always stamps a fresh ms-precision timestamp per
 * snapshot attempt — `formatBackupFilename`), so any `.tmp-*` entry found here is unconditionally
 * safe to remove regardless of age: it can only be a leftover from a PRIOR, already-dead process.
 * A `-wal`/`-shm` sidecar is swept only when its base name (the suffix stripped) is itself a valid
 * backup filename — never touches an unrelated `-wal`/`-shm` file that happens to share this
 * directory for some other reason. Deliberately NOT run from `resolveBackupsRoot`'s own hot path
 * (called on every list/snapshot/route action) — that would pay a repeated `readdir` for a
 * condition that can only ever arise BETWEEN process lifetimes. Call this once, at process startup
 * (`src/server/index.ts`'s `main`), before the app starts serving traffic.
 */
export function sweepOrphanedBackupTempFiles(): void {
  const root = resolveBackupsRoot();
  for (const name of safeReadDirNames(root)) {
    if (name.startsWith(".tmp-")) {
      safeUnlink(path.join(root, name));
      continue;
    }
    for (const suffix of ["-wal", "-shm"]) {
      if (name.endsWith(suffix)) {
        const base = name.slice(0, -suffix.length);
        if (isValidBackupFilename(base)) safeUnlink(path.join(root, name));
      }
    }
  }
}

// ─── Upload validation ────────────────────────────────────

/** Confirm `filePath` parses as a genuine SQLite database by opening it readonly and reading
 * `sqlite_master` — a plain non-database file (including a `.sql` TEXT script; the upload route
 * carries no client-supplied filename to inspect an extension against, so THIS is the actual
 * `.sql` rejection mechanism, FR-011) fails the open or the query and is rejected. Mirrors
 * `restore.ts`'s own `checkVersionGate` open pattern, but asks a narrower question — "does this
 * parse as SQLite at all" — the upload route does not care about the migration-stamp match a
 * RESTORE would require; that gate is re-applied later, at restore time, against this exact file
 * once it is sitting on the shelf like any other backup.
 * this readonly open deliberately does NOT
 * sweep its own `-wal`/`-shm` sidecars. This function is called against a genuine SHELF file too
 * (the download-sql route validates `resolved` before dumping it) — sidecars are SHARED SQLite
 * lock/state, not a per-connection temporary, so unlinking them while another request's dump
 * connection on the SAME backup is still open (Fastify serves overlapping requests even
 * single-instance) can split lock state or break that connection's subsequent reads. Sweeping
 * only happens at quiescent points where no connection can be using the backup — see
 * `unlinkBackupSidecars`'s own doc comment.
 */
export function isValidSqliteFile(filePath: string): boolean {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}

// ─── Listing (BACKUPS-INV-01 — file-derived, mtime never read) ────────────────

/** Newest-first shelf listing. Foreign / invalid-name entries in the directory are silently
 * skipped (never break the list); a file that vanishes between `readdir` and `stat` (e.g. a
 * concurrent delete) is likewise skipped rather than throwing. perf nit: the household
 * timezone is read ONCE up front and passed to every `parseBackupFilename` call, mirroring
 * `hasBackupForDate`'s already-hoisted pattern below — the prior per-file default-parameter
 * read re-resolved `readHouseholdTimezone` (a `getDb`/settings read) once per directory
 * entry. */
export function listBackups(): BackupListItem[] {
  const root = resolveBackupsRoot();
  const tz = readHouseholdTimezone();
  const names = safeReadDirNames(root);
  const items: BackupListItem[] = [];
  for (const name of names) {
    const parsed = parseBackupFilename(name, tz);
    if (!parsed) continue;
    let sizeBytes: number;
    try {
      sizeBytes = fs.statSync(path.join(root, name)).size; // size only — mtime never read
    } catch {
      continue;
    }
    items.push({ filename: name, type: parsed.type, createdAt: parsed.createdAt, sizeBytes });
  }
  items.sort((a, b) => b.createdAt - a.createdAt || (a.filename < b.filename ? 1 : -1));
  return items;
}

/** Domain-state catch-up predicate: TRUE when a regular (scheduled|snapshot)
 * backup already exists whose filename-encoded household-local date equals `date`. Reads the
 * directory + the codec's raw `dateStr` directly — never through `listBackups`'s * `createdAt` epoch inversion, so this predicate can never be skewed by the display-only
 * DST rounding `localToEpoch` documents. */
export function hasBackupForDate(date: string, tz: string = readHouseholdTimezone()): boolean {
  const root = resolveBackupsRoot();
  const names = safeReadDirNames(root);
  return names.some((name) => {
    const parsed = parseBackupFilename(name, tz);
    return (
      parsed !== null &&
      (parsed.type === "scheduled" || parsed.type === "snapshot") &&
      parsed.dateStr === date
    );
  });
}

// ─── Retention (— pure, count-primary / age-secondary / floor) ────

/** Pure function over an already-computed listing: returns the filenames to delete. Regular
 * (scheduled|snapshot) backups: the newest `RETAIN_COUNT` are ALWAYS kept; beyond that count,
 * only backups older than `RETAIN_AGE_DAYS` are pruned (young beyond-count files survive). A
 * floor guard (BACKUPS-INV-05) additionally refuses to ever plan the regular lane down to zero
 * — structurally unreachable while `RETAIN_COUNT >= 1` (the newest N always survive the count
 * cut), but kept explicit rather than implicit. Pre-restore backups are a SEPARATE lane: pure
 * count (`PRE_RESTORE_KEEP`), no age factor. `upload-` backups are EXEMPT entirely — never
 * appear in the returned plan (explicit delete only).
 */
export function planPrune(listing: BackupListItem[], nowMs: number): string[] {
  const regular = listing
    .filter((b) => b.type === "scheduled" || b.type === "snapshot")
    .sort((a, b) => b.createdAt - a.createdAt);
  const preRestore = listing
    .filter((b) => b.type === "pre-restore")
    .sort((a, b) => b.createdAt - a.createdAt);

  const beyondCount = regular.slice(RETAIN_COUNT);
  const ageCutoff = nowMs - RETAIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const regularDeletions = beyondCount
    .filter((b) => b.createdAt < ageCutoff)
    .map((b) => b.filename);

  const survivingRegularCount = regular.length - regularDeletions.length;
  if (survivingRegularCount < 1 && regularDeletions.length > 0) {
    regularDeletions.shift(); // spare the newest deletion candidate to hold the floor
  }

  const preRestoreDeletions = preRestore.slice(PRE_RESTORE_KEEP).map((b) => b.filename);

  return [...regularDeletions, ...preRestoreDeletions];
}

/** Whether deleting `filename` (an explicit, non-pruning delete — the route) would violate
 * the regular-lane floor (BACKUPS-INV-05/FR-013: "explicit delete MUST respect the retention
 * floor"). Exported now so can reuse the exact same rule the automatic prune enforces,
 * per ("explicit delete reuses the same floor check"). */
export function wouldViolateFloor(listing: BackupListItem[], filename: string): boolean {
  const target = listing.find((b) => b.filename === filename);
  if (!target || (target.type !== "scheduled" && target.type !== "snapshot")) return false;
  const regularCount = listing.filter(
    (b) => b.type === "scheduled" || b.type === "snapshot"
  ).length;
  return regularCount <= 1;
}

// ─── Snapshot creation (FR-002/FR-004, — the runnable skeleton) ──────────

/** Internal outcome — NOT a wire DTO. `SnapshotResult` (src/shared) only has `completed` /
 * `already_running`; a write failure (e.g. ENOSPC) is surfaced via `lastBackupError` + logs
 * (FR-002 edge case), not as a third `SnapshotResult` variant. The route layer (`routes/
 * backups.ts`) maps `ok:false` to a 500 `backup_failed` envelope — a pragmatic, documented
 * choice for this skeleton since the closed `BackupErrorCode` union covers
 * restore/import/delete failures only, not "the snapshot write itself failed". */
export type SnapshotOutcome = { ok: true; filename: string } | { ok: false; error: string };

/** set for the whole duration of ANY `createSnapshot` call
 * (scheduled, manual snapshot-now, AND the restore engine's own direct `pre-restore` call) —
 * the restore engine consults `isSnapshotInProgress` once at entry, BEFORE acquiring its own
 * `restoreInProgress` lock, to refuse starting a restore while a snapshot write is genuinely in
 * flight (belt-and-suspenders on top of the scheduler's own per-job guard, which only serializes
 * the scheduled/manual entry points against EACH OTHER, not against a restore attempt arriving
 * through a completely different code path). */
let snapshotInProgressState = false;

export function isSnapshotInProgress(): boolean {
  return snapshotInProgressState;
}

let lastBackupError: string | null = null;
/** Loud, admin-visible record of the most recent prune-loop failure — SEPARATE from
 * `lastBackupError`: a prune failure must never fail (or be conflated with) the snapshot call
 * that triggered it (FR-004's "prune failure surfaced separately, never fails the snapshot").
 * Wired into `BackupListResponse` (the C2 carry-forward — "DTO+model+contract in one
 * move": `src/shared/index.ts`'s `BackupListResponse`, the contract's matching schema, and
 * `routes/backups.ts`'s `GET /api/backups` handler were all updated together in the same change,
 * alongside this getter (test-visible) and `console.error` (job-log-visible). Cleared back to
 * `null` on the next cycle whose OWN prune pass has zero failures (self-healing once the
 * underlying condition, e.g. a permissions issue, clears). */
let lastPruneError: string | null = null;
/** Epoch ms of the last successful restore; 0 at boot (bumps this — "In-memory
 * state"). Exposed now so `BackupListResponse.dbGeneration` is wired end-to-end from. */
let dbGenerationState = 0;

export function getLastBackupError(): string | null {
  return lastBackupError;
}

export function getLastPruneError(): string | null {
  return lastPruneError;
}

export function getDbGeneration(): number {
  return dbGenerationState;
}

/** (restore engine) bumps this after a successful swap. Exported now so that lands the
 * increment without reaching into this module's private state another way. */
export function bumpDbGeneration(nowMs: number = Date.now()): number {
  dbGenerationState = nowMs;
  return dbGenerationState;
}

/** Test-only reset — module-level singleton state would otherwise leak across isolated-DB test
 * cases that share this process. */
export function __resetBackupsStateForTests(): void {
  lastBackupError = null;
  lastPruneError = null;
  dbGenerationState = 0;
  snapshotInProgressState = false;
}

function fsyncDir(dirPath: string): void {
  const fd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Create a snapshot via the online backup API: `await getDb.backup(tmpPath)` (the DB's one
 * async step) → atomic rename → a REQUIRED (not best-effort) directory fsync BEFORE reporting
 * success (— "durable" means rename-survives-power-loss) → prune-only-after-good
 * (a prune failure is logged and surfaced via nothing that fails THIS call — FR-004). On any
 * write failure (backup throws, e.g. ENOSPC; the rename throws; or the POST-rename fsync
 * throws), the reported outcome is `ok:false`, `lastBackupError` is set, and the failure is
 * logged loudly. Rename and fsync are deliberately TWO SEPARATE try/catch blocks: a
 * rename failure never left a file at `finalPath` in the first place (only the temp needs
 * cleanup), but an fsync failure happens AFTER the rename already landed — leaving that file on
 * the shelf while reporting `ok:false` would desync `listBackups`/`hasBackupForDate` (and
 * therefore the scheduler's catch-up predicate) from the reported outcome, so that branch also
 * unlinks the now-orphaned `finalPath`. NO pruning ever runs on any failure path (BACKUPS-AC-04
 * — "a failing backup run can never eat the shelf").
 */
export async function createSnapshot(
  type: Extract<BackupType, "scheduled" | "snapshot" | "pre-restore">,
  nowMs: number = Date.now()
): Promise<SnapshotOutcome> {
  // The reverse guard (this file's top doc comment): an EXTERNAL caller
  // (scheduled fire or manual snapshot-now, both routed through job.ts's single action) is
  // refused while a restore is in progress. The restore engine's OWN pre-restore call
  // (type === "pre-restore") is exempt — it is issued FROM INSIDE the very restore that set
  // `restoreInProgressState`, so refusing it here would deadlock every restore against itself.
  if (type !== "pre-restore" && isRestoreInProgress()) {
    return { ok: false, error: "restore_in_progress" };
  }
  snapshotInProgressState = true;
  try {
    return await createSnapshotInner(type, nowMs);
  } finally {
    snapshotInProgressState = false;
  }
}

async function createSnapshotInner(
  type: Extract<BackupType, "scheduled" | "snapshot" | "pre-restore">,
  nowMs: number
): Promise<SnapshotOutcome> {
  const root = resolveBackupsRoot();
  const existing = safeReadDirNames(root);
  const filename = formatBackupFilename(type, nowMs, existing);
  const finalPath = path.join(root, filename);
  const tmpPath = path.join(root, `.tmp-${filename}`);

  try {
    await getDb().backup(tmpPath);
  } catch (err) {
    safeUnlink(tmpPath);
    const message = err instanceof Error ? err.message : String(err);
    lastBackupError = message;
    console.error(`Backups: snapshot write failed (${type}):`, err);
    return { ok: false, error: message };
  }

  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    safeUnlink(tmpPath);
    const message = err instanceof Error ? err.message : String(err);
    lastBackupError = message;
    console.error(`Backups: snapshot rename failed (${type}):`, err);
    return { ok: false, error: message };
  }

  try {
    fsyncDir(root);
  } catch (err) {
    // The rename already landed on disk — without this, `finalPath` would sit on the shelf
    // (visible to listBackups/hasBackupForDate) even though this call reports failure
    //. Remove it so shelf state matches the reported outcome exactly.
    safeUnlink(finalPath);
    const message = err instanceof Error ? err.message : String(err);
    lastBackupError = message;
    console.error(`Backups: snapshot dir fsync failed after rename (${type}):`, err);
    return { ok: false, error: message };
  }

  lastBackupError = null;

  // pre-restore snapshots are their OWN retention lane (PRE_RESTORE_KEEP, count-only, no age
  // factor — planPrune already handles this) and are taken by the restore engine itself, under
  // its own restoreInProgress lock, immediately before the swap — pruning here is harmless (the
  // plan only ever touches beyond-K pre-restore files, never the one just written) and keeps ONE
  // prune code path for every snapshot type rather than a second, parallel one.
  //
  // Prune-only-after-good: reached ONLY once the new backup is durably on disk. A prune failure
  // here must never fail this (already-successful) snapshot call (FR-004) — but
  // it must also never be SILENTLY swallowed. `safeUnlink` itself swallows internally (by
  // design, for ordinary cleanup call sites where a missing/already-gone file is a non-event),
  // so routing prune deletions through it made the surrounding catch below structurally
  // unreachable: a persistent per-file failure (EACCES/EROFS/a locked file/etc.) would leave the
  // shelf growing forever with nothing logged and nothing recorded. Each deletion below gets its
  // OWN try/catch around a raw (non-swallowing) `fs.unlinkSync` — never `safeUnlink` — so one
  // file's failure cannot abort the rest of the plan, and every failure is collected into the
  // loud, admin-visible `lastPruneError`.
  try {
    const listing = listBackups();
    const toDelete = planPrune(listing, nowMs);
    const pruneFailures: string[] = [];
    for (const name of toDelete) {
      try {
        fs.unlinkSync(path.join(root, name));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pruneFailures.push(`${name}: ${message}`);
        console.error(`Backups: prune failed to delete "${name}" after a good snapshot:`, err);
      }
    }
    lastPruneError =
      pruneFailures.length > 0
        ? `Failed to prune ${pruneFailures.length} backup(s): ${pruneFailures.join("; ")}`
        : null;
  } catch (pruneErr) {
    // Defense-in-depth: listBackups/planPrune are pure reads over already-validated data and
    // are not expected to throw, but if they somehow do, that too must never fail this
    // already-successful snapshot call.
    const message = pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
    lastPruneError = message;
    console.error(
      "Backups: prune failed unexpectedly after a good snapshot (snapshot itself succeeded):",
      pruneErr
    );
  }

  return { ok: true, filename };
}
