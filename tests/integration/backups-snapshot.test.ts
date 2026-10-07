import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { BACKUPS_JOB_ID, registerBackupsJob } from "../../src/server/backups/job";
import {
  createSnapshot,
  listBackups,
  getLastBackupError,
  getLastPruneError,
  getDbGeneration,
  resolveBackupsRoot,
  formatBackupFilename,
  planPrune,
  RETAIN_COUNT,
  RETAIN_AGE_DAYS,
  __resetBackupsStateForTests,
} from "../../src/server/backups/storage";
import { getDb } from "../../src/server/db/client";
import { hashKey } from "../../src/server/auth/credentials";
import {
  __resetRestoreStateForTests,
  __setRestoreInProgressForTests,
} from "../../src/server/backups/restore";
import { useIsolatedDb } from "../helpers/db";
import { FakeClock, noopLog } from "../helpers/fake-clock";

/** — the backups runnable skeleton, tested at the integration seam
 * (BACKUPS-INV-09, BACKUPS-AC-04, BACKGROUND-JOBS-SCHEDULER-AC-06,
 * FR-002/FR-004/FR-005). The scheduler truth-table suite mirrors
 * `tests/integration/daily-briefing-scheduled.test.ts`'s * `setupRealJob`/`newSyncedClock` pattern (a `FakeClock` driving the
 * scheduler's injected `now`, kept in lockstep with the REAL global `Date`
 * via `vi.setSystemTime` since `createSnapshot`'s `nowMs` default reads
 * `Date.now` — it has no clock seam of its own, exactly like
 * `generateAllBriefings`'s `resolveBusinessDate`).
 * UNLIKE daily-briefing's action, `createSnapshot` awaits the REAL
 * `getDb.backup` — a genuinely async native call using Node's real
 * `setImmediate` internally, which `FakeClock.flush`'s pure-microtask
 * spin does NOT drain. `waitForJobRun` below polls
 * `getScheduler.getJobState(...).lastRunAt` via REAL `setTimeout` (never
 * faked — `vi.useFakeTimers` here only fakes `Date`) until the actual write
 * has completed, instead of assuming a fixed number of microtask ticks is
 * enough.
 */

function shelfTree(root: string) {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .sort()
    .map((name) => {
      const file = path.join(root, name);
      return [name, fs.statSync(file).isFile() ? fs.readFileSync(file) : null];
    });
}

function seedMember(id: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    )
    .run(id, `Member ${id}`, now, now);
}

function countMembers(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM members").get() as { count: number };
  return row.count;
}

function activateBackupsPlugin(): void {
  getDb()
    .prepare(
      "UPDATE plugin_activation_registry SET state = 'active', updated_at = ? WHERE plugin_id = 'backups'"
    )
    .run(new Date().toISOString());
}

function lastRunAt(): number | null {
  return getScheduler().getJobState(BACKUPS_JOB_ID)?.lastRunAt ?? null;
}

/** Poll (REAL setTimeout) until the job's `lastRunAt` changes from `sinceRunAt` — bridges the gap
 * between the scheduler's FAKE clock and `createSnapshot`'s REAL async `db.backup` step. */
async function waitForJobRun(sinceRunAt: number | null, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (lastRunAt() !== null && lastRunAt() !== sinceRunAt) return;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the backups.nightly job to complete a run");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function newSyncedClock(startMs: number): FakeClock {
  vi.setSystemTime(startMs);
  return new FakeClock(startMs, (ms) => vi.setSystemTime(ms));
}

function setupRealJob(startMs: number): FakeClock {
  const clock = newSyncedClock(startMs);
  initScheduler({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: noopLog(),
  });
  registerBackupsJob();
  return clock;
}

// Europe/Madrid (default household tz), August 2026 = CEST (UTC+2). 03:30 local = 01:30 UTC.
const AUG21_BEFORE_0330_UTC = Date.UTC(2026, 7, 21, 0, 30, 0); // 02:30 local
const AUG21_0330_UTC = Date.UTC(2026, 7, 21, 1, 30, 0); // 03:30 local (the fire instant)
const AUG21_NOON_UTC = Date.UTC(2026, 7, 21, 10, 0, 0); // 12:00 local (well past 03:30)
const TODAY = "2026-08-21";

describe("backups snapshot creation (BACKUPS-INV-09, FR-002)", () => {
  useIsolatedDb();

  afterEach(() => {
    __resetBackupsStateForTests();
  });

  it("BACKUPS-INV-09: a snapshot is a consistent, independently-readable image — temp-write + atomic rename, and creation never mutates live data", async () => {
    seedMember("m1");
    seedMember("m2");
    expect(countMembers()).toBe(2);

    const outcome = await createSnapshot("snapshot", Date.now());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");

    // FR-002: snapshot creation MUST NOT mutate any household data.
    expect(countMembers()).toBe(2);

    // The reported filename is durably on disk (no lingering.tmp- file) and opens cleanly
    // read-only, independent of the live connection — the online-backup API's whole point.
    const root = resolveBackupsRoot();
    const finalPath = path.join(root, outcome.filename);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(path.join(root, `.tmp-${outcome.filename}`))).toBe(false);

    const snapshot = new Database(finalPath, { readonly: true, fileMustExist: true });
    try {
      const row = snapshot.prepare("SELECT COUNT(*) AS count FROM members").get() as {
        count: number;
      };
      expect(row.count).toBe(2);
    } finally {
      snapshot.close();
    }

    // A write AFTER the snapshot completed is reflected on the LIVE db but never retroactively
    // in the already-closed snapshot file — proving the two are genuinely independent images.
    seedMember("m3");
    expect(countMembers()).toBe(3);
    const reopened = new Database(finalPath, { readonly: true, fileMustExist: true });
    try {
      const row = reopened.prepare("SELECT COUNT(*) AS count FROM members").get() as {
        count: number;
      };
      expect(row.count).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("review F5: a dir-fsync failure AFTER a landed rename removes the orphaned file — shelf state matches the reported ok:false outcome", async () => {
    const root = resolveBackupsRoot();
    seedMember("m1");
    const before = shelfTree(root);

    // fs.fsyncSync is called ONLY by fsyncDir, strictly AFTER fs.renameSync has already
    // landed the file at its final path — the exact post-rename failure window review flags
    // (rename and fsync used to share one catch, so an fsync throw here would previously leave
    // the renamed file sitting on the shelf while the call still reported ok:false).
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("EIO: fsync failed");
    });
    let outcome;
    try {
      outcome = await createSnapshot("snapshot", Date.now());
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(outcome.ok).toBe(false);
    expect(getLastBackupError()).not.toBeNull();
    // No failed snapshot/temp file may remain; existing recovery data stays intact.
    expect(listBackups()).toHaveLength(0);
    expect(shelfTree(root)).toEqual(before);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-06 / BACKUPS-AC-04: on an injected write failure, NO pruning runs even though prune-eligible backups exist, the temp file is removed, and lastBackupError is set loudly", async () => {
    const root = resolveBackupsRoot();

    // Seed RETAIN_COUNT+2 regular backups, ALL older than RETAIN_AGE_DAYS — genuinely
    // prune-eligible under the real constants (unlike a single seeded backup, which can never be
    // prune-eligible under RETAIN_COUNT=14 — the original assertion was vacuous: it
    // passed even with the whole prune block moved AHEAD of the backup call).
    const oldFilenames: string[] = [];
    for (let i = 0; i < RETAIN_COUNT + 2; i++) {
      const fname = formatBackupFilename(
        "scheduled",
        Date.now() - (RETAIN_AGE_DAYS + 10 + i) * 24 * 60 * 60 * 1000,
        oldFilenames
      );
      fs.writeFileSync(path.join(root, fname), "old backup bytes");
      oldFilenames.push(fname);
    }
    // Live premise: prove the seeded listing IS prune-eligible BEFORE injecting any
    // failure — without this, "zero prunes happened" below would hold vacuously regardless of
    // whether prune ever actually ran.
    const preListing = listBackups();
    expect(preListing).toHaveLength(RETAIN_COUNT + 2);
    expect(planPrune(preListing, Date.now())).toHaveLength(2);
    const before = shelfTree(root);

    // Inject a REAL write failure without touching filesystem permissions — chmod 0o500 (the
    // original approach) ALSO blocked the later `safeUnlink(tmpPath)` cleanup call, making the
    // "no.tmp- leftover" assertion vacuous too. This spy instead writes PARTIAL
    // bytes to the destination (mimicking a mid-transfer ENOSPC) and then throws, so the
    // temp-file cleanup path is genuinely exercised with a real file present to clean up.
    const backupSpy = vi
      .spyOn(getDb(), "backup")
      .mockImplementation(async (dest: string): Promise<never> => {
        fs.writeFileSync(dest, "partial bytes");
        throw new Error("ENOSPC: no space left on device");
      });
    try {
      const outcome = await createSnapshot("snapshot", Date.now());
      expect(outcome.ok).toBe(false);
    } finally {
      backupSpy.mockRestore();
    }

    expect(getLastBackupError()).not.toBeNull();
    const names = fs.readdirSync(root);
    // No.tmp- file left behind — genuinely proven now that the spy actually wrote one.
    expect(names.some((n) => n.startsWith(".tmp-"))).toBe(false);
    // No prune ran off the failed cycle: every one of the RETAIN_COUNT+2 prune-eligible
    // pre-seeded files survives, byte-for-byte, none deleted.
    expect(shelfTree(root)).toEqual(before);
  });

  it("review C2: a prune deletion failure does not abort the plan or fail the snapshot — the failure is recorded/logged and the OTHER eligible files are still pruned", async () => {
    const root = resolveBackupsRoot();

    // Seed RETAIN_COUNT+3 aged regular backups: 3 genuinely prune-eligible (beyond count AND
    // older than RETAIN_AGE_DAYS) — enough to prove "one fails, the others still get deleted".
    const oldFilenames: string[] = [];
    for (let i = 0; i < RETAIN_COUNT + 3; i++) {
      const fname = formatBackupFilename(
        "scheduled",
        Date.now() - (RETAIN_AGE_DAYS + 10 + i) * 24 * 60 * 60 * 1000,
        oldFilenames
      );
      fs.writeFileSync(path.join(root, fname), "old backup bytes");
      oldFilenames.push(fname);
    }
    const eligible = planPrune(listBackups(), Date.now());
    expect(eligible).toHaveLength(3);

    // Make exactly ONE eligible file's deletion fail (a spy, not chmod — POSIX unlink
    // permission is governed by the CONTAINING DIRECTORY's write bit, not the target file's own
    // mode, so chmod-ing the file would not actually block its deletion). Every other path
    // passes through to the real fs.unlinkSync.
    const undeletable = eligible[0];
    const undeletablePath = path.join(root, undeletable);
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target) === undeletablePath) {
        throw new Error("EACCES: permission denied, unlink");
      }
      return realUnlinkSync(target);
    });

    let outcome;
    try {
      outcome = await createSnapshot("snapshot", Date.now());
    } finally {
      unlinkSpy.mockRestore();
    }

    // The snapshot itself is unaffected by the prune failure (FR-004).
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(fs.existsSync(path.join(root, outcome.filename))).toBe(true);

    // The failure is recorded/logged, never silently swallowed by safeUnlink.
    expect(getLastPruneError()).not.toBeNull();
    expect(getLastPruneError()).toContain(undeletable);
    // The snapshot's own error surface stays untouched — prune failures are SEPARATE (FR-004).
    expect(getLastBackupError()).toBeNull();

    const names = fs.readdirSync(root);
    // The undeletable file survives (its deletion genuinely failed)...
    expect(names).toContain(undeletable);
    //...but the OTHER two eligible files WERE still pruned — one failure never aborts the rest
    // of the plan.
    for (const other of eligible.slice(1)) {
      expect(names).not.toContain(other);
    }
  });
});

describe("backups nightly scheduler wiring (BACKGROUND-JOBS-SCHEDULER-AC-06, FR-005)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    __resetBackupsStateForTests();
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test — nothing to drain
    }
  });

  it("fires at 03:30 household-local and writes a scheduled- backup dated today", async () => {
    const clock = setupRealJob(AUG21_BEFORE_0330_UTC);
    await getScheduler().start();
    expect(lastRunAt()).toBeNull();

    await clock.advanceTo(AUG21_0330_UTC);
    await waitForJobRun(null);

    const listing = listBackups();
    expect(listing).toHaveLength(1);
    expect(listing[0].type).toBe("scheduled");
    expect(listing[0].filename).toMatch(new RegExp(`^scheduled-${TODAY.replace(/-/g, "")}-`));
  });

  it("isMissed matrix: start() past 03:30 with zero backup files — catch-up fires immediately", async () => {
    setupRealJob(AUG21_NOON_UTC);
    const before = lastRunAt();

    await getScheduler().start();
    await waitForJobRun(before);

    const listing = listBackups();
    expect(listing).toHaveLength(1);
    expect(listing[0].filename).toMatch(new RegExp(`^scheduled-${TODAY.replace(/-/g, "")}-`));
  });

  it("isMissed matrix: an existing regular backup for today blocks the catch-up sweep", async () => {
    const root = resolveBackupsRoot();
    const todayFilename = formatBackupFilename("snapshot", AUG21_NOON_UTC, []);
    fs.writeFileSync(path.join(root, todayFilename), "already backed up today");

    setupRealJob(AUG21_NOON_UTC);
    await getScheduler().start();
    // Give any (incorrectly-fired) catch-up a real chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(lastRunAt()).toBeNull();
    expect(listBackups()).toHaveLength(1); // only the pre-seeded file — no catch-up write added
  });

  it("isMissed matrix: start() BEFORE 03:30 never catches up, even with zero backup files (the window has not opened yet)", async () => {
    setupRealJob(AUG21_BEFORE_0330_UTC);
    await getScheduler().start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(lastRunAt()).toBeNull();
    expect(listBackups()).toHaveLength(0);
  });

  it("catch-up fires exactly once — a second overlapping window never produces a duplicate run", async () => {
    setupRealJob(AUG21_NOON_UTC);
    await getScheduler().start();
    await waitForJobRun(null);

    expect(lastRunAt()).not.toBeNull();
    expect(listBackups()).toHaveLength(1);

    // A DIFFERENT trigger (a manual call) is legitimate and independent of the one-shot
    // catch-up — the clock never advances here (deps.now stays pinned to AUG21_NOON_UTC, so
    // lastRunAt's VALUE is not a useful "did a second run happen" signal on its own), but the
    // guard being fully released (state.running cleared after the catch-up's `.finally`)
    // means this manual call is accepted as a real, separate "completed" run rather than an
    // "already_running" collision — proving the earlier catch-up was a single, ordinary
    // guarded run that released the lock, not some stuck/duplicated state.
    const manualResult = await getScheduler().runJobNow(BACKUPS_JOB_ID, { source: "snapshot" });
    expect(manualResult.status).toBe("completed");

    const listing = listBackups();
    expect(listing).toHaveLength(2); // catch-up's file + this manual run's file
    // Filename-prefix derivation: the catch-up (no invocation arg) tags
    // the cheduled-', the manual call ({ source: "snapshot" }) tags the napshot-' — a mutant that
    // always derives the cheduled' regardless of the invocation arg would collapse both to the
    // same prefix here.
    const scheduledEntry = listing.find((b) => b.type === "scheduled");
    const snapshotEntry = listing.find((b) => b.type === "snapshot");
    expect(scheduledEntry?.filename).toMatch(/^scheduled-/);
    expect(snapshotEntry?.filename).toMatch(/^snapshot-/);
  });

  it("a manual snapshot-now call while another run is in flight is told already_running, sharing ONE job id with the scheduled trigger", async () => {
    setupRealJob(AUG21_NOON_UTC);
    const scheduler = getScheduler();

    // Two manual calls issued back-to-back, synchronously, before either's action has any chance
    // to complete — proves the SAME per-job guard the wall-clock trigger uses (both entry points
    // key off BACKUPS_JOB_ID) serializes scheduled-vs-manual for free (clarify Q5).
    const p1 = scheduler.runJobNow(BACKUPS_JOB_ID, { source: "snapshot" });
    const p2 = scheduler.runJobNow(BACKUPS_JOB_ID, { source: "snapshot" });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r2).toEqual({ status: "already_running" });
    expect(r1.status).toBe("completed");
    if (r1.status === "completed") {
      expect(r1.result).toMatchObject({ ok: true });
    }
    expect(listBackups()).toHaveLength(1); // only ONE snapshot file was ever written
  });

  it("registers under BACKUPS_JOB_ID — the id routes/backups.ts's POST /api/backups/snapshot targets via runJobNow", () => {
    setupRealJob(AUG21_NOON_UTC);
    expect(getScheduler().getJobState(BACKUPS_JOB_ID)).toBeDefined();
    expect(BACKUPS_JOB_ID).toBe("backups.nightly");
  });
});

describe("backups end-to-end smoke (real app: snapshot -> list)", () => {
  useIsolatedDb();

  function seedAdminKey(): string {
    activateBackupsPlugin();
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(id, hashKey(rawKey), now);
    return rawKey;
  }

  beforeEach(() => {
    // `buildApp` deliberately never touches the scheduler (Constitution XIII structural
    // gating, src/server/index.ts's doc comment — every boundary/integration test must stay
    // timer-free by default). Production wires the scheduler separately via `startScheduler`
    // in `main`, AFTER `app.listen`; this boundary-level test reproduces just enough of that
    // wiring for the route under test (`runJobNow` needs an initialized, RUNNING singleton),
    // mirroring `tests/integration/telemetry-prune.test.ts`'s "real registration path" suite.
    initScheduler();
    registerBackupsJob();
  });

  afterEach(async () => {
    __resetBackupsStateForTests();
    await getScheduler().stop();
  });

  it("POST /api/backups/snapshot then GET /api/backups shows the created file, and member reads stay green", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedAdminKey();
    seedMember(randomUUID());
    const app = await buildApp();
    try {
      const snapshotRes = await app.inject({
        method: "POST",
        url: "/api/backups/snapshot",
        cookies: { mp_device_key: deviceKey },
      });
      expect(snapshotRes.statusCode).toBe(200);
      const snapshotBody = JSON.parse(snapshotRes.body);
      expect(snapshotBody.status).toBe("completed");
      expect(typeof snapshotBody.filename).toBe("string");
      // Filename-prefix derivation: the manual route always passes
      // { source: "snapshot" } through runJobNow, so the created file MUST be tagged
      // the napshot-', never the cheduled-' (a mutant hardcoding the cheduled' regardless of the
      // invocation arg would survive a bare typeof-string check).
      expect(snapshotBody.filename).toMatch(/^snapshot-/);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/backups",
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      expect(listBody.backups).toHaveLength(1);
      expect(listBody.backups[0].filename).toBe(snapshotBody.filename);
      expect(listBody.lastBackupError).toBeNull();
      expect(listBody.dbGeneration).toBe(getDbGeneration());

      // Read-boundary smoke (Constitution-XII precedent): the members read stays green after a
      // snapshot cycle — snapshot creation never touches the live connection's data.
      const membersRes = await app.inject({
        method: "GET",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
      });
      expect(membersRes.statusCode).toBe(200);
      expect(JSON.parse(membersRes.body)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("GET /api/backups with no authenticated key at all is rejected fail-closed (401, authBoundary)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/backups" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("GET /api/backups with an authenticated key lacking backups:admin is rejected fail-closed (403, capability seam)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    activateBackupsPlugin();
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, 'other:scope', 'device', ?)"
      )
      .run(id, hashKey(rawKey), Date.now());
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/backups",
        cookies: { mp_device_key: rawKey },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe("createSnapshot reverse guard", () => {
  useIsolatedDb();
  afterEach(() => __resetRestoreStateForTests());

  it("refuses an EXTERNAL snapshot attempt (scheduled/manual) while a restore is in progress", async () => {
    __setRestoreInProgressForTests(true);
    const outcome = await createSnapshot("scheduled");
    expect(outcome).toEqual({ ok: false, error: "restore_in_progress" });
    expect(listBackups()).toHaveLength(0); // nothing was written
  });

  it('does NOT refuse the restore engine\'s OWN pre-restore call — the self-exemption (type !== "pre-restore") — even while restoreInProgress is set', async () => {
    __setRestoreInProgressForTests(true);
    const outcome = await createSnapshot("pre-restore");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(listBackups().some((b) => b.filename === outcome.filename)).toBe(true);
    }
  });

  it("a manual snapshot-now request over HTTP is refused with 409 restore_in_progress while a restore is in progress", async () => {
    __setRestoreInProgressForTests(true);
    const { buildApp } = await import("../../src/server/app.ts");
    activateBackupsPlugin();
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(id, hashKey(rawKey), Date.now());
    initScheduler();
    registerBackupsJob();

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/snapshot",
        cookies: { mp_device_key: rawKey },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("restore_in_progress");
    } finally {
      await app.close();
      await getScheduler().stop();
    }
  });
});

describe("POST /api/backups/snapshot — write-failure envelope (F7, review #636/#637)", () => {
  useIsolatedDb();

  it("F7: an injected write failure surfaces as a 500 typed against BackupErrorCode ({error: 'backup_failed', message}), not an ad hoc envelope", async () => {
    activateBackupsPlugin();
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(id, hashKey(rawKey), Date.now());
    initScheduler();
    registerBackupsJob();

    const backupSpy = vi.spyOn(getDb(), "backup").mockImplementation(async (): Promise<never> => {
      throw new Error("ENOSPC: no space left on device");
    });

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/snapshot",
        cookies: { mp_device_key: rawKey },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["error", "message"]);
      expect(body.error).toBe("backup_failed");
      expect(typeof body.message).toBe("string");
    } finally {
      backupSpy.mockRestore();
      await app.close();
      await getScheduler().stop();
    }
  });
});
