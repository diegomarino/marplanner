/** Restore validates the selected shelf file, quiesces traffic and scheduler work,
 * drains active requests, takes a pre-restore snapshot and swaps the database.
 * Post-swap migration, weekday integrity and plugin reconciliation run before traffic resumes.
 * A forward failure rolls back to the pre-restore snapshot. If rollback fails,
 * keep the server quiesced and the scheduler stopped for manual recovery.
 * Validated file descriptors reject symlinks and recheck containment at use time.
 * WAL/SHM cleanup occurs only at quiescent boundaries. Never restart a scheduler
 * that was already stopped before this operation (including shutdown races).
 * The process shutdown deadline still applies to an in-flight restore.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb, resetDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { assertWeekdayIntegrity } from "../db/weekday-integrity";
import { getScheduler } from "../scheduler/index";
import {
  isValidBackupFilename,
  resolveExistingBackupPath,
  createSnapshot,
  isSnapshotInProgress,
  bumpDbGeneration,
  openExistingBackupFd,
  copyFdToPathSync,
} from "./storage";
import type { RestoreRequest, RestoreResult } from "../../shared";
import type { PluginLifecycle } from "../plugins/lifecycle";

type RestorePluginLifecycle = Pick<PluginLifecycle, "reconcileAll">;

/** The migrations table `migrate.ts` reads/writes — duplicated here (no exported constant on
 * that module) since the version gate needs its own readonly-connection query against a
 * NOT-YET-ACTIVE backup file, independent of `migrate.ts`'s own `getDb`-bound helpers. */
const MIGRATIONS_TABLE = "drizzle_universe_migrations";
const BASELINE_MIGRATION_FILE = "0000_current_baseline.sql";
const DEFAULT_MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

/** The one route excluded from both the quiesce 503 short-circuit AND the in-flight counter
 * (FR-006) — it is the request driving the quiesce; counting it would make
 * its own drain target unreachable (a restore request perpetually waiting on itself). */
export const RESTORE_ROUTE_PATH = "/api/backups/restore";

// ─── Restore-in-progress lock ────────────────────────────────────

let restoreInProgressState = false;

/** Consulted by the DELETE route (protected-pre-restore delete-refusal, FR-009) and by
 * this module's own re-entrancy guard below. */
export function isRestoreInProgress(): boolean {
  return restoreInProgressState;
}

// ─── Quiesce state + in-flight request and detached-work counter ─────────────

let quiescedState = false;
let inFlightCount = 0;

/** Consulted by `app.ts`'s global onRequest hook to 503 every `/api/*` request except the
 * restore route itself while a restore is mid-sequence. */
export function isQuiesced(): boolean {
  return quiescedState;
}

/** Claim a drain slot before starting an API request or detached calendar synchronization. */
export function beginRequest(): void {
  inFlightCount += 1;
}

/** Release a drain slot after its handler or detached work has finished, paired with beginRequest. */
export function endRequest(): void {
  inFlightCount = Math.max(0, inFlightCount - 1);
}

export function getInFlightCount(): number {
  return inFlightCount;
}

/** Test-only reset — module-level singleton state would otherwise leak across isolated-DB test
 * cases that share this process (mirrors storage.ts's `__resetBackupsStateForTests`). */
export function __resetRestoreStateForTests(): void {
  restoreInProgressState = false;
  quiescedState = false;
  inFlightCount = 0;
}

/** Test-only forced quiesce toggle — lets `app.ts`'s onRequest/onResponse hook be
 * exercised deterministically (503 shape, restore-route exemption, /health untouched) without
 * driving a real `restoreDatabase` call through its full async sequence just to observe the
 * hook's behavior while `isQuiesced` is true. */
export function __setQuiescedForTests(value: boolean): void {
  quiescedState = value;
}

/** Test-only forced restore-in-progress toggle (same rationale as `__setQuiescedForTests`
 * above) — lets `storage.ts`'s `createSnapshot` reverse guard and `routes/backups.ts`'s DELETE
 * protected-pre-restore refusal be exercised deterministically without driving a real
 * `restoreDatabase` call through its full async sequence (quiesce/drain/swap) just to observe
 * a guard that only checks `isRestoreInProgress` at its own entry. */
export function __setRestoreInProgressForTests(value: boolean): void {
  restoreInProgressState = value;
}

// ─── Configurable timings (test seam — production defaults are real wall-clock) ───────────────

export interface RestoreDeps {
  /** Deadline for the in-flight HTTP request counter to reach zero before the restore fail-safe
   * aborts (FR-006 "a drain that does not settle within the deadline ABORTS"). Real milliseconds
   * — this governs actual concurrent request completion, not a calendar computation, so a real
   * timer here is not the now-relative-assertion hazard; tests override it to a small value
   * to exercise the abort path without a real multi-second wait. */
  drainDeadlineMs: number;
  /** Poll cadence while waiting for the in-flight counter to drain ("poll ≤ ~2s"). */
  drainPollMs: number;
  /** The migrations directory both the version gate (file-set comparison) and `runMigrations`
   * read — overridable so integration tests can exercise the gate/migrate/rollback matrix against
   * disposable fixture directories instead of the real repo `drizzle/` tree. */
  migrationsDir: string;
}

const DEFAULT_RESTORE_DEPS: RestoreDeps = {
  drainDeadlineMs: 5_000,
  drainPollMs: 25,
  migrationsDir: DEFAULT_MIGRATIONS_DIR,
};

// ─── Version gate ─────────────────────────────────────────────────

type GateOutcome =
  | { kind: "ok"; needsMigration: boolean }
  | { kind: "downgrade_rejected" }
  | { kind: "unsupported_lineage" }
  | { kind: "incompatible_backup" };

/** Open the candidate backup `readonly`, read its `drizzle_universe_migrations` fileName set, and
 * compare it against the code's `migrationsDir` fileName set: readable metadata
 * lacking the baseline sentinel is UNSUPPORTED LINEAGE; a backup with the sentinel and ANY file
 * the code does not have is a downgrade — REJECTED; a missing table, a query that throws, or a
 * file that isn't a SQLite database at all is fail-closed INCOMPATIBLE (distinct from "older",
 * per FR-007); a sentinel-bearing subset-or-equal set is allowed, `needsMigration` true only when
 * the backup's set is a STRICT subset. Re-read every call — NEVER cached from `listBackups`
 * (FR-007 "re-read at execution time").
 */
function checkVersionGate(backupPath: string, migrationsDir: string): GateOutcome {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(backupPath, { readonly: true, fileMustExist: true });
  } catch {
    return { kind: "incompatible_backup" };
  }
  try {
    let rows: { fileName: string }[];
    try {
      rows = db.prepare(`SELECT fileName FROM \`${MIGRATIONS_TABLE}\``).all() as {
        fileName: string;
      }[];
    } catch {
      return { kind: "incompatible_backup" };
    }
    const backupFiles = new Set(rows.map((r) => r.fileName));
    // a readdirSync failure (a missing/unreadable migrations dir) must not escape
    // as an uncaught exception — fail-closed the same way an unreadable migrations TABLE does.
    let codeFiles: Set<string>;
    try {
      codeFiles = new Set(fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")));
    } catch {
      return { kind: "incompatible_backup" };
    }
    if (!backupFiles.has(BASELINE_MIGRATION_FILE)) {
      return { kind: "unsupported_lineage" };
    }
    for (const f of backupFiles) {
      if (!codeFiles.has(f)) return { kind: "downgrade_rejected" };
    }
    return { kind: "ok", needsMigration: backupFiles.size < codeFiles.size };
  } finally {
    db.close();
    // this readonly open does NOT sweep
    // its own `-wal`/`-shm` sidecars here — `backupPath` is a SHELF file another request may have
    // open concurrently (e.g. a download-sql export of this exact backup, racing this restore's
    // execution-time gate). Those sidecars are shared SQLite lock/state, not a per-connection
    // temporary; unlinking them out from under a still-open connection can split lock state or
    // break that connection's subsequent reads. Sidecars are swept only at points where NO
    // connection can be using the backup: the boot-time sweep (`sweepOrphanedBackupTempFiles`,
    // between process lifetimes) and the DELETE route (deleting the main file already implies the
    // same "nobody else can be reading this" precondition).
  }
}

// ─── Scheduler stop/restart, tolerant of "never initialized" ────────────

/** Stop and drain an initialized scheduler, including one that has never started.
 * Return true only when this call stopped a running scheduler, so restore cannot re-arm
 * a scheduler stopped by shutdown. restart also refuses to arm a never-started instance.
 */
async function stopSchedulerIfPresent(): Promise<boolean> {
  try {
    const scheduler = getScheduler();
    const alreadyStopped = scheduler.isStopped();
    await scheduler.stop();
    return !alreadyStopped;
  } catch {
    return false;
  }
}

/** Fire-and-forget re-arm, called after a successful restore/rollback AND only when THIS module
 * itself stopped the scheduler (never after a double-fault rollback failure — see this module's
 * doc comment). `Scheduler.restart` is `async` — even a SYNCHRONOUS throw inside its body (e.g.
 * `readHouseholdTimezone` hitting a broken `getDb` handle) surfaces as a REJECTED PROMISE, not
 * a synchronous throw at this call site. A bare `void`-ed call therefore leaves that
 * rejection UNHANDLED — Node terminates the whole process on an unhandled rejection by default,
 * which would violate ADR-017 far more severely than any error this function could otherwise
 * report. The `.catch` below is REQUIRED, not decorative: it is the only thing standing between
 * a scheduler-restart failure and a process crash.
 */
function restartSchedulerIfWasStopped(wasStopped: boolean): void {
  if (!wasStopped) return;
  try {
    const scheduler = getScheduler();
    scheduler.restart().catch((err: unknown) => {
      console.error("Backups: scheduler restart after a restore failed", err);
    });
  } catch {
    /* getScheduler itself threw synchronously — best-effort, nothing to restart */
  }
}

// ─── Force-close, WAL/SHM cleanup, copy-then-atomic-rename swap ───────────────

function activeDbPath(): string {
  const dir = process.env.DATA_DIR ?? process.cwd();
  const file = process.env.DATABASE_PATH ?? "marplanner.db";
  return path.resolve(dir, file);
}

/** Stale `-wal`/`-shm` companions of the OLD active file: a leftover WAL from the just-closed
 * connection would otherwise replay into the newly-swapped-in file on next open — the exact
 * old-inode corruption hazard ADR-017 documents. A MISSING companion (ENOENT — a fresh
 * instance or a non-WAL-mode file may have neither) is the only tolerated failure; any OTHER
 * error (EPERM/EIO/etc) is rethrown rather than swallowed — silently continuing past
 * an unremoved stale WAL is precisely the corruption vector this function exists to close, so a
 * failure here must abort the restore (the caller's try/catch maps it to a typed, rolled-back
 * result) rather than proceed as if cleanup had succeeded. */
function removeStaleWalShm(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") continue;
      throw err;
    }
  }
}

/** Copy an ALREADY fd-validated source (`sourceFd` — see `openExistingBackupFd`, storage.ts) ->
 * a same-directory temp file -> atomic rename over `targetPath`. The SOURCE (a shelf backup file,
 * or the pre-restore file on rollback) is never moved/mutated — only ever read, through the fd,
 * via `copyFdToPathSync`. Reading through an already-open fd rather than a plain
 * `fs.copyFileSync(sourcePath,...)` closes the TOCTOU window between this module's earlier
 * `resolveExistingBackupPath` validation (potentially SECONDS earlier — after quiesce+drain+
 * pre-restore-snapshot) and the actual byte-level read: whatever the fd was validated against at
 * open time is exactly what gets copied, regardless of what happens to the PATH afterward. This
 * function does not own `sourceFd`'s lifecycle — the caller opens and closes it. The `finally`
 * unlink prevents a DB-sized orphaned `.restore-tmp` file: if `renameSync` succeeded,
 * `tmpPath` no longer exists at that path (it became `targetPath`) and this is a harmless ENOENT
 * no-op; if the copy or `renameSync` THREW, this removes whatever partial/complete temp file was
 * left behind. Any failure here (from either step) propagates to the caller — this function does
 * not itself decide recovery. */
function swapInPlace(sourceFd: number, targetPath: string): void {
  const tmpPath = `${targetPath}.restore-tmp`;
  try {
    copyFdToPathSync(sourceFd, tmpPath);
    fs.renameSync(tmpPath, targetPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* already gone (rename succeeded) or never created (copy failed before writing) — fine */
    }
  }
}

/** open `sourcePath` via the O_NOFOLLOW+fstat-validated fd, hand it to
 * `swapInPlace`, and close it afterward regardless of outcome. Throws (never returns a swapped
 * state silently) when the fd-level re-validation itself fails — the caller's existing try/catch
 * around every `swapInPlace` call site maps that to the same failure path a copy/rename error
 * already takes. */
function swapInPlaceFromValidatedPath(sourcePath: string, targetPath: string): void {
  const sourceFd = openExistingBackupFd(sourcePath);
  if (sourceFd === null) {
    throw new Error("Backup source failed fd re-validation immediately before the swap copy");
  }
  try {
    swapInPlace(sourceFd, targetPath);
  } finally {
    try {
      fs.closeSync(sourceFd);
    } catch {
      /* best-effort */
    }
  }
}

async function drainInFlight(deadlineMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (getInFlightCount() > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

/** A cheap sanity probe run on the freshly-reopened, post-swap database, BEFORE this restore is
 * ever declared successful. The version gate only proves the candidate's
 * `drizzle_universe_migrations` fileName SET matches the code's — a forged file with that exact
 * bookkeeping table (and nothing else) would sail through the gate. This probe catches that:
 * `PRAGMA integrity_check` proves the file is a structurally coherent SQLite database (not
 * truncated/corrupt), and a trivial read against a genuine core table (`members`) proves it is
 * an actual household database, not a migrations-only forgery. Returns `false` on ANY failure
 * (never throws) — the caller treats that identically to a failed reopen: roll back.
 */
function postSwapHealthProbe(): boolean {
  try {
    const db = getDb();
    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") return false;
    db.prepare("SELECT 1 FROM members LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

/** Rollback net (FR-008): re-close handles, swap the ALREADY-WRITTEN pre-restore
 * snapshot back over the active path with the same copy-then-atomic-rename mechanics (no new
 * pre-restore snapshot — the existing one already captures the correct pre-restore state),
 * reopen, reconcile runtime truth when a lifecycle is present, then unquiesce + restart the
 * scheduler. The pre-restore file itself remains on its lane (never deleted by this path).
 * DOUBLE FAULT: if the ROLLBACK swap itself throws (the WAL/SHM cleanup, the copy,
 * the rename, or the reopen), reopening the doors now would serve whatever half-written state
 * that failed attempt left behind — there is no database this process can currently vouch for.
 * The only safe terminal state is QUIESCED: this does NOT unquiesce and does NOT restart the
 * scheduler (both would resurrect traffic/jobs against an unknown-state database). It logs
 * loudly and returns the distinct `rollback_failed` status, naming the pre-restore filename so a
 * human can restore it by hand — a manual-recovery terminal state by design, not a bug: pretending
 * to have recovered here would be the actual data-safety failure.
 */
async function rollbackToPreRestore(
  preRestorePath: string,
  preRestoreFilename: string,
  dbPath: string,
  schedulerWasStopped: boolean,
  reportedStatus: "migration_failed_rolled_back" | "incompatible_backup" | "swap_failed",
  pluginLifecycle?: RestorePluginLifecycle
): Promise<RestoreResult> {
  try {
    resetDb();
    removeStaleWalShm(dbPath);
    swapInPlaceFromValidatedPath(preRestorePath, dbPath);
    getDb();
    assertWeekdayIntegrity();
    await pluginLifecycle?.reconcileAll();
  } catch (err) {
    console.error(
      `Backups: ROLLBACK ITSELF FAILED after a restore failure ("${reportedStatus}") — the ` +
        `active database is in an UNKNOWN state. The server remains QUIESCED (scheduler stays ` +
        `stopped) — MANUAL RECOVERY REQUIRED: restore backup file "${preRestoreFilename}" onto ` +
        `the active database path by hand.`,
      err
    );
    return {
      status: "rollback_failed",
      message:
        `Rollback to the pre-restore snapshot failed; the server remains quiesced pending ` +
        `manual recovery. Restore backup file "${preRestoreFilename}" onto the active database ` +
        `by hand.`,
    };
  }
  quiescedState = false;
  restartSchedulerIfWasStopped(schedulerWasStopped);
  return {
    status: reportedStatus,
    message: "Restore failed; the active database was rolled back to the pre-restore snapshot",
  };
}

/** Execute the full ADR-017 restore sequence for `request`. Never throws — every failure mode is
 * a typed `RestoreResult` member. See this module's doc comment for the exact step order.
 */
export async function restoreDatabase(
  request: RestoreRequest,
  depsOverride?: Partial<RestoreDeps>,
  pluginLifecycle?: RestorePluginLifecycle
): Promise<RestoreResult> {
  const deps: RestoreDeps = { ...DEFAULT_RESTORE_DEPS, ...depsOverride };

  // 1. Typed-filename confirmation — before ANY side effect, before even the lock (FR-006).
  if (
    !request ||
    typeof request.filename !== "string" ||
    typeof request.confirmFilename !== "string" ||
    request.filename.length === 0
  ) {
    return { status: "validation_error", message: "filename and confirmFilename are required" };
  }
  if (!isValidBackupFilename(request.filename)) {
    return { status: "validation_error", message: "Invalid backup filename" };
  }
  if (request.filename !== request.confirmFilename) {
    return {
      status: "confirmation_mismatch",
      message: "Typed confirmation does not match the selected backup",
    };
  }

  // 2. Restore-in-progress lock. Checked+set SYNCHRONOUSLY, before any `await` in
  // this function — closes the concurrent-restore race: two near-simultaneous callers can
  // never both observe `restoreInProgressState === false`, since nothing yields the event
  // loop between the check and the set.
  if (restoreInProgressState) {
    return { status: "restore_in_progress", message: "A restore is already in progress" };
  }
  if (isSnapshotInProgress()) {
    return { status: "snapshot_in_progress", message: "A snapshot is currently being written" };
  }
  restoreInProgressState = true;

  let schedulerWasStopped: boolean;
  try {
    const candidatePath = resolveExistingBackupPath(request.filename);
    if (!candidatePath) {
      // Covers: vanished between list and action, AND the -hardened rejections (symlink,
      // non-regular file, escapes-root-after-realpath) — never distinguished in the response.
      return { status: "not_found", message: "The selected backup no longer exists" };
    }

    // 3. Execution-time version gate — re-read, never cached (FR-007).
    const gate = checkVersionGate(candidatePath, deps.migrationsDir);
    if (gate.kind === "downgrade_rejected") {
      return {
        status: "downgrade_rejected",
        message: "The selected backup is newer than the running code",
      };
    }
    if (gate.kind === "unsupported_lineage") {
      return {
        status: "unsupported_lineage",
        message: "The selected backup is not from the supported baseline lineage",
      };
    }
    if (gate.kind === "incompatible_backup") {
      return {
        status: "incompatible_backup",
        message: "The selected file is not a compatible backup",
      };
    }

    // 4. Quiesce: 503+Retry-After for /api/* (app.ts's hook, except this route) AND stop the
    // scheduler (new job runs blocked, any in-flight one drained) — set BEFORE the scheduler
    // stop call resolves so no timer-fired job can slip in during the (synchronous) stop.
    quiescedState = true;
    schedulerWasStopped = await stopSchedulerIfPresent();

    // 5. Drain the in-flight HTTP request counter to zero — deadline-bounded fail-safe abort.
    const drained = await drainInFlight(deps.drainDeadlineMs, deps.drainPollMs);
    if (!drained) {
      quiescedState = false;
      restartSchedulerIfWasStopped(schedulerWasStopped);
      return {
        status: "quiesce_timeout",
        message:
          "Timed out waiting for in-flight requests to drain; the active database is untouched",
      };
    }

    // 6. Take the pre-restore snapshot after draining, before closing handles.
    // This prevents a write between snapshot and swap; failure leaves the active database intact.
    const preRestoreOutcome = await createSnapshot("pre-restore");
    if (!preRestoreOutcome.ok) {
      quiescedState = false;
      restartSchedulerIfWasStopped(schedulerWasStopped);
      return { status: "pre_restore_failed", message: preRestoreOutcome.error };
    }
    const preRestorePath = resolveExistingBackupPath(preRestoreOutcome.filename);
    if (!preRestorePath) {
      // Should be unreachable (this module just created the file) — paranoid defense-in-depth
      //: if it somehow fails re-validation, abort exactly like a failed pre-restore write.
      // Nothing destructive has happened yet at this point (handles not yet closed).
      quiescedState = false;
      restartSchedulerIfWasStopped(schedulerWasStopped);
      console.error(
        `Backups: pre-restore snapshot "${preRestoreOutcome.filename}" failed re-validation immediately after creation`
      );
      return {
        status: "pre_restore_failed",
        message: "Pre-restore snapshot could not be validated after creation",
      };
    }

    // 7. Force-close ALL database handles (recycling connections is unsafe — old inode/WAL
    // hazard, ADR-017). The filesystem swap, reopen, health probe, and migration steps
    // below stay synchronous; the first permitted yield is lifecycle reconciliation after
    // the replacement database is fully ready and while traffic/jobs remain quiesced.
    resetDb();

    const dbPath = activeDbPath();

    // 8-9. Remove stale -wal/-shm companions of the OLD file, then copy-then-atomic-rename the
    // backup over the active path (the shelf file never moves). Wrapped: an
    // ENOSPC (or any other) failure in EITHER step must never escape uncaught — that would
    // strand quiescedState=true forever and leak an untyped 500. Recovered via the same
    // rollback-to-pre-restore path a migration/reopen failure uses, reporting the distinct
    // `swap_failed` status.
    try {
      removeStaleWalShm(dbPath);
      swapInPlaceFromValidatedPath(candidatePath, dbPath);
    } catch (err) {
      console.error("Backups: swap failed during restore — rolling back:", err);
      return await rollbackToPreRestore(
        preRestorePath,
        preRestoreOutcome.filename,
        dbPath,
        schedulerWasStopped,
        "swap_failed",
        pluginLifecycle
      );
    }

    // 10. Open fresh connections. If the swapped-in file somehow fails to open (defense-in-depth
    // — the gate already opened this exact file readonly moments earlier), roll back exactly
    // like a failed forward migration.
    try {
      getDb();
    } catch {
      return await rollbackToPreRestore(
        preRestorePath,
        preRestoreOutcome.filename,
        dbPath,
        schedulerWasStopped,
        "incompatible_backup",
        pluginLifecycle
      );
    }

    // Post-swap health probe: the version gate alone cannot detect a forged file
    // that merely SHARES the code's exact migrations fileName set but has no real schema/data —
    // roll back rather than declare a non-database "restored".
    if (!postSwapHealthProbe()) {
      console.error(
        "Backups: post-swap health probe failed (integrity_check or a core-table read) — rolling back."
      );
      return await rollbackToPreRestore(
        preRestorePath,
        preRestoreOutcome.filename,
        dbPath,
        schedulerWasStopped,
        "incompatible_backup",
        pluginLifecycle
      );
    }

    // 11. Run the normal migration runner when the backup was older.
    let migrated = false;
    if (gate.needsMigration) {
      try {
        runMigrations(deps.migrationsDir);
        migrated = true;
      } catch (err) {
        console.error("Backups: forward migration during restore failed — rolling back:", err);
        return await rollbackToPreRestore(
          preRestorePath,
          preRestoreOutcome.filename,
          dbPath,
          schedulerWasStopped,
          "migration_failed_rolled_back",
          pluginLifecycle
        );
      }
    }

    try {
      assertWeekdayIntegrity();
    } catch (err) {
      console.error("Backups: restored weekday integrity failed — rolling back:", err);
      return await rollbackToPreRestore(
        preRestorePath,
        preRestoreOutcome.filename,
        dbPath,
        schedulerWasStopped,
        "incompatible_backup",
        pluginLifecycle
      );
    }

    // 12. Reconcile the active runtime against the freshly restored canonical lifecycle state
    // while HTTP traffic remains quiesced and scheduler jobs remain stopped. A reconciliation
    // failure is a post-swap activation failure: roll back both the database and runtime truth
    // before either source of work is allowed to resume.
    try {
      await pluginLifecycle?.reconcileAll();
    } catch (err) {
      console.error("Backups: plugin lifecycle reconciliation failed — rolling back:", err);
      return await rollbackToPreRestore(
        preRestorePath,
        preRestoreOutcome.filename,
        dbPath,
        schedulerWasStopped,
        "migration_failed_rolled_back",
        pluginLifecycle
      );
    }

    // 13. Unquiesce + restart the scheduler.
    quiescedState = false;
    restartSchedulerIfWasStopped(schedulerWasStopped);

    // 14. Bump dbGeneration — the reload signal (D8); the response body IS the signal to the
    // initiating client, `GET /api/backups`'s existing `dbGeneration` field for everyone else.
    const dbGeneration = bumpDbGeneration();

    return { status: "restored", dbGeneration, migrated };
  } finally {
    restoreInProgressState = false;
  }
}
