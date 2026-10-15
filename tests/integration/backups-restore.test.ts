import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import * as householdDateModule from "../../src/server/lib/household-date";
import * as storageModule from "../../src/server/backups/storage";
import {
  createSnapshot,
  listBackups,
  resolveBackupsRoot,
  formatBackupFilename,
  __resetBackupsStateForTests,
} from "../../src/server/backups/storage";
import {
  restoreDatabase,
  isRestoreInProgress,
  isQuiesced,
  beginRequest,
  endRequest,
  __resetRestoreStateForTests,
} from "../../src/server/backups/restore";
import { getDb } from "../../src/server/db/client";
import { startExternalSourceSynchronization } from "../../src/server/modules/calendar/sync-coordinator";
import { useIsolatedDb } from "../helpers/db";

/** — the restore engine (ADR-017 sequence, FR-006..010). Fixture
 * backup DBs are built by APPLYING SUBSETS of the real `drizzle/*.sql` files (mirroring
 * `db/migrate.ts`'s own apply loop) so the version-gate + forward-migration matrix exercises
 * genuine schema state, never a hand-waved stub. Every timing constant is either derived from a
 * fixed anchor or a real-but-tiny wall-clock bound overridden via `RestoreDeps` — no now-relative
 * calendar assertions.
 * Trace tags exercised across this file: BACKUPS-INV-02, BACKUPS-INV-03, BACKUPS-INV-04,
 * BACKUPS-AC-01, BACKUPS-AC-02, BACKUPS-AC-06, BACKUPS-INV-05.
 */

const REAL_DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");
const REAL_MIGRATION_FILES = fs
  .readdirSync(REAL_DRIZZLE_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

function seedMemberInto(db: InstanceType<typeof Database>, id: string, displayName: string): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
  ).run(id, displayName, now, now);
}

function seedMember(id: string, displayName = `Member ${id}`): void {
  seedMemberInto(getDb(), id, displayName);
}

function countMembers(db: InstanceType<typeof Database> = getDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM members").get() as { count: number };
  return row.count;
}

function memberNames(db: InstanceType<typeof Database> = getDb()): string[] {
  return (
    db.prepare("SELECT display_name FROM members ORDER BY display_name").all() as {
      display_name: string;
    }[]
  ).map((r) => r.display_name);
}

/** Build a fixture backup DB at `dbPath`: applies `appliedFiles` (a subset/all of the REAL
 * `drizzle/*.sql` files, in order) exactly like `db/migrate.ts`'s own apply loop, recording each
 * in `drizzle_universe_migrations`; `extraFakeFiles` additionally records filenames that do NOT
 * correspond to any real migration (used to fabricate a "newer than code" / superset scenario
 * without needing a real extra migration file to exist). */
function buildFixtureDb(
  dbPath: string,
  appliedFiles: string[],
  extraFakeFiles: string[] = [],
  seed?: (db: InstanceType<typeof Database>) => void
): void {
  const db = new Database(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS `drizzle_universe_migrations` (`fileName` TEXT PRIMARY KEY NOT NULL, `appliedAt` INTEGER NOT NULL)"
    );
    for (const fileName of appliedFiles) {
      if (fileName === "0002_plugin_lifecycle.sql") {
        db.exec(
          `CREATE TEMP TABLE plugin_lifecycle_migration_context (
             kind TEXT NOT NULL,
             pre_run_migration_files TEXT NOT NULL,
             captured_at TEXT NOT NULL
           )`
        );
        db.prepare(
          `INSERT INTO temp.plugin_lifecycle_migration_context
             (kind, pre_run_migration_files, captured_at)
           VALUES ('prior_baseline', ?, ?)`
        ).run(JSON.stringify(["0000_current_baseline.sql"]), new Date().toISOString());
      }
      const sql = fs.readFileSync(path.join(REAL_DRIZZLE_DIR, fileName), "utf-8");
      db.exec(sql);
      if (fileName === "0002_plugin_lifecycle.sql") {
        db.exec("DROP TABLE temp.plugin_lifecycle_migration_context");
      }
      db.prepare(
        "INSERT INTO `drizzle_universe_migrations` (`fileName`, `appliedAt`) VALUES (?, ?)"
      ).run(fileName, Date.now());
    }
    for (const fileName of extraFakeFiles) {
      db.prepare(
        "INSERT INTO `drizzle_universe_migrations` (`fileName`, `appliedAt`) VALUES (?, ?)"
      ).run(fileName, Date.now());
    }
    if (seed) seed(db);
  } finally {
    db.close();
  }
}

/** a forgery that passes the version gate cleanly (its `drizzle_universe_migrations`
 * fileName SET is EXACTLY `fileNames`) but has none of the actual schema/data a genuine backup
 * created by applying those migrations would have — only the bookkeeping table itself. */
function buildForgedEmptyBackupWithMatchingFileSet(dbPath: string, fileNames: string[]): void {
  const db = new Database(dbPath);
  try {
    db.exec(
      "CREATE TABLE `drizzle_universe_migrations` (`fileName` TEXT PRIMARY KEY NOT NULL, `appliedAt` INTEGER NOT NULL)"
    );
    for (const fileName of fileNames) {
      db.prepare(
        "INSERT INTO `drizzle_universe_migrations` (`fileName`, `appliedAt`) VALUES (?, ?)"
      ).run(fileName, Date.now());
    }
  } finally {
    db.close();
  }
}

/** Write a fixture backup DB directly onto the shelf (bypassing `createSnapshot` — these fixtures
 * represent a controlled prior migration state, not a copy of the current active db) and return
 * its filename. */
function seedBackupFixture(
  type: "scheduled" | "snapshot" | "pre-restore" | "upload",
  nowMs: number,
  appliedFiles: string[],
  extraFakeFiles: string[] = [],
  seed?: (db: InstanceType<typeof Database>) => void
): string {
  const root = resolveBackupsRoot();
  const filename = formatBackupFilename(type, nowMs, fs.readdirSync(root));
  buildFixtureDb(path.join(root, filename), appliedFiles, extraFakeFiles, seed);
  return filename;
}

// A case that times out never reaches its own `scheduler.stop()`, and the live
// singleton then makes every later `initScheduler()` in this file throw.
afterEach(async () => {
  let scheduler: ReturnType<typeof getScheduler> | undefined;
  try {
    scheduler = getScheduler();
  } catch {
    return; // never initialized
  }
  if (!scheduler.isStopped()) await scheduler.stop();
});

describe("restore engine — confirmation + validation (BACKUPS-AC-01, no side effects)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("empty/missing filename -> validation_error, no side effects", async () => {
    const result = await restoreDatabase({ filename: "", confirmFilename: "" });
    expect(result.status).toBe("validation_error");
    expect(isRestoreInProgress()).toBe(false);
    expect(listBackups()).toHaveLength(0);
  });

  it("a filename that fails the allowlist -> validation_error, no side effects", async () => {
    const result = await restoreDatabase({
      filename: "../etc/passwd",
      confirmFilename: "../etc/passwd",
    });
    expect(result.status).toBe("validation_error");
    expect(isRestoreInProgress()).toBe(false);
  });

  it("invalid weekday data in same-version and older backups rolls back before runtime activation", async () => {
    seedMember("original", "Original");
    const scheduler = initScheduler();
    await scheduler.start();
    for (const appliedFiles of [REAL_MIGRATION_FILES, REAL_MIGRATION_FILES.slice(0, 1)]) {
      for (const weekdays of ["[1]", '["mon","bogus"]', "{broken", "1", "null", "{}"]) {
        const filename = seedBackupFixture("upload", Date.now(), appliedFiles, [], (db) => {
          seedMemberInto(db, "replacement", "Replacement");
          db.prepare(
            "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, created_at, updated_at) VALUES ('invalid', 'scheduled', 'apply_to_all', 'Test', ?, 0, 0)"
          ).run(weekdays);
        });
        const reconciledMembers: string[][] = [];
        const result = await restoreDatabase({ filename, confirmFilename: filename }, undefined, {
          reconcileAll: async () => {
            expect(isQuiesced()).toBe(true);
            expect(scheduler.isStopped()).toBe(true);
            reconciledMembers.push(memberNames());
            return { results: [] };
          },
        });
        expect(result.status).toBe("incompatible_backup");
        expect(memberNames()).toEqual(["Original"]);
        expect(
          getDb().prepare("SELECT id FROM reminder WHERE id = 'invalid'").get()
        ).toBeUndefined();
        expect(reconciledMembers).toEqual([["Original"]]);
        expect(isQuiesced()).toBe(false);
        expect(isRestoreInProgress()).toBe(false);
        await vi.waitFor(() => expect(scheduler.isStopped()).toBe(false));
        expect(listBackups().map((backup) => backup.filename)).toContain(filename);
      }
    }
    await scheduler.stop();
  }, 60_000); // Twelve restore cycles (~1.2 s each) share this case; allow for a loaded machine.

  it("invalid weekday data in the rollback snapshot keeps traffic and jobs quiesced", async () => {
    seedMember("original", "Original");
    getDb()
      .prepare(
        "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, created_at, updated_at) VALUES ('invalid', 'scheduled', 'apply_to_all', 'Test', '[1]', 0, 0)"
      )
      .run();
    const filename = seedBackupFixture("upload", Date.now(), REAL_MIGRATION_FILES, [], (db) => {
      seedMemberInto(db, "replacement", "Replacement");
      db.prepare(
        "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, created_at, updated_at) VALUES ('invalid', 'scheduled', 'apply_to_all', 'Test', '{broken', 0, 0)"
      ).run();
    });
    const scheduler = initScheduler();
    await scheduler.start();
    const reconcileAll = vi.fn(async () => ({ results: [] }));
    const result = await restoreDatabase({ filename, confirmFilename: filename }, undefined, {
      reconcileAll,
    });
    expect(result.status).toBe("rollback_failed");
    expect(memberNames()).toEqual(["Original"]);
    expect(reconcileAll).not.toHaveBeenCalled();
    expect(isQuiesced()).toBe(true);
    expect(scheduler.isStopped()).toBe(true);
    expect(isRestoreInProgress()).toBe(false);
  });

  it("confirmFilename mismatch blocks restore before any side effect (BACKUPS-AC-01)", async () => {
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
    seedMember("m1", "Original");
    let reconcileCalls = 0;

    const result = await restoreDatabase(
      { filename, confirmFilename: "wrong-name.db" },
      undefined,
      {
        reconcileAll: async () => {
          reconcileCalls += 1;
          return { results: [] };
        },
      }
    );

    expect(result.status).toBe("confirmation_mismatch");
    expect(isRestoreInProgress()).toBe(false);
    expect(isQuiesced()).toBe(false);
    // No side effects: the active db is untouched, member still present.
    expect(countMembers()).toBe(1);
    // The candidate backup file itself is untouched.
    expect(listBackups().map((b) => b.filename)).toContain(filename);
    expect(reconcileCalls).toBe(0);
  });

  it("a well-formed filename that vanished from disk -> not_found", async () => {
    const filename = "snapshot-20260615-120000-000.db"; // well-formed, never written
    let reconcileCalls = 0;
    const result = await restoreDatabase({ filename, confirmFilename: filename }, undefined, {
      reconcileAll: async () => {
        reconcileCalls += 1;
        return { results: [] };
      },
    });
    expect(result.status).toBe("not_found");
    expect(isRestoreInProgress()).toBe(false);
    expect(reconcileCalls).toBe(0);
  });
});

describe("restore engine — lock refusals (BACKUPS-INV-02/INV-05, research D7)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("a second concurrent restore attempt is refused with restore_in_progress", async () => {
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);

    const p1 = restoreDatabase({ filename, confirmFilename: filename });
    // Invoked synchronously, before p1 has a chance to run any microtask — the lock check+set
    // inside restoreDatabase happens before its first `await`, so this MUST observe the lock held.
    const p2 = restoreDatabase({ filename, confirmFilename: filename });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2.status).toBe("restore_in_progress");
    expect(r1.status).not.toBe("restore_in_progress");
  });

  it("a restore attempt while a snapshot write is genuinely in flight is refused with snapshot_in_progress", async () => {
    seedMember("m1");
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);

    // Kick off a REAL, genuinely-async snapshot write (never awaited yet) — createSnapshot sets
    // its in-progress flag synchronously before its own first await.
    const snapshotPromise = createSnapshot("snapshot");
    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("snapshot_in_progress");
    expect(isRestoreInProgress()).toBe(false);

    await snapshotPromise; // let the in-flight snapshot finish before the test tears down
  });
});

describe("restore engine — version gate matrix (BACKUPS-INV-04, BACKUPS-AC-02, FR-007)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("equal migration set -> restored, no forward migration needed", async () => {
    expect(
      getDb()
        .prepare("SELECT state FROM plugin_activation_registry WHERE plugin_id = 'backups'")
        .get()
    ).toEqual({ state: "inactive" });
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
      seedMemberInto(db, "backup-member", "From Backup")
    );
    seedMember("active-member", "Active State");

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("restored");
    if (result.status !== "restored") throw new Error("unreachable");
    expect(result.migrated).toBe(false);
    // The active db now reflects the BACKUP's content, not the pre-restore active state.
    expect(memberNames()).toEqual(["From Backup"]);
  });

  it("strict subset (older backup) -> restored with migrated:true, forward-migrated current", async () => {
    // The flattened production history has one irreducible baseline, so a valid older backup
    // must contain it. Add one disposable forward migration to make the test's running set
    // genuinely newer while keeping the backup schema/content real and valid.
    const currentMigrationsDir = mkdtempSync(path.join(tmpdir(), "mp-older-restore-"));
    const forwardMigration = "0001_restore_fixture_forward.sql";
    const currentMigrationFiles = [...REAL_MIGRATION_FILES, forwardMigration];
    try {
      for (const fileName of REAL_MIGRATION_FILES) {
        fs.copyFileSync(
          path.join(REAL_DRIZZLE_DIR, fileName),
          path.join(currentMigrationsDir, fileName)
        );
      }
      fs.writeFileSync(
        path.join(currentMigrationsDir, forwardMigration),
        "CREATE TABLE restore_fixture_forward_migration (id INTEGER PRIMARY KEY);"
      );

      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
        seedMemberInto(db, "backup-member", "Older Backup Member")
      );

      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        { migrationsDir: currentMigrationsDir }
      );

      expect(result.status).toBe("restored");
      if (result.status !== "restored") throw new Error("unreachable");
      expect(result.migrated).toBe(true);
      // The active db has the complete running migration set, including the real forward step.
      const applied = getDb().prepare("SELECT fileName FROM drizzle_universe_migrations").all() as {
        fileName: string;
      }[];
      expect(new Set(applied.map((r) => r.fileName))).toEqual(new Set(currentMigrationFiles));
      expect(
        getDb()
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'restore_fixture_forward_migration'"
          )
          .get()
      ).toEqual({ name: "restore_fixture_forward_migration" });
      expect(memberNames()).toEqual(["Older Backup Member"]);
    } finally {
      rmSync(currentMigrationsDir, { recursive: true, force: true });
    }
  });

  it("superset (backup has a migration the code does not) -> downgrade_rejected, active db untouched", async () => {
    seedMember("active-member", "Untouched");
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [
      "9999_from_the_future.sql",
    ]);

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("downgrade_rejected");
    expect(countMembers()).toBe(1);
    expect(memberNames()).toEqual(["Untouched"]);
    expect(isQuiesced()).toBe(false);
    expect(isRestoreInProgress()).toBe(false);
  });

  it("corrupt file (not a SQLite database) -> incompatible_backup, active db untouched", async () => {
    seedMember("active-member", "Untouched");
    const root = resolveBackupsRoot();
    const filename = formatBackupFilename("snapshot", Date.now(), fs.readdirSync(root));
    fs.writeFileSync(path.join(root, filename), "this is not a sqlite file at all");

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("incompatible_backup");
    expect(countMembers()).toBe(1);
  });

  it("a valid SQLite file with NO migrations table -> incompatible_backup (fail-closed, never 'older')", async () => {
    seedMember("active-member", "Untouched");
    const root = resolveBackupsRoot();
    const filename = formatBackupFilename("snapshot", Date.now(), fs.readdirSync(root));
    const db = new Database(path.join(root, filename));
    db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    db.close();

    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("incompatible_backup");
    expect(countMembers()).toBe(1);
  });
});

describe("restore engine — rollback net (BACKUPS-AC-02, research D6, FR-008)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("an injected forward-migration failure rolls back losslessly to the pre-restore snapshot", async () => {
    expect(
      getDb()
        .prepare("SELECT state FROM plugin_activation_registry WHERE plugin_id = 'backups'")
        .get()
    ).toEqual({ state: "inactive" });
    // A disposable migrations dir: the first two REAL migrations (a valid, applyable baseline)
    // plus one deliberately malformed extra file that throws when executed — isolates this test
    // from ever touching the real repo drizzle/ tree.
    const tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), "mp-broken-migrations-"));
    try {
      const baseline = REAL_MIGRATION_FILES.slice(0, 2);
      for (const fileName of baseline) {
        fs.copyFileSync(
          path.join(REAL_DRIZZLE_DIR, fileName),
          path.join(tmpMigrationsDir, fileName)
        );
      }
      const brokenFileName = "9999_broken.sql";
      fs.writeFileSync(
        path.join(tmpMigrationsDir, brokenFileName),
        "THIS IS NOT VALID SQL AT ALL; SYNTAX ERROR HERE;"
      );

      // Active (pre-restore) state: distinguishable content that MUST survive the rollback.
      seedMember("active-member", "Must Survive Rollback");

      // Fixture backup: applies ONLY the baseline (a strict subset of tmpMigrationsDir's set),
      // so the gate says needsMigration=true and runMigrations(tmpMigrationsDir) will attempt
      // (and fail on) the broken file.
      const filename = seedBackupFixture("snapshot", Date.now(), baseline, [], (db) =>
        seedMemberInto(db, "backup-member", "Backup Content (should not survive)")
      );

      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        { migrationsDir: tmpMigrationsDir }
      );

      expect(result.status).toBe("migration_failed_rolled_back");
      expect(isQuiesced()).toBe(false);
      expect(isRestoreInProgress()).toBe(false);
      // Lossless rollback: the active db is EXACTLY the pre-restore state, not the backup's.
      expect(memberNames()).toEqual(["Must Survive Rollback"]);

      // The pre-restore snapshot this rollback used remains on the shelf (never deleted by the
      // rollback path).
      const preRestoreEntries = listBackups().filter((b) => b.type === "pre-restore");
      expect(preRestoreEntries.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
    }
  });

  it("a lifecycle reconciliation failure rolls back DB and runtime truth before traffic or jobs resume", async () => {
    initScheduler();
    await getScheduler().start();
    try {
      seedMember("active-member", "Pre-Restore Runtime Truth");
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
        seedMemberInto(db, "backup-member", "Restored Runtime Truth")
      );
      const observations: Array<{
        memberNames: string[];
        quiesced: boolean;
        schedulerStopped: boolean;
      }> = [];
      let reconcileCalls = 0;
      const lifecycle = {
        reconcileAll: async () => {
          reconcileCalls += 1;
          observations.push({
            memberNames: memberNames(),
            quiesced: isQuiesced(),
            schedulerStopped: getScheduler().isStopped(),
          });
          if (reconcileCalls === 1) throw new Error("injected reconciliation failure");
          return { results: [] };
        },
      };

      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        undefined,
        lifecycle
      );

      expect(result.status).toBe("migration_failed_rolled_back");
      expect(observations).toEqual([
        {
          memberNames: ["Restored Runtime Truth"],
          quiesced: true,
          schedulerStopped: true,
        },
        {
          memberNames: ["Pre-Restore Runtime Truth"],
          quiesced: true,
          schedulerStopped: true,
        },
      ]);
      expect(memberNames()).toEqual(["Pre-Restore Runtime Truth"]);
      expect(isQuiesced()).toBe(false);
      expect(getScheduler().isStopped()).toBe(false);
    } finally {
      await getScheduler().stop();
    }
  });
});

describe("restore engine — quiesce lifecycle + drain (BACKUPS-INV-03, FR-006)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("quiesces synchronously at the start of the sequence and unquiesces on success", async () => {
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
    expect(isQuiesced()).toBe(false);

    const resultPromise = restoreDatabase({ filename, confirmFilename: filename });
    // The quiesce flag flips true SYNCHRONOUSLY, before the function's first real await settles
    // — true immediately after invocation, without needing to await anything yet.
    expect(isQuiesced()).toBe(true);

    const result = await resultPromise;
    expect(result.status).toBe("restored");
    expect(isQuiesced()).toBe(false);
  });

  it("a drain that never settles within the deadline ABORTS fail-safe: active DB untouched, unquiesced, scheduler restarted", async () => {
    initScheduler();
    await getScheduler().start();
    try {
      seedMember("active-member", "Must Survive Timeout");
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
        seedMemberInto(db, "backup-member", "Backup Content (must not land)")
      );

      // Simulate a stuck in-flight /api/* request that never completes during the drain window.
      beginRequest();
      try {
        const result = await restoreDatabase(
          { filename, confirmFilename: filename },
          { drainDeadlineMs: 60, drainPollMs: 10 }
        );

        expect(result.status).toBe("quiesce_timeout");
        expect(isQuiesced()).toBe(false);
        expect(isRestoreInProgress()).toBe(false);
        // Active DB untouched: the pre-timeout content is exactly preserved.
        expect(memberNames()).toEqual(["Must Survive Timeout"]);
        // No backup swap ever happened, so no pre-restore snapshot was ever taken either.
        expect(listBackups().filter((b) => b.type === "pre-restore")).toHaveLength(0);
        // Scheduler restarted (re-armed), not left permanently stopped.
        expect(getScheduler().isStopped()).toBe(false);
      } finally {
        endRequest();
      }
    } finally {
      await getScheduler().stop();
    }
  });

  it("B1: a timer-fired fake job during the quiesce window acquires NO run", async () => {
    initScheduler();
    let fired = 0;
    getScheduler().registerJob({
      id: "test.fake-fast-job",
      trigger: { kind: "interval", everyMs: 10 },
      action: () => {
        fired += 1;
      },
    });
    await getScheduler().start();
    try {
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);

      const result = await restoreDatabase({ filename, confirmFilename: filename });

      expect(result.status).toBe("restored");
      // The scheduler was stopped essentially immediately (synchronously) inside the restore
      // sequence, well before the slow pre-restore snapshot write — the fast interval job never
      // gets a chance to fire during the whole sequence.
      expect(fired).toBe(0);
    } finally {
      await getScheduler().stop();
    }
  });

  it("restore proceeds normally once an in-flight request drains before the deadline", async () => {
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
    beginRequest();
    const resultPromise = restoreDatabase(
      { filename, confirmFilename: filename },
      { drainDeadlineMs: 2000, drainPollMs: 10 }
    );
    // Let the drain poll observe the counter once, then release it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    endRequest();

    const result = await resultPromise;
    expect(result.status).toBe("restored");
  });
});

describe("restore engine — post-restore list derivation (BACKUPS-AC-06, FR-010)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("after a successful restore, the shelf list still derives correctly and includes the pre-restore snapshot", async () => {
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
    const before = listBackups();
    expect(before.map((b) => b.filename)).toContain(filename);

    const result = await restoreDatabase({ filename, confirmFilename: filename });
    expect(result.status).toBe("restored");

    const after = listBackups();
    // The original candidate backup is still present (the shelf file itself never moved).
    expect(after.map((b) => b.filename)).toContain(filename);
    // A pre-restore snapshot was taken and is listed.
    const preRestore = after.filter((b) => b.type === "pre-restore");
    expect(preRestore).toHaveLength(1);
    // dbGeneration bumped.
    if (result.status === "restored") {
      expect(result.dbGeneration).toBeGreaterThan(0);
    }
  });
});

describe("restore engine — swap failure recovery (review P1-1)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
    vi.restoreAllMocks();
  });

  it("a copy failure during the swap -> typed swap_failed, unquiesced, scheduler restarted, no tmp orphan, active DB rolled back intact", async () => {
    initScheduler();
    await getScheduler().start();
    try {
      seedMember("active-member", "Must Survive Swap Failure");
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
        seedMemberInto(db, "backup-member", "Backup Content (must not land)")
      );

      //: the swap step now copies through an already fd-validated source via
      // `storage.ts`'s exported `copyFdToPathSync` rather than a plain `fs.copyFileSync`. Only
      // the FIRST call (the forward swap's copy) fails — the rollback's own copy (the second
      // call) must proceed normally, so this is a SINGLE failure, not a double fault.
      const copySpy = vi.spyOn(storageModule, "copyFdToPathSync").mockImplementationOnce(() => {
        throw new Error("ENOSPC: no space left on device");
      });

      let result;
      try {
        result = await restoreDatabase({ filename, confirmFilename: filename });
      } finally {
        copySpy.mockRestore();
      }

      expect(result.status).toBe("swap_failed");
      expect(isQuiesced()).toBe(false);
      expect(isRestoreInProgress()).toBe(false);
      expect(getScheduler().isStopped()).toBe(false); // restarted, not left stopped forever
      // Active DB rolled back to the pre-restore snapshot — data intact, not corrupted.
      expect(memberNames()).toEqual(["Must Survive Swap Failure"]);

      // No DB-sized orphaned.restore-tmp file left on disk (the swapInPlace finally-unlink).
      const dataDir = process.env.DATA_DIR as string;
      const leftovers = fs.readdirSync(dataDir).filter((f) => f.endsWith(".restore-tmp"));
      expect(leftovers).toHaveLength(0);
    } finally {
      await getScheduler().stop();
    }
  });

  it("a renameSync failure during the swap -> typed swap_failed, no tmp orphan, active DB rolled back intact", async () => {
    initScheduler();
    await getScheduler().start();
    try {
      seedMember("active-member", "Must Survive Swap Failure 2");
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
        seedMemberInto(db, "backup-member", "Backup Content (must not land) 2")
      );

      const dataDir = process.env.DATA_DIR as string;
      const dbPath = path.resolve(dataDir, "marplanner.db");
      const realRenameSync = fs.renameSync.bind(fs);
      // Only the FIRST rename targeting the active db path (the forward swap) fails — a rename
      // targeting a DIFFERENT path (e.g. the pre-restore snapshot's own atomic rename inside
      // createSnapshot, which happens EARLIER) must never be affected, and the rollback's own
      // rename-to-dbPath (the second such call) must succeed normally.
      let renamesToDbPath = 0;
      const renameSpy = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          if (String(newPath) === dbPath) {
            renamesToDbPath++;
            if (renamesToDbPath === 1) {
              throw new Error("EIO: rename failed during swap");
            }
          }
          return realRenameSync(oldPath, newPath);
        });

      let result;
      try {
        result = await restoreDatabase({ filename, confirmFilename: filename });
      } finally {
        renameSpy.mockRestore();
      }

      expect(result.status).toBe("swap_failed");
      expect(isQuiesced()).toBe(false);
      expect(isRestoreInProgress()).toBe(false);
      expect(getScheduler().isStopped()).toBe(false);
      expect(memberNames()).toEqual(["Must Survive Swap Failure 2"]);

      const leftovers = fs.readdirSync(dataDir).filter((f) => f.endsWith(".restore-tmp"));
      expect(leftovers).toHaveLength(0);
    } finally {
      await getScheduler().stop();
    }
  });
});

describe("restore engine — rollback double-fault (review P1-2)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    vi.restoreAllMocks();
  });

  it("migration fails AND the rollback swap itself fails -> stays QUIESCED, scheduler stays STOPPED, rollback_failed names the pre-restore file", async () => {
    initScheduler();
    await getScheduler().start();
    const tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), "mp-broken-migrations-p1-2-"));
    try {
      const baseline = REAL_MIGRATION_FILES.slice(0, 2);
      for (const fileName of baseline) {
        fs.copyFileSync(
          path.join(REAL_DRIZZLE_DIR, fileName),
          path.join(tmpMigrationsDir, fileName)
        );
      }
      fs.writeFileSync(path.join(tmpMigrationsDir, "9999_broken.sql"), "NOT VALID SQL AT ALL;;;");

      seedMember("active-member", "Pre-Restore State");
      const filename = seedBackupFixture("snapshot", Date.now(), baseline, [], (db) =>
        seedMemberInto(db, "backup-member", "Backup Content")
      );

      //: the swap step now copies through `storage.ts`'s exported
      // `copyFdToPathSync` rather than a plain `fs.copyFileSync`. The FIRST call (the forward
      // swap) succeeds normally; the SECOND (the rollback's own swap, triggered by the injected
      // migration failure below) fails — a genuine double fault, never a fabricated single one.
      const realCopyFdToPathSync = storageModule.copyFdToPathSync;
      let copyCallCount = 0;
      const copySpy = vi
        .spyOn(storageModule, "copyFdToPathSync")
        .mockImplementation((sourceFd: number, destPath: string) => {
          copyCallCount++;
          if (copyCallCount === 2) {
            throw new Error("ENOSPC: rollback copy also failed");
          }
          return realCopyFdToPathSync(sourceFd, destPath);
        });

      let result;
      try {
        result = await restoreDatabase(
          { filename, confirmFilename: filename },
          { migrationsDir: tmpMigrationsDir }
        );
      } finally {
        copySpy.mockRestore();
      }

      expect(result.status).toBe("rollback_failed");
      if (result.status === "rollback_failed") {
        const preRestoreEntry = listBackups().find((b) => b.type === "pre-restore");
        expect(preRestoreEntry).toBeDefined();
        expect(result.message).toContain(preRestoreEntry?.filename ?? " never-matches");
      }

      // The ONLY safe terminal state: still quiesced, scheduler NOT restarted.
      expect(isQuiesced()).toBe(true);
      expect(getScheduler().isStopped()).toBe(true);
    } finally {
      // Force-clear the deliberately-terminal state so it cannot leak into later tests.
      __resetRestoreStateForTests();
      await getScheduler().stop();
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
    }
  });
});

describe("restore engine — scheduler restart safety (review P1-3/P2-2)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
    vi.restoreAllMocks();
  });

  it("P1-3: a rejecting scheduler.restart() is caught (logged) and never surfaces as an unhandled promise rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    initScheduler();
    getScheduler().registerJob({
      id: "test.wallclock-job",
      trigger: { kind: "wallClock", at: "10:00" },
      action: () => undefined,
    });
    await getScheduler().start();

    // The FIRST call (during start's own arm) succeeds normally; every call AFTER that
    // (specifically restart's re-arm, following the quiesce-timeout abort below) throws —
    // simulating `readHouseholdTimezone` hitting a broken `getDb` handle mid-restart.
    let tzCallCount = 0;
    const tzSpy = vi.spyOn(householdDateModule, "readHouseholdTimezone").mockImplementation(() => {
      tzCallCount++;
      if (tzCallCount > 1) {
        throw new Error("injected: household timezone unavailable during scheduler restart");
      }
      return "Europe/Madrid";
    });

    try {
      // Drive this through the quiesce_timeout ABORT path — the simplest route to
      // `restartSchedulerIfWasStopped(true)` (no DB swap involved at all), isolating this test
      // to ONLY the fire-and-forget `.catch` wiring under review.
      beginRequest();
      const result = await restoreDatabase(
        {
          filename: "snapshot-20260615-120000-000.db",
          confirmFilename: "snapshot-20260615-120000-000.db",
        },
        { drainDeadlineMs: 40, drainPollMs: 10 }
      );
      endRequest();
      expect(result.status).toBe("not_found"); // filename never written — reached before the gate

      // Re-run with a REAL candidate so quiesce_timeout is actually exercised (the not_found
      // above proves nothing about restart — this second call is the real probe).
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
      beginRequest();
      const result2 = await restoreDatabase(
        { filename, confirmFilename: filename },
        { drainDeadlineMs: 40, drainPollMs: 10 }
      );
      endRequest();
      expect(result2.status).toBe("quiesce_timeout");

      // Give the fire-and-forgotten restart.catch a real tick to actually settle/reject.
      await new Promise((resolve) => setTimeout(resolve, 30));

      // The rejection was CAUGHT and logged — never escaped as an unhandled rejection (which
      // would otherwise crash the whole process — ADR-017 violation).
      expect(unhandled).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("scheduler restart"),
        expect.anything()
      );
    } finally {
      tzSpy.mockRestore();
      errorSpy.mockRestore();
      process.off("unhandledRejection", onUnhandledRejection);
      await getScheduler().stop();
    }
  });

  it("P2-2: a scheduler ALREADY stopped before the restore starts is never resurrected (not restarted)", async () => {
    initScheduler();
    await getScheduler().start();
    await getScheduler().stop(); // stopped BEFORE the restore — e.g. a racing process shutdown
    expect(getScheduler().isStopped()).toBe(true);

    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
    const result = await restoreDatabase({ filename, confirmFilename: filename });

    expect(result.status).toBe("restored");
    // This restore did NOT stop the scheduler itself (it was already stopped) — so it must not
    // be the one to bring it back either.
    expect(getScheduler().isStopped()).toBe(true);
  });
});

describe("restore engine — version gate robustness (review P2-3, P2-4)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it("P2-3: an unreadable migrations directory during the gate -> incompatible_backup, never an escaped exception", async () => {
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES);
    const brokenDir = path.join(
      mkdtempSync(path.join(tmpdir(), "mp-missing-migrations-")),
      "does-not-exist"
    );
    // brokenDir's own directory IS created above, but the "does-not-exist" leaf never is —
    // fs.readdirSync(brokenDir) throws ENOENT.

    const result = await restoreDatabase(
      { filename, confirmFilename: filename },
      { migrationsDir: brokenDir }
    );

    expect(result.status).toBe("incompatible_backup");
  });

  it("P2-4: a forged backup sharing the code's exact migrations fileName set but with NO real schema is rolled back, never declared restored", async () => {
    expect(
      getDb()
        .prepare("SELECT state FROM plugin_activation_registry WHERE plugin_id = 'backups'")
        .get()
    ).toEqual({ state: "inactive" });
    initScheduler();
    await getScheduler().start();
    try {
      seedMember("active-member", "Must Survive Forgery");
      const root = resolveBackupsRoot();
      const filename = formatBackupFilename("snapshot", Date.now(), fs.readdirSync(root));
      buildForgedEmptyBackupWithMatchingFileSet(path.join(root, filename), REAL_MIGRATION_FILES);

      const result = await restoreDatabase({ filename, confirmFilename: filename });

      // The version gate alone would have said "equal set, no migration needed" — the post-swap
      // health probe is what catches the forgery and rolls back instead of declaring
      // success.
      expect(result.status).toBe("incompatible_backup");
      expect(memberNames()).toEqual(["Must Survive Forgery"]);
      expect(isQuiesced()).toBe(false);
      expect(getScheduler().isStopped()).toBe(false);

      // A pre-restore snapshot WAS taken (the forgery only gets caught after the swap) and
      // remains on the shelf.
      expect(listBackups().some((b) => b.type === "pre-restore")).toBe(true);
    } finally {
      await getScheduler().stop();
    }
  });
});

describe("restore engine — stale WAL/SHM handling (review P1-5)", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
    vi.restoreAllMocks();
  });

  it("removes any residual -wal/-shm companions before the swap; restored content is never polluted by pre-restore activity (mutations M3-M5)", async () => {
    // A REAL insert via the still-live pre-restore connection — this can genuinely leave real
    // -wal/-shm residue on disk once resetDb closes the connection (SQLite's WAL checkpoint
    // timing is not guaranteed to fire on every close). Deliberately NOT hand-fabricating garbage
    // bytes into these files here: doing so while the pre-restore snapshot step still uses the
    // SAME live connection (step 6 runs BEFORE force-close/step 7) would corrupt that still-open
    // connection's own reads — an artifact of the test, not of the code under test.
    seedMember("active-member", "Pre-Restore");
    const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
      seedMemberInto(db, "backup-member", "From Backup")
    );

    const dataDir = process.env.DATA_DIR as string;
    const dbPath = path.resolve(dataDir, "marplanner.db");
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const walShmUnlinkTargets: string[] = [];
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target: fs.PathLike) => {
      const targetStr = String(target);
      if (targetStr === `${dbPath}-wal` || targetStr === `${dbPath}-shm`) {
        walShmUnlinkTargets.push(targetStr);
      }
      return realUnlinkSync(target);
    });

    let result;
    try {
      result = await restoreDatabase({ filename, confirmFilename: filename });
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(result.status).toBe("restored");
    // removeStaleWalShm genuinely attempted removal of BOTH companions (unconditionally, relying
    // on ENOENT-tolerance for whichever didn't actually exist) — proves the cleanup step runs as
    // part of the sequence, never skipped or reordered past the swap. (A fresh -wal MAY exist
    // again immediately after this assertion — the newly-reopened post-swap connection's own,
    // unrelated to the stale one just removed — so existence is checked mid-sequence via the
    // unlink call itself, not via a post-hoc existsSync.)
    expect(walShmUnlinkTargets).toEqual(expect.arrayContaining([`${dbPath}-wal`, `${dbPath}-shm`]));
    // Content is exactly the backup's — never polluted by the pre-restore active session's own
    // (possibly still-WAL-resident) writes.
    expect(memberNames()).toEqual(["From Backup"]);
  });

  it("a non-ENOENT failure removing a stale WAL companion during the FORWARD swap aborts (rolled back), never silently proceeds", async () => {
    initScheduler();
    await getScheduler().start();
    try {
      seedMember("active-member", "Must Survive WAL-Cleanup Failure");
      const filename = seedBackupFixture("snapshot", Date.now(), REAL_MIGRATION_FILES, [], (db) =>
        seedMemberInto(db, "backup-member", "From Backup (must not land)")
      );

      const dataDir = process.env.DATA_DIR as string;
      const dbPath = path.resolve(dataDir, "marplanner.db");
      const realUnlinkSync = fs.unlinkSync.bind(fs);
      // Only the FIRST unlink attempt on "-wal" (the forward swap's cleanup, step 8) fails — the
      // rollback's own cleanup (the second such call) must succeed normally, so this is a SINGLE
      // failure, not a double fault (that scenario is the NEXT test, targeting the rollback call
      // specifically).
      let dashWalCalls = 0;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target: fs.PathLike) => {
        if (String(target) === `${dbPath}-wal`) {
          dashWalCalls++;
          if (dashWalCalls === 1) {
            const err = new Error("EPERM: operation not permitted, unlink") as Error & {
              code?: string;
            };
            err.code = "EPERM";
            throw err;
          }
          return undefined;
        }
        return realUnlinkSync(target);
      });

      let result;
      try {
        result = await restoreDatabase({ filename, confirmFilename: filename });
      } finally {
        unlinkSpy.mockRestore();
      }

      // Caught by the swap-step try/catch (removeStaleWalShm is step 8, inside that block).
      expect(result.status).toBe("swap_failed");
      expect(memberNames()).toEqual(["Must Survive WAL-Cleanup Failure"]);
      expect(isQuiesced()).toBe(false);
      expect(getScheduler().isStopped()).toBe(false);
    } finally {
      await getScheduler().stop();
    }
  });

  it("a non-ENOENT WAL-cleanup failure during ROLLBACK triggers the P1-2 double fault (stays quiesced)", async () => {
    initScheduler();
    await getScheduler().start();
    const tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), "mp-broken-migrations-p1-5-"));
    try {
      const baseline = REAL_MIGRATION_FILES.slice(0, 2);
      for (const fileName of baseline) {
        fs.copyFileSync(
          path.join(REAL_DRIZZLE_DIR, fileName),
          path.join(tmpMigrationsDir, fileName)
        );
      }
      fs.writeFileSync(path.join(tmpMigrationsDir, "9999_broken.sql"), "NOT VALID SQL AT ALL;;;");

      seedMember("active-member", "Pre-Restore State 2");
      const filename = seedBackupFixture("snapshot", Date.now(), baseline, [], (db) =>
        seedMemberInto(db, "backup-member", "Backup Content 2")
      );

      const dataDir = process.env.DATA_DIR as string;
      const dbPath = path.resolve(dataDir, "marplanner.db");
      const realUnlinkSync = fs.unlinkSync.bind(fs);
      // The FIRST unlink attempt on "-wal" (the forward swap's cleanup, step 8) is a harmless
      // no-op (nothing real to remove — equivalent to the ordinary ENOENT-tolerated case). The
      // SECOND (the rollback's own cleanup, triggered by the injected migration failure below)
      // throws — a genuine double fault targeting the ROLLBACK path specifically, distinct from
      // the FORWARD-path test above.
      let dashWalCalls = 0;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target: fs.PathLike) => {
        if (String(target) === `${dbPath}-wal`) {
          dashWalCalls++;
          if (dashWalCalls === 2) {
            const err = new Error("EIO") as Error & { code?: string };
            err.code = "EIO";
            throw err;
          }
          return undefined;
        }
        return realUnlinkSync(target);
      });

      let result;
      try {
        result = await restoreDatabase(
          { filename, confirmFilename: filename },
          { migrationsDir: tmpMigrationsDir }
        );
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(result.status).toBe("rollback_failed");
      expect(isQuiesced()).toBe(true);
      expect(getScheduler().isStopped()).toBe(true);
    } finally {
      __resetRestoreStateForTests();
      await getScheduler().stop();
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
    }
  });
});

describe("restore with detached calendar synchronization", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => {
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("drains detached work or aborts safely (timeout=%s, failure=%s)", async (timeout, failure) => {
    getDb()
      .prepare(
        "INSERT INTO calendar_external_sources (id,name,provider,feed_url,created_at,updated_at) VALUES ('pending','Source','ics_generic','https://calendar.example.test/feed',1,1), ('blocked','Other','ics_generic','https://calendar.example.test/other',1,1)"
      )
      .run();
    const snapshot = await createSnapshot("snapshot");
    if (!snapshot.ok) throw new Error(snapshot.error);
    let release!: (body: string) => void;
    let entered!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = vi.fn(async () => {
      entered();
      const body = await pending;
      if (failure) throw new Error("synthetic fetch failure");
      return body;
    });
    const dependencies = { lookup: async () => [{ address: "8.8.8.8", family: 4 }], transport };
    const active = startExternalSourceSynchronization("pending", dependencies);
    await started;
    let settled = false;
    const restoring = restoreDatabase(
      { filename: snapshot.filename, confirmFilename: snapshot.filename },
      { drainDeadlineMs: timeout ? 40 : 2000, drainPollMs: 1 }
    ).then((result) => {
      settled = true;
      return result;
    });
    const body =
      "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:before-restore\nDTSTAMP:20260929T000000Z\nDTSTART;VALUE=DATE:20260930\nSUMMARY:Before restore\nEND:VEVENT\nEND:VCALENDAR";
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      await startExternalSourceSynchronization("blocked", dependencies);
      expect(transport).toHaveBeenCalledTimes(1);
      if (timeout) {
        expect((await restoring).status).toBe("quiesce_timeout");
        expect(isQuiesced()).toBe(false);
      }
      release(body);
      await active;
      expect((await restoring).status).toBe(timeout ? "quiesce_timeout" : "restored");
      expect(getDb().prepare("SELECT title FROM calendar_events").all()).toEqual(
        timeout && !failure ? [{ title: "Before restore" }] : []
      );
      expect(
        (
          getDb()
            .prepare(
              "SELECT consecutive_failures AS failures FROM calendar_external_sources WHERE id = 'pending'"
            )
            .get() as { failures: number }
        ).failures
      ).toBe(timeout && failure ? 1 : 0);
    } finally {
      release(body);
      await active;
      await restoring;
    }
  });
});
