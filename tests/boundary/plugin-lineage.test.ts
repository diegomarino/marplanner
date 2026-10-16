import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";

const FROZEN_NOW_MS = Date.parse("2026-09-27T10:15:30.000Z");
const FROZEN_NOW_ISO = "2026-09-27T10:15:30.000Z";
const LATER_NOW_MS = Date.parse("2026-09-28T11:16:31.000Z");
const BASELINE_FILE = "0000_baseline.sql";
const PRE_SQUASH_LEDGER = [
  "0000_current_baseline.sql",
  "0001_calendar_feed_sync.sql",
  "0002_plugin_lifecycle.sql",
  "0003_calendar_event_details.sql",
  "0004_member_palette.sql",
  "0005_daily_briefing_schedule.sql",
];

const PLUGIN_IDS = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
] as const;

const TEMP_CONTEXT_PROBE_SQL = `
CREATE TABLE lineage_probe (
  kind TEXT NOT NULL,
  pre_run_migration_files TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
INSERT INTO lineage_probe (kind, pre_run_migration_files, captured_at)
SELECT kind, pre_run_migration_files, captured_at
FROM temp.plugin_lifecycle_migration_context;
`;

function writeMigration(directory: string, fileName: string, sql: string): void {
  fs.writeFileSync(path.join(directory, fileName), sql, "utf8");
}

function writeLifecycleFixture(directory: string): void {
  writeMigration(
    directory,
    BASELINE_FILE,
    fs.readFileSync(path.resolve(process.cwd(), "drizzle", BASELINE_FILE), "utf8")
  );
}

function seedMigrationJournal(fileNames: readonly string[]): void {
  const db = getDb();
  db.exec(
    "CREATE TABLE drizzle_universe_migrations (fileName TEXT PRIMARY KEY NOT NULL, appliedAt INTEGER NOT NULL)"
  );
  const insert = db.prepare(
    "INSERT INTO drizzle_universe_migrations (fileName, appliedAt) VALUES (?, ?)"
  );
  for (const [index, fileName] of fileNames.entries()) {
    insert.run(fileName, FROZEN_NOW_MS + index);
  }
}

function lifecycleTableNames(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'installation_lineage',
             'plugin_activation_registry',
             'plugin_lifecycle_operations',
             'plugin_migration_journal'
           )
         ORDER BY name`
      )
      .all() as { name: string }[]
  ).map(({ name }) => name);
}

function expectNoTemporaryContext(): void {
  const rows = getDb()
    .prepare(
      "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'plugin_lifecycle_migration_context'"
    )
    .all();
  expect(rows).toEqual([]);
}

function registryRows(): { pluginId: string; state: string; updatedAt: string }[] {
  return getDb()
    .prepare(
      `SELECT plugin_id AS pluginId, state, updated_at AS updatedAt
       FROM plugin_activation_registry
       ORDER BY rowid`
    )
    .all() as { pluginId: string; state: string; updatedAt: string }[];
}

describe("plugin lifecycle migration lineage", () => {
  let dataDir: string;
  let migrationsDir: string;
  let previousDataDir: string | undefined;
  let previousBackupsRoot: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lineage-data-"));
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lineage-sql-"));
    previousDataDir = process.env.DATA_DIR;
    previousBackupsRoot = process.env.BACKUPS_ROOT;
    process.env.DATA_DIR = dataDir;
    // Snapshots must land under dataDir so the no-snapshot assertions can see them.
    delete process.env.BACKUPS_ROOT;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    process.env.DATA_DIR = previousDataDir;
    if (previousBackupsRoot === undefined) delete process.env.BACKUPS_ROOT;
    else process.env.BACKUPS_ROOT = previousBackupsRoot;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  describe("temporary migration context handoff", () => {
    it("is visible to migration SQL on the same connection and is removed after commit", () => {
      writeMigration(migrationsDir, BASELINE_FILE, TEMP_CONTEXT_PROBE_SQL);

      runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS });

      expect(getDb().prepare("SELECT * FROM lineage_probe").all()).toEqual([
        {
          kind: "fresh",
          pre_run_migration_files: "[]",
          captured_at: FROZEN_NOW_ISO,
        },
      ]);
      expectNoTemporaryContext();
    });

    it("keeps context-derived writes and migration bookkeeping inside the atomic rollback", () => {
      writeMigration(
        migrationsDir,
        BASELINE_FILE,
        `${TEMP_CONTEXT_PROBE_SQL}
         CREATE TABLE probe_parent (id INTEGER PRIMARY KEY);
         CREATE TABLE probe_child (
           id INTEGER PRIMARY KEY,
           parent_id INTEGER NOT NULL REFERENCES probe_parent(id)
         );
         INSERT INTO probe_child (id, parent_id) VALUES (1, 999);`
      );

      expect(() => runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS })).toThrow(
        /foreign key violation/
      );

      expect(
        getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'lineage_probe'").all()
      ).toEqual([]);
      expect(
        getDb()
          .prepare("SELECT fileName FROM drizzle_universe_migrations WHERE fileName = ?")
          .all(BASELINE_FILE)
      ).toEqual([]);
      expectNoTemporaryContext();
    });
  });

  it("classifies an empty pre-run journal as fresh and seeds exactly nine inactive plugins", () => {
    writeLifecycleFixture(migrationsDir);

    runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS });

    expect(getDb().prepare("SELECT * FROM installation_lineage").all()).toEqual([
      {
        singleton_id: 1,
        kind: "fresh",
        pre_run_migration_files: "[]",
        captured_at: FROZEN_NOW_ISO,
      },
    ]);
    expect(registryRows()).toEqual(
      PLUGIN_IDS.map((pluginId) => ({
        pluginId,
        state: "inactive",
        updatedAt: FROZEN_NOW_ISO,
      }))
    );
    expect(lifecycleTableNames()).toEqual([
      "installation_lineage",
      "plugin_activation_registry",
      "plugin_lifecycle_operations",
      "plugin_migration_journal",
    ]);
    expectNoTemporaryContext();
  });

  it("enforces the closed registry, durable operation, and plugin journal invariants", () => {
    writeLifecycleFixture(migrationsDir);
    runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS });
    const db = getDb();

    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_activation_registry
           (plugin_id, state, activated_at, updated_at, error_code, error_message)
           VALUES ('external-calendar-sync', 'inactive', NULL, ?, NULL, NULL)`
        )
        .run(FROZEN_NOW_ISO)
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE plugin_activation_registry
           SET state = 'errored', error_code = 'migration_failed', error_message = NULL
           WHERE plugin_id = 'daily-briefing'`
        )
        .run()
    ).toThrow();

    db.prepare(
      `INSERT INTO plugin_lifecycle_operations
       (operation_id, plugin_id, target_state, phase, started_at, updated_at)
       VALUES ('operation-1', 'daily-briefing', 'active', 'running-migrations', ?, ?)`
    ).run(FROZEN_NOW_ISO, FROZEN_NOW_ISO);
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_lifecycle_operations
           (operation_id, plugin_id, target_state, phase, started_at, updated_at)
           VALUES ('operation-2', 'daily-briefing', 'inactive', 'draining', ?, ?)`
        )
        .run(FROZEN_NOW_ISO, FROZEN_NOW_ISO)
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_lifecycle_operations
           (operation_id, plugin_id, target_state, phase, started_at, updated_at)
           VALUES ('operation-3', 'printing', 'active', 'draining', ?, ?)`
        )
        .run(FROZEN_NOW_ISO, FROZEN_NOW_ISO)
    ).toThrow();

    db.prepare(
      `INSERT INTO plugin_migration_journal (plugin_id, migration_id, applied_at)
       VALUES ('daily-briefing', 'baseline', ?)`
    ).run(FROZEN_NOW_ISO);
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_migration_journal (plugin_id, migration_id, applied_at)
           VALUES ('daily-briefing', 'baseline', ?)`
        )
        .run(FROZEN_NOW_ISO)
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_migration_journal (plugin_id, migration_id, applied_at)
           VALUES ('printing', '   ', ?)`
        )
        .run(FROZEN_NOW_ISO)
    ).toThrow();
  });

  it("rejects non-canonical timestamps in every lifecycle timestamp column", () => {
    writeLifecycleFixture(migrationsDir);
    runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS });
    const db = getDb();

    expect(() =>
      db.prepare("UPDATE installation_lineage SET captured_at = '2026-02-30T10:15:30.000Z'").run()
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE plugin_activation_registry
           SET activated_at = '0'
           WHERE plugin_id = 'daily-briefing'`
        )
        .run()
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE plugin_activation_registry
           SET updated_at = '0'
           WHERE plugin_id = 'daily-briefing'`
        )
        .run()
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_lifecycle_operations
           (operation_id, plugin_id, target_state, phase, started_at, updated_at)
           VALUES ('invalid-started-at', 'daily-briefing', 'active', 'running-migrations', '0', ?)`
        )
        .run(FROZEN_NOW_ISO)
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_lifecycle_operations
           (operation_id, plugin_id, target_state, phase, started_at, updated_at)
           VALUES ('invalid-updated-at', 'printing', 'active', 'running-migrations', ?, '0')`
        )
        .run(FROZEN_NOW_ISO)
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugin_migration_journal (plugin_id, migration_id, applied_at)
           VALUES ('weather', 'invalid-applied-at', '0')`
        )
        .run()
    ).toThrow();
  });

  it.each([
    ["unknown-only", ["0099_unknown.sql"]],
    ["pre-squash", PRE_SQUASH_LEDGER],
  ])(
    "fails closed before any snapshot or mutation for unsupported %s history",
    (_name, history) => {
      writeLifecycleFixture(migrationsDir);
      seedMigrationJournal(history);

      expect(() => runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS })).toThrow(
        "Unsupported migration history."
      );

      expect(lifecycleTableNames()).toEqual([]);
      expect(
        (
          getDb()
            .prepare("SELECT fileName FROM drizzle_universe_migrations ORDER BY fileName")
            .all() as { fileName: string }[]
        ).map(({ fileName }) => fileName)
      ).toEqual([...history].sort());
      expect(fs.existsSync(path.join(dataDir, "backups", "pre-migration"))).toBe(false);
      expectNoTemporaryContext();
    }
  );

  it("refuses a ledger with a migration this build does not know, even with nothing pending", () => {
    writeLifecycleFixture(migrationsDir);
    runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS });
    // A newer build opened this database and recorded a migration this one has never seen.
    getDb()
      .prepare("INSERT INTO drizzle_universe_migrations (fileName, appliedAt) VALUES (?, ?)")
      .run("0001_from_a_newer_build.sql", FROZEN_NOW_MS);

    expect(() => runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS })).toThrow(
      "Unsupported migration history."
    );
  });

  it("refuses to lay the baseline under a ledger that already records a later migration", () => {
    writeLifecycleFixture(migrationsDir);
    // A later migration this build does ship, recorded without the baseline beneath it.
    fs.writeFileSync(path.join(migrationsDir, "0001_later.sql"), "SELECT 1;", "utf8");
    seedMigrationJournal(["0001_later.sql"]);

    expect(() => runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS })).toThrow(
      "Unsupported migration history."
    );
    expect(lifecycleTableNames()).toEqual([]);
  });

  it("fails closed when the journal claims the baseline without its durable lifecycle metadata", () => {
    writeLifecycleFixture(migrationsDir);
    seedMigrationJournal([BASELINE_FILE]);

    expect(() => runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS })).toThrow(
      "Incomplete plugin lifecycle migration history."
    );

    expect(lifecycleTableNames()).toEqual([]);
    expect(
      getDb().prepare("SELECT fileName FROM drizzle_universe_migrations ORDER BY fileName").all()
    ).toEqual([{ fileName: BASELINE_FILE }]);
    expectNoTemporaryContext();
  });

  it("does not reclassify or reseed an already-migrated database after repeat and restart", () => {
    writeLifecycleFixture(migrationsDir);
    runMigrations(migrationsDir, { now: () => FROZEN_NOW_MS });

    const changedAt = "2026-09-27T12:00:00.000Z";
    getDb()
      .prepare(
        `UPDATE plugin_activation_registry
         SET state = ?, activated_at = ?, updated_at = ?
         WHERE plugin_id = 'daily-briefing'`
      )
      .run("active", changedAt, changedAt);

    runMigrations(migrationsDir, { now: () => LATER_NOW_MS });
    resetDb();
    runMigrations(migrationsDir, { now: () => LATER_NOW_MS });

    expect(getDb().prepare("SELECT * FROM installation_lineage").get()).toMatchObject({
      kind: "fresh",
      captured_at: FROZEN_NOW_ISO,
    });
    expect(
      getDb()
        .prepare(
          `SELECT state, activated_at AS activatedAt, updated_at AS updatedAt
           FROM plugin_activation_registry
           WHERE plugin_id = 'daily-briefing'`
        )
        .get()
    ).toEqual({
      state: "active",
      activatedAt: changedAt,
      updatedAt: changedAt,
    });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM plugin_activation_registry WHERE state = ?")
        .get("inactive")
    ).toEqual({ count: 8 });
    expectNoTemporaryContext();
  });
});
