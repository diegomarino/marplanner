import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/server/app.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { __resetRestoreStateForTests, restoreDatabase } from "../../src/server/backups/restore.js";
import {
  __resetBackupsStateForTests,
  resolveBackupsRoot,
} from "../../src/server/backups/storage.js";
import { getDb, resetDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ensurePluginSettingsDefaults } from "../../src/server/modules/settings/index.js";
import { createPluginLifecycle } from "../../src/server/plugins/lifecycle.js";
import { PLUGIN_MANIFESTS } from "../../src/server/plugins/manifest.js";
import {
  createPluginRuntimeAdapter,
  createServerPluginRuntime,
} from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import {
  configurePluginJobLifecycleGate,
  createScheduler,
} from "../../src/server/scheduler/index.js";
import { PLUGIN_IDS, type PluginId, type PluginState } from "../../src/shared/plugins.js";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/plugin-lifecycle");
const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");
const BASELINE_FILE = "0000_current_baseline.sql";
const CALENDAR_FEED_SYNC_FILE = "0001_calendar_feed_sync.sql";
const LIFECYCLE_FILE = "0002_plugin_lifecycle.sql";
const FROZEN_NOW = "2026-09-27T10:15:30.000Z";
const FROZEN_NOW_MS = Date.parse(FROZEN_NOW);
const DEVICE_KEY = "plugin-compatibility-device";

const CORE_AND_DEFERRED_IDS = [
  "members",
  "auth-sessions",
  "app-settings",
  "kiosk-shell",
  "calendar",
  "day-periods",
  "routines-chores",
  "i18n",
  "external-calendar-sync",
] as const;
const FORBIDDEN_REGISTRY_IDS: ReadonlySet<string> = new Set(CORE_AND_DEFERRED_IDS);

interface RegistryRow {
  readonly pluginId: string;
  readonly state: PluginState;
  readonly activatedAt: string | null;
  readonly updatedAt: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

interface LineageRow {
  readonly singletonId: number;
  readonly kind: "fresh" | "prior_baseline";
  readonly preRunMigrationFiles: string;
  readonly capturedAt: string;
}

function fixtureSql(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, `${name}.sql`), "utf8");
}

function applyFixture(name: string, db: InstanceType<typeof Database> = getDb()): void {
  db.exec(fixtureSql(name));
}

function registryRows(): RegistryRow[] {
  return getDb()
    .prepare(
      `SELECT plugin_id AS pluginId,
              state,
              activated_at AS activatedAt,
              updated_at AS updatedAt,
              error_code AS errorCode,
              error_message AS errorMessage
       FROM plugin_activation_registry
       ORDER BY rowid`
    )
    .all() as RegistryRow[];
}

function exactSeedRows(state: PluginState, updatedAt = FROZEN_NOW): RegistryRow[] {
  return PLUGIN_IDS.map((pluginId) => ({
    pluginId,
    state,
    activatedAt: null,
    updatedAt,
    errorCode: null,
    errorMessage: null,
  }));
}

function exactRowsWith(
  defaultState: PluginState,
  overrides: Readonly<Partial<Record<PluginId, Partial<RegistryRow>>>>
): RegistryRow[] {
  return exactSeedRows(defaultState).map((row) => ({
    ...row,
    ...overrides[row.pluginId as PluginId],
  }));
}

function expectClosedRegistry(rows: readonly RegistryRow[]): void {
  expect(rows).toHaveLength(9);
  expect(rows.map(({ pluginId }) => pluginId)).toEqual(PLUGIN_IDS);
  expect(rows.some(({ pluginId }) => FORBIDDEN_REGISTRY_IDS.has(pluginId))).toBe(false);
}

function lineage(): LineageRow {
  return getDb()
    .prepare(
      `SELECT singleton_id AS singletonId,
              kind,
              pre_run_migration_files AS preRunMigrationFiles,
              captured_at AS capturedAt
       FROM installation_lineage`
    )
    .get() as LineageRow;
}

function lifecycleTableNames(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'installation_lineage',
             'plugin_activation_registry',
             'plugin_lifecycle_operations',
             'plugin_migration_journal'
           )
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function seedDeviceKey(): void {
  getDb()
    .prepare(
      `INSERT INTO api_keys (id, key_hash, scope, kind, created_at)
       VALUES ('plugin-compatibility-key', ?, '*', 'device', ?)`
    )
    .run(hashKey(DEVICE_KEY), FROZEN_NOW_MS);
}

function runtime() {
  return createServerPluginRuntime({
    store: new SqlitePluginLifecycleStore(() => getDb()),
    now: () => FROZEN_NOW,
    operationId: (pluginId) => `compatibility-${pluginId}`,
    drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
  });
}

function createJournal(db: InstanceType<typeof Database>): void {
  db.exec(
    `CREATE TABLE drizzle_universe_migrations (
       fileName TEXT PRIMARY KEY NOT NULL,
       appliedAt INTEGER NOT NULL
     )`
  );
}

function recordMigration(db: InstanceType<typeof Database>, fileName: string): void {
  db.prepare("INSERT INTO drizzle_universe_migrations (fileName, appliedAt) VALUES (?, ?)").run(
    fileName,
    FROZEN_NOW_MS
  );
}

function applyRealMigration(db: InstanceType<typeof Database>, fileName: string): void {
  db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8"));
}

function preparePriorBaseline(): void {
  applyRealMigration(getDb(), BASELINE_FILE);
  applyFixture("prior-baseline");
}

function buildBackupFixture(
  dbPath: string,
  state: "prior-baseline" | "migrated-prior",
  options: { readonly interruptedDeactivation?: boolean } = {}
): void {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    applyRealMigration(db, BASELINE_FILE);
    createJournal(db);
    recordMigration(db, BASELINE_FILE);
    if (state === "migrated-prior") {
      applyRealMigration(db, CALENDAR_FEED_SYNC_FILE);
      recordMigration(db, CALENDAR_FEED_SYNC_FILE);
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
      ).run(JSON.stringify([BASELINE_FILE]), FROZEN_NOW);
      applyRealMigration(db, LIFECYCLE_FILE);
      db.exec("DROP TABLE temp.plugin_lifecycle_migration_context");
      recordMigration(db, LIFECYCLE_FILE);
      applyFixture("migrated-prior", db);
      if (options.interruptedDeactivation) {
        db.prepare(
          `INSERT INTO plugin_lifecycle_operations
             (operation_id, plugin_id, target_state, phase, started_at, updated_at)
           VALUES ('restored-printing-deactivation', 'printing', 'inactive', 'unmounting', ?, ?)`
        ).run(FROZEN_NOW, FROZEN_NOW);
        db.prepare(
          `INSERT INTO api_keys (id, key_hash, scope, kind, created_at)
           VALUES ('plugin-compatibility-key', ?, '*', 'device', ?)`
        ).run(hashKey(DEVICE_KEY), FROZEN_NOW_MS);
      }
    }
  } finally {
    db.close();
  }
}

function createBackupPath(filename: string): string {
  return path.join(resolveBackupsRoot(), filename);
}

describe("plugin lifecycle compatibility matrix (Slice 026 T014)", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-compatibility-"));
    previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    __resetBackupsStateForTests();
    __resetRestoreStateForTests();
    process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("fresh-empty: records immutable fresh lineage and exactly nine inactive rows without inference", async () => {
    applyFixture("fresh-empty");
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });

    expect(lineage()).toEqual({
      singletonId: 1,
      kind: "fresh",
      preRunMigrationFiles: "[]",
      capturedAt: FROZEN_NOW,
    });
    expect(registryRows()).toEqual(exactSeedRows("inactive"));
    expectClosedRegistry(registryRows());

    getDb()
      .prepare(
        `INSERT INTO settings_objects (object_name, data, updated_at)
         VALUES ('weather', '{"lat":40.4168,"lon":-3.7038}', ?)`
      )
      .run(FROZEN_NOW_MS);
    const app = await buildApp();
    try {
      expect(registryRows()).toEqual(exactSeedRows("inactive"));
    } finally {
      await app.close();
    }
  });

  it("prior-baseline: uses only the recognized pre-run journal to seed nine active rows", () => {
    preparePriorBaseline();
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });

    expect(lineage()).toEqual({
      singletonId: 1,
      kind: "prior_baseline",
      preRunMigrationFiles: `["${BASELINE_FILE}"]`,
      capturedAt: FROZEN_NOW,
    });
    expect(registryRows()).toEqual(exactSeedRows("active"));
    expectClosedRegistry(registryRows());
  });

  it("unsupported-history: fails closed before writing any lifecycle metadata", () => {
    applyFixture("unsupported-history");

    expect(() => runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS })).toThrow(
      "Unsupported pre-lifecycle migration history."
    );
    expect(lifecycleTableNames()).toEqual([]);
    expect(getDb().prepare("SELECT fileName FROM drizzle_universe_migrations").all()).toEqual([
      { fileName: "0099_unknown_history.sql" },
    ]);
  });

  it.each([
    ["migrated-fresh", "fresh", "inactive"],
    ["migrated-prior", "prior_baseline", "active"],
  ] as const)(
    "%s: restart preserves immutable lineage, explicit registry state, journals, settings, and owned data",
    (fixture, expectedLineage, defaultState) => {
      if (expectedLineage === "prior_baseline") preparePriorBaseline();
      runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
      applyFixture(fixture);

      const beforeLineage = lineage();
      const beforeRows = registryRows();
      const beforeSettings = getDb()
        .prepare("SELECT * FROM settings_objects WHERE object_name = 'weather'")
        .all();
      const beforeJournal = getDb().prepare("SELECT * FROM plugin_migration_journal").all();
      const beforeOwnedData = getDb().prepare("SELECT * FROM daily_messages").all();
      const expectedRows = exactRowsWith(defaultState, {
        weather:
          fixture === "migrated-fresh"
            ? {
                state: "active",
                activatedAt: "2026-09-27T12:00:00.000Z",
                updatedAt: "2026-09-27T12:00:00.000Z",
              }
            : {
                state: "inactive",
                activatedAt: "2026-09-27T11:30:00.000Z",
                updatedAt: "2026-09-27T12:00:00.000Z",
              },
      });

      expect(beforeRows).toEqual(expectedRows);

      resetDb();
      runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS + 86_400_000 });

      expect(lineage()).toEqual(beforeLineage);
      expect(registryRows()).toEqual(expectedRows);
      expectClosedRegistry(registryRows());
      expect(registryRows().filter(({ state }) => state === defaultState)).toHaveLength(8);
      expect(beforeRows.find(({ pluginId }) => pluginId === "weather")?.state).not.toBe(
        defaultState
      );
      expect(
        getDb().prepare("SELECT * FROM settings_objects WHERE object_name = 'weather'").all()
      ).toEqual(beforeSettings);
      expect(getDb().prepare("SELECT * FROM plugin_migration_journal").all()).toEqual(
        beforeJournal
      );
      expect(getDb().prepare("SELECT * FROM daily_messages").all()).toEqual(beforeOwnedData);
    }
  );

  it("restored-prior-baseline: real restore migrates the restored journal and seeds nine active rows", async () => {
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
    const filename = "snapshot-20260927-101530-000.db";
    buildBackupFixture(createBackupPath(filename), "prior-baseline");

    const result = await restoreDatabase(
      { filename, confirmFilename: filename },
      { migrationsDir: MIGRATIONS_DIR }
    );

    expect(result).toMatchObject({ status: "restored", migrated: true });
    expect(lineage()).toMatchObject({
      singletonId: 1,
      kind: "prior_baseline",
      preRunMigrationFiles: `["${BASELINE_FILE}"]`,
    });
    expect(registryRows().map(({ pluginId, state }) => ({ pluginId, state }))).toEqual(
      PLUGIN_IDS.map((pluginId) => ({ pluginId, state: "active" }))
    );
    expectClosedRegistry(registryRows());
  });

  it("restored-migrated: a live app reconciles restored canonical state and durable work before first traffic", async () => {
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
    seedDeviceKey();
    const liveRuntime = runtime();
    const app = await buildApp({ pluginLifecycle: liveRuntime.lifecycle });
    const filename = "snapshot-20260927-101531-000.db";
    buildBackupFixture(createBackupPath(filename), "migrated-prior", {
      interruptedDeactivation: true,
    });

    try {
      const result = await restoreDatabase(
        { filename, confirmFilename: filename },
        { migrationsDir: MIGRATIONS_DIR },
        liveRuntime.lifecycle
      );

      expect(result).toMatchObject({ status: "restored", migrated: false });
      expect(lineage()).toEqual({
        singletonId: 1,
        kind: "prior_baseline",
        preRunMigrationFiles: `["${BASELINE_FILE}"]`,
        capturedAt: FROZEN_NOW,
      });

      // The restore response unquiesces the existing app. Durable lifecycle work and runtime
      // contributions must therefore already reflect the restored database before any request.
      const restoredStore = new SqlitePluginLifecycleStore(getDb());
      expect(restoredStore.getOperation("printing")).toBeNull();
      expect(registryRows()).toEqual(
        exactRowsWith("active", {
          printing: { state: "inactive" },
          weather: {
            state: "inactive",
            activatedAt: "2026-09-27T11:30:00.000Z",
            updatedAt: "2026-09-27T12:00:00.000Z",
          },
        })
      );
      expect(liveRuntime.isContributionActive("printing")).toBe(false);
      expect(liveRuntime.isContributionActive("weather")).toBe(false);
      expect(liveRuntime.isContributionActive("daily-messages")).toBe(true);

      const target = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(target.statusCode).toBe(503);
      const sibling = await app.inject({
        method: "GET",
        url: "/api/daily-messages/current?memberId=fixture-member&date=2026-09-27",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(sibling.statusCode).toBe(200);
      expect(sibling.json()).toMatchObject({
        id: "fixture-message",
        text: "Synthetic retained data",
      });
      expect(
        getDb().prepare("SELECT COUNT(*) AS count FROM plugin_migration_journal").get()
      ).toEqual({ count: 1 });
      expectClosedRegistry(registryRows());
    } finally {
      await app.close();
    }
  });

  it("interrupted-activation: startup settles safe error before API traffic and preserves siblings", async () => {
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
    seedDeviceKey();
    getDb()
      .prepare(
        `UPDATE plugin_activation_registry
         SET state = 'active', activated_at = ?, updated_at = ?
         WHERE plugin_id = 'daily-briefing'`
      )
      .run(FROZEN_NOW, FROZEN_NOW);
    new SqlitePluginLifecycleStore(getDb()).begin(
      "weather",
      "interrupted-weather-activation",
      "active",
      "mounting",
      FROZEN_NOW
    );

    const app = await buildApp({ pluginLifecycle: runtime().lifecycle });
    try {
      expect(new SqlitePluginLifecycleStore(getDb()).getOperation("weather")).toBeNull();
      expect(registryRows()).toEqual(
        exactRowsWith("inactive", {
          "daily-briefing": { state: "active", activatedAt: FROZEN_NOW },
          weather: {
            state: "errored",
            errorCode: "reconciliation_failed",
            errorMessage: "Plugin recovery requires attention.",
          },
        })
      );

      const catalog = await app.inject({
        method: "GET",
        url: "/api/plugins",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(catalog.statusCode).toBe(200);
      expect(
        catalog.json().plugins.find(({ id }: { id: string }) => id === "weather")
      ).toMatchObject({
        state: "errored",
        health: { status: "attention", code: "reconciliation_failed" },
      });
      const withdrawnRoute = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(withdrawnRoute.statusCode).toBe(503);
      expect(withdrawnRoute.json()).toEqual({
        code: "plugin_unavailable",
        message: "This plugin is unavailable.",
      });
      const siblingRoute = await app.inject({
        method: "GET",
        url: "/api/daily-briefing/opt-in",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(siblingRoute.statusCode).toBe(200);
      expect(siblingRoute.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("interrupted-deactivation: startup drains to inactive before API traffic and keeps an active sibling", async () => {
    preparePriorBaseline();
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
    seedDeviceKey();
    new SqlitePluginLifecycleStore(getDb()).begin(
      "printing",
      "interrupted-printing-deactivation",
      "inactive",
      "unmounting",
      FROZEN_NOW
    );

    const app = await buildApp({ pluginLifecycle: runtime().lifecycle });
    try {
      expect(new SqlitePluginLifecycleStore(getDb()).getOperation("printing")).toBeNull();
      expect(registryRows()).toEqual(exactRowsWith("active", { printing: { state: "inactive" } }));

      const response = await app.inject({
        method: "GET",
        url: "/api/plugins",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(response.statusCode).toBe(200);
      const plugins = response.json().plugins as Array<{ id: PluginId; state: PluginState }>;
      expect(plugins.map(({ id }) => id)).toEqual(PLUGIN_IDS);
      expect(plugins.find(({ id }) => id === "printing")?.state).toBe("inactive");
      expect(plugins.find(({ id }) => id === "weather")?.state).toBe("active");
      const withdrawnTarget = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(withdrawnTarget.statusCode).toBe(503);
      const siblingRoute = await app.inject({
        method: "GET",
        url: "/api/time-announcements",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(siblingRoute.statusCode).toBe(200);
      expect(siblingRoute.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("repeat-cycle: real lifecycle requests do not duplicate defaults, journals, routes, jobs, UI contributions, or owned data", async () => {
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
    getDb().exec(
      `INSERT INTO members
         (id, display_name, color_key, role, lifecycle, created_at, updated_at)
       VALUES
         ('fixture-member', 'Synthetic Member', 'blue', 'parent', 'active', 1790510400000, 1790510400000);
       INSERT INTO daily_messages
         (id, member_id, date, text, created_at, updated_at)
       VALUES
         ('fixture-message', 'fixture-member', '2026-09-27', 'Synthetic retained data', 1790510400000, 1790510400000);`
    );
    seedDeviceKey();
    const serverRuntime = runtime();
    await serverRuntime.lifecycle.reconcileAll();
    const app = await buildApp({ pluginLifecycle: serverRuntime.lifecycle });
    let networkJobEffects = 0;
    const scheduler = createScheduler({ now: () => FROZEN_NOW_MS });
    scheduler.registerJob({
      id: "network-devices.poll",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: () => {
        networkJobEffects += 1;
        return networkJobEffects;
      },
    });
    try {
      const routesBefore = app.printRoutes({ commonPrefix: false });
      const settingsBefore = getDb()
        .prepare(
          "SELECT object_name AS objectName, data, updated_at AS updatedAt FROM settings_objects WHERE object_name IN ('weather', 'printer', 'printerTransport') ORDER BY object_name"
        )
        .all();
      const journalBefore = getDb()
        .prepare(
          "SELECT plugin_id AS pluginId, migration_id AS migrationId, applied_at AS appliedAt FROM plugin_migration_journal ORDER BY plugin_id, migration_id"
        )
        .all();
      const ownedDataBefore = getDb().prepare("SELECT * FROM daily_messages").all();

      expect(settingsBefore).toEqual([]);
      expect(journalBefore).toEqual([]);
      expect(await scheduler.runJobNow("network-devices.poll")).toEqual({
        status: "already_running",
      });
      expect(networkJobEffects).toBe(0);

      await serverRuntime.lifecycle.activate("weather");
      await serverRuntime.lifecycle.activate("weather");
      expect(
        getDb()
          .prepare(
            "SELECT object_name AS objectName, data, updated_at AS updatedAt FROM settings_objects WHERE object_name = 'weather'"
          )
          .all()
      ).toEqual([
        { objectName: "weather", data: '{"lat":null,"lon":null}', updatedAt: FROZEN_NOW_MS },
      ]);
      getDb()
        .prepare("UPDATE settings_objects SET data = ? WHERE object_name = 'weather'")
        .run('{"lat":40.4168,"lon":-3.7038,"label":"Retained cycle value"}');
      await serverRuntime.lifecycle.deactivate("weather");
      await serverRuntime.lifecycle.deactivate("weather");
      await serverRuntime.lifecycle.activate("weather");
      await serverRuntime.lifecycle.activate("weather");

      await serverRuntime.lifecycle.activate("daily-messages");
      await serverRuntime.lifecycle.deactivate("daily-messages");
      await serverRuntime.lifecycle.activate("daily-messages");

      await serverRuntime.lifecycle.activate("network-devices");
      await serverRuntime.lifecycle.activate("network-devices");
      expect(await scheduler.runJobNow("network-devices.poll")).toEqual({
        status: "completed",
        result: 1,
      });
      await serverRuntime.lifecycle.deactivate("network-devices");
      await serverRuntime.lifecycle.deactivate("network-devices");
      expect(await scheduler.runJobNow("network-devices.poll")).toEqual({
        status: "already_running",
      });
      expect(networkJobEffects).toBe(1);
      await serverRuntime.lifecycle.activate("network-devices");
      expect(await scheduler.runJobNow("network-devices.poll")).toEqual({
        status: "completed",
        result: 2,
      });

      expect(app.printRoutes({ commonPrefix: false })).toBe(routesBefore);
      expect(
        getDb()
          .prepare(
            "SELECT object_name AS objectName, data, updated_at AS updatedAt FROM settings_objects WHERE object_name IN ('weather', 'printer', 'printerTransport') ORDER BY object_name"
          )
          .all()
      ).toEqual([
        {
          objectName: "weather",
          data: '{"lat":40.4168,"lon":-3.7038,"label":"Retained cycle value"}',
          updatedAt: FROZEN_NOW_MS,
        },
      ]);
      expect(
        getDb()
          .prepare(
            "SELECT plugin_id AS pluginId, migration_id AS migrationId, applied_at AS appliedAt FROM plugin_migration_journal ORDER BY plugin_id, migration_id"
          )
          .all()
      ).toEqual(journalBefore);
      expect(getDb().prepare("SELECT * FROM daily_messages").all()).toEqual(ownedDataBefore);

      const response = await app.inject({
        method: "GET",
        url: "/api/plugins",
        cookies: { mp_device_key: DEVICE_KEY },
      });
      expect(response.statusCode).toBe(200);
      const plugins = response.json().plugins as Array<{
        id: PluginId;
        state: PluginState;
        contributions: Record<string, string[]>;
      }>;
      expect(plugins.map(({ id }) => id)).toEqual(PLUGIN_IDS);
      for (const plugin of plugins) {
        for (const contributionIds of Object.values(plugin.contributions)) {
          expect(new Set(contributionIds).size, `${plugin.id} contribution duplicates`).toBe(
            contributionIds.length
          );
        }
      }
      const declaredRoutes = plugins.flatMap(({ contributions }) => contributions.routes);
      const declaredJobs = plugins.flatMap(({ contributions }) => contributions.jobs);
      const declaredAdmin = plugins.flatMap(({ contributions }) => contributions.admin);
      const declaredWidgets = plugins.flatMap(({ contributions }) => contributions.widgets);
      expect(new Set(declaredRoutes).size).toBe(declaredRoutes.length);
      expect(new Set(declaredJobs).size).toBe(declaredJobs.length);
      expect(new Set(declaredAdmin).size).toBe(declaredAdmin.length);
      expect(new Set(declaredWidgets).size).toBe(declaredWidgets.length);
      expect(plugins.find(({ id }) => id === "weather")?.state).toBe("active");
      expect(plugins.find(({ id }) => id === "daily-messages")?.state).toBe("active");
      expect(registryRows()).toEqual(
        exactRowsWith("inactive", {
          weather: { state: "active", activatedAt: FROZEN_NOW },
          "daily-messages": { state: "active", activatedAt: FROZEN_NOW },
          "network-devices": { state: "active", activatedAt: FROZEN_NOW },
        })
      );
      expectClosedRegistry(registryRows());
    } finally {
      await app.close();
      configurePluginJobLifecycleGate(undefined);
    }
  });

  it("repeat-cycle: adapter callbacks prove defaults retry while a journaled migration applies once", async () => {
    runMigrations(MIGRATIONS_DIR, { now: () => FROZEN_NOW_MS });
    const store = new SqlitePluginLifecycleStore(getDb());
    const weatherManifest = PLUGIN_MANIFESTS.find(({ id }) => id === "weather");
    if (!weatherManifest) throw new Error("Weather manifest missing");
    let defaultInvocations = 0;
    let migrationInvocations = 0;
    let mountInvocations = 0;
    let unmountInvocations = 0;
    const adapter = createPluginRuntimeAdapter({
      manifest: weatherManifest,
      store,
      now: () => FROZEN_NOW,
      ensureSettingsDefaults: () => {
        defaultInvocations += 1;
        ensurePluginSettingsDefaults("weather", getDb(), FROZEN_NOW_MS);
      },
      migrations: [
        {
          id: "compatibility-weather-v1",
          apply: () => {
            migrationInvocations += 1;
            return undefined;
          },
        },
      ],
      mount: () => {
        mountInvocations += 1;
      },
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => {
        unmountInvocations += 1;
      },
    });
    const lifecycle = createPluginLifecycle({
      store,
      adapters: [adapter],
      now: () => FROZEN_NOW,
      operationId: () => `repeat-weather-${defaultInvocations}`,
      drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
    });

    await lifecycle.activate("weather");
    await lifecycle.activate("weather");
    await lifecycle.deactivate("weather");
    await lifecycle.deactivate("weather");
    await lifecycle.activate("weather");
    await lifecycle.activate("weather");

    expect(defaultInvocations).toBe(2);
    expect(migrationInvocations).toBe(1);
    expect(mountInvocations).toBe(2);
    expect(unmountInvocations).toBe(1);
    expect(
      getDb()
        .prepare(
          "SELECT object_name AS objectName, data, updated_at AS updatedAt FROM settings_objects WHERE object_name = 'weather'"
        )
        .all()
    ).toEqual([
      { objectName: "weather", data: '{"lat":null,"lon":null}', updatedAt: FROZEN_NOW_MS },
    ]);
    expect(
      getDb()
        .prepare(
          "SELECT plugin_id AS pluginId, migration_id AS migrationId, applied_at AS appliedAt FROM plugin_migration_journal"
        )
        .all()
    ).toEqual([
      {
        pluginId: "weather",
        migrationId: "compatibility-weather-v1",
        appliedAt: FROZEN_NOW,
      },
    ]);
  });
});
