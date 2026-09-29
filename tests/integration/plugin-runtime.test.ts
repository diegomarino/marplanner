import { describe, expect, it } from "vitest";

import { getDb, type DatabaseConnection } from "../../src/server/db/client.js";
import { PluginLifecycleError } from "../../src/server/plugins/errors.js";
import { createPluginLifecycle } from "../../src/server/plugins/lifecycle.js";
import { PLUGIN_MANIFESTS } from "../../src/server/plugins/manifest.js";
import type { PluginRuntimeAdapter } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import type { PluginId, PluginManifest } from "../../src/shared/plugins.js";
import { PLUGIN_IDS } from "../../src/shared/plugins.js";
import { seedMember } from "../helpers/daily-briefing-seed.js";
import { useIsolatedDb } from "../helpers/db.js";

const NOW = "2026-09-27T10:15:30.000Z";
const NOW_MS = Date.parse(NOW);

interface TestMigration {
  readonly id: string;
  readonly apply: () => undefined;
}

interface RuntimeAdapterOptions {
  readonly manifest: PluginManifest;
  readonly store: SqlitePluginLifecycleStore;
  readonly now: () => string;
  readonly ensureSettingsDefaults?: () => void | Promise<void>;
  readonly migrations?: readonly TestMigration[];
  readonly mount: () => void | Promise<void>;
  readonly blockNewClaims: () => void;
  readonly drain: PluginRuntimeAdapter["drain"];
  readonly unmount: () => void | Promise<void>;
}

type RuntimeFactory = (options: RuntimeAdapterOptions) => PluginRuntimeAdapter;
type EnsureSettingsDefaults = (
  pluginId: PluginId,
  db?: DatabaseConnection,
  updatedAt?: number
) => void;

interface ServerPluginRuntime {
  readonly adapters: readonly PluginRuntimeAdapter[];
  readonly lifecycle: ReturnType<typeof createPluginLifecycle>;
  isContributionActive(pluginId: PluginId): boolean;
}

type ServerPluginRuntimeFactory = (options: {
  readonly store: SqlitePluginLifecycleStore;
  readonly now: () => string;
  readonly operationId: (pluginId: PluginId) => string;
  readonly drainDeadline: (pluginId: PluginId) => { readonly expiresAt: string };
}) => ServerPluginRuntime;

function manifest(pluginId: PluginId): PluginManifest {
  const value = PLUGIN_MANIFESTS.find(({ id }) => id === pluginId);
  if (!value) throw new Error(`Missing manifest for ${pluginId}`);
  return value;
}

async function loadRuntimeFactory(): Promise<RuntimeFactory> {
  const runtime = await import("../../src/server/plugins/runtime.js");
  expect(runtime).toHaveProperty("createPluginRuntimeAdapter");
  return (runtime as unknown as { createPluginRuntimeAdapter: RuntimeFactory })
    .createPluginRuntimeAdapter;
}

async function loadSettingsDefaults(): Promise<EnsureSettingsDefaults> {
  const settings = await import("../../src/server/modules/settings/index.js");
  expect(settings).toHaveProperty("ensurePluginSettingsDefaults");
  return (settings as unknown as { ensurePluginSettingsDefaults: EnsureSettingsDefaults })
    .ensurePluginSettingsDefaults;
}

async function loadServerPluginRuntime(): Promise<ServerPluginRuntimeFactory> {
  const runtime = await import("../../src/server/plugins/runtime.js");
  expect(runtime).toHaveProperty("createServerPluginRuntime");
  return (runtime as unknown as { createServerPluginRuntime: ServerPluginRuntimeFactory })
    .createServerPluginRuntime;
}

function lifecycleFor(adapter: PluginRuntimeAdapter, store: SqlitePluginLifecycleStore) {
  return createPluginLifecycle({
    store,
    adapters: [adapter],
    now: () => NOW,
    operationId: (pluginId) => `runtime-${pluginId}`,
    drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
  });
}

function journalIds(pluginId: PluginId): string[] {
  return (
    getDb()
      .prepare(
        `SELECT migration_id AS migrationId
         FROM plugin_migration_journal
         WHERE plugin_id = ?
         ORDER BY migration_id`
      )
      .all(pluginId) as Array<{ migrationId: string }>
  ).map(({ migrationId }) => migrationId);
}

function registryState(pluginId: PluginId): string {
  return (
    getDb()
      .prepare("SELECT state FROM plugin_activation_registry WHERE plugin_id = ?")
      .get(pluginId) as { state: string }
  ).state;
}

describe("plugin runtime activation stages", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("keeps configured settings while inactive, inserts only absent defaults, and activates settings-less plugins from registry state", async () => {
    const createAdapter = await loadRuntimeFactory();
    const ensureSettingsDefaults = await loadSettingsDefaults();
    const settings = await import("../../src/server/modules/settings/index.js");
    const db = getDb();
    const store = new SqlitePluginLifecycleStore(db);

    settings.writeSettingsObject("weather", { lat: 51.5, lon: -0.12, label: "London" }, db);
    expect(settings.readEffectiveSettings(db)).not.toHaveProperty("weather");

    const weather = createAdapter({
      manifest: manifest("weather"),
      store,
      now: () => NOW,
      ensureSettingsDefaults: () => ensureSettingsDefaults("weather", db, NOW_MS),
      mount: () => undefined,
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => undefined,
    });
    await lifecycleFor(weather, store).activate("weather");

    expect(settings.readEffectiveSettings(db).weather).toEqual({
      lat: 51.5,
      lon: -0.12,
      label: "London",
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM settings_objects WHERE object_name = 'weather'")
        .get()
    ).toEqual({ count: 1 });

    const dailyMessages = createAdapter({
      manifest: manifest("daily-messages"),
      store,
      now: () => NOW,
      mount: () => undefined,
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => undefined,
    });
    await lifecycleFor(dailyMessages, store).activate("daily-messages");

    expect(registryState("daily-messages")).toBe("active");
    expect(db.prepare("SELECT COUNT(*) AS count FROM settings_objects").get()).toEqual({
      count: 1,
    });
  });

  it("publishes default-complete Printing settings after insert-if-absent activation", async () => {
    const createAdapter = await loadRuntimeFactory();
    const ensureSettingsDefaults = await loadSettingsDefaults();
    const settings = await import("../../src/server/modules/settings/index.js");
    const db = getDb();
    const store = new SqlitePluginLifecycleStore(db);
    const printing = createAdapter({
      manifest: manifest("printing"),
      store,
      now: () => NOW,
      ensureSettingsDefaults: () => ensureSettingsDefaults("printing", db, NOW_MS),
      mount: () => undefined,
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => undefined,
    });

    await lifecycleFor(printing, store).activate("printing");

    expect(settings.readEffectiveSettings(db)).toMatchObject({
      printer: { paperWidthDots: 576 },
      printerTransport: {
        deviceId: "",
        name: "",
        serviceUuid: "",
        characteristicUuid: "",
      },
    });
    expect(
      db
        .prepare(
          "SELECT object_name AS objectName FROM settings_objects WHERE object_name LIKE 'printer%' ORDER BY object_name"
        )
        .all()
    ).toEqual([{ objectName: "printer" }, { objectName: "printerTransport" }]);
  });

  it("journals each committed forward migration once and retries only the failed pending migration", async () => {
    const createAdapter = await loadRuntimeFactory();
    const db = getDb();
    const store = new SqlitePluginLifecycleStore(db);
    const runs: string[] = [];
    let failSecond = true;
    let mounts = 0;

    db.exec("CREATE TABLE weather_plugin_data (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const adapter = createAdapter({
      manifest: manifest("weather"),
      store,
      now: () => NOW,
      migrations: [
        {
          id: "001-retained-row",
          apply: () => {
            runs.push("001-retained-row");
            db.prepare(
              "INSERT INTO weather_plugin_data (id, value) VALUES ('retained', 'yes')"
            ).run();
          },
        },
        {
          id: "002-retryable",
          apply: () => {
            runs.push("002-retryable");
            db.prepare(
              "INSERT INTO weather_plugin_data (id, value) VALUES ('retried', 'yes')"
            ).run();
            if (failSecond) throw new Error("synthetic migration failure");
          },
        },
      ],
      mount: () => {
        mounts += 1;
      },
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => undefined,
    });
    const lifecycle = lifecycleFor(adapter, store);

    await expect(lifecycle.activate("weather")).rejects.toMatchObject<
      Partial<PluginLifecycleError>
    >({
      code: "migration_failed",
    });
    expect(registryState("weather")).toBe("errored");
    expect(journalIds("weather")).toEqual(["001-retained-row"]);
    expect(db.prepare("SELECT id, value FROM weather_plugin_data ORDER BY id").all()).toEqual([
      { id: "retained", value: "yes" },
    ]);
    expect(mounts).toBe(0);

    failSecond = false;
    await expect(lifecycle.activate("weather")).resolves.toMatchObject({ state: "active" });
    await adapter.runPendingMigrations();

    expect(runs).toEqual(["001-retained-row", "002-retryable", "002-retryable"]);
    expect(journalIds("weather")).toEqual(["001-retained-row", "002-retryable"]);
    expect(db.prepare("SELECT id, value FROM weather_plugin_data ORDER BY id").all()).toEqual([
      { id: "retained", value: "yes" },
      { id: "retried", value: "yes" },
    ]);
    expect(mounts).toBe(1);
  });

  it("rejects a Promise-returning migration without journaling or publishing active", async () => {
    const createAdapter = await loadRuntimeFactory();
    const db = getDb();
    const store = new SqlitePluginLifecycleStore(db);
    let mounts = 0;
    let asyncMigrationRan = false;
    const adapter = createAdapter({
      manifest: manifest("weather"),
      store,
      now: () => NOW,
      migrations: [
        {
          id: "001-async-not-allowed",
          apply: (async () => {
            asyncMigrationRan = true;
          }) as unknown as () => undefined,
        },
      ],
      mount: () => {
        mounts += 1;
      },
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => undefined,
    });

    await expect(lifecycleFor(adapter, store).activate("weather")).rejects.toMatchObject({
      code: "migration_failed",
    });
    expect(journalIds("weather")).toEqual([]);
    expect(registryState("weather")).toBe("errored");
    expect(mounts).toBe(0);
    expect(asyncMigrationRan).toBe(false);
  });

  it("does not publish active settings while mount is still incomplete", async () => {
    const createAdapter = await loadRuntimeFactory();
    const ensureSettingsDefaults = await loadSettingsDefaults();
    const settings = await import("../../src/server/modules/settings/index.js");
    const db = getDb();
    const store = new SqlitePluginLifecycleStore(db);
    let releaseMount!: () => void;
    let announceMount!: () => void;
    const mountStarted = new Promise<void>((resolve) => {
      announceMount = resolve;
    });
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const adapter = createAdapter({
      manifest: manifest("weather"),
      store,
      now: () => NOW,
      ensureSettingsDefaults: () => ensureSettingsDefaults("weather", db, NOW_MS),
      migrations: [{ id: "001-ready", apply: () => undefined }],
      mount: async () => {
        announceMount();
        await mountGate;
      },
      blockNewClaims: () => undefined,
      drain: async () => "drained",
      unmount: () => undefined,
    });
    const activation = lifecycleFor(adapter, store).activate("weather");

    await mountStarted;
    expect(registryState("weather")).toBe("inactive");
    expect(settings.readEffectiveSettings(db)).not.toHaveProperty("weather");
    expect(
      db.prepare("SELECT data FROM settings_objects WHERE object_name = 'weather'").get()
    ).toEqual({ data: '{"lat":null,"lon":null}' });
    expect(journalIds("weather")).toEqual(["001-ready"]);

    releaseMount();
    await expect(activation).resolves.toMatchObject({ state: "active" });
    expect(settings.readEffectiveSettings(db)).toHaveProperty("weather");
  });
});

describe("real first-party plugin runtime assembly", () => {
  useIsolatedDb();

  it("assembles exactly one adapter for every manifest and no dynamic or external-calendar adapter", async () => {
    const createRuntime = await loadServerPluginRuntime();
    const store = new SqlitePluginLifecycleStore(getDb());
    const runtime = createRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `assembled-${pluginId}`,
      drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
    });

    expect(runtime.adapters.map(({ manifest: adapterManifest }) => adapterManifest.id)).toEqual(
      PLUGIN_IDS
    );
    expect(new Set(runtime.adapters.map(({ manifest: value }) => value.runtimeAdapterKey))).toEqual(
      new Set(PLUGIN_IDS)
    );
    expect(runtime.adapters).toHaveLength(9);
    expect(runtime.adapters.map(({ manifest: value }) => value.id)).not.toContain(
      "external-calendar-sync"
    );
  });

  it("mounts and withdraws every adapter through one canonical lifecycle gate", async () => {
    const createRuntime = await loadServerPluginRuntime();
    const store = new SqlitePluginLifecycleStore(getDb());
    const runtime = createRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `cycle-${pluginId}`,
      drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
    });

    for (const pluginId of PLUGIN_IDS) {
      expect(runtime.isContributionActive(pluginId), `${pluginId} starts inactive`).toBe(false);
      await runtime.lifecycle.activate(pluginId);
      expect(runtime.isContributionActive(pluginId), `${pluginId} mounts when active`).toBe(true);
      await runtime.lifecycle.deactivate(pluginId);
      expect(runtime.isContributionActive(pluginId), `${pluginId} withdraws when inactive`).toBe(
        false
      );
    }
  });

  it("uses the shared lifecycle gate for Printing and Daily Briefing peer content without inventing reminder jobs or a server speaker", async () => {
    const createRuntime = await loadServerPluginRuntime();
    const store = new SqlitePluginLifecycleStore(getDb());
    const runtime = createRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `gate-${pluginId}`,
      drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
    });
    const printing = await import("../../src/server/modules/printing/index.js");
    const briefing = await import("../../src/server/modules/daily-briefing/index.js");

    seedMember("runtime-member");
    expect(briefing.listOptIns()).toEqual([]);
    await runtime.lifecycle.activate("daily-briefing");
    expect(briefing.listOptIns()).toEqual([{ memberId: "runtime-member", enabled: true }]);
    await runtime.lifecycle.deactivate("daily-briefing");
    expect(briefing.listOptIns()).toEqual([]);

    expect(printing.isPrintingPluginActive()).toBe(false);
    await runtime.lifecycle.activate("printing");
    expect(printing.isPrintingPluginActive()).toBe(true);
    await runtime.lifecycle.deactivate("printing");
    expect(printing.isPrintingPluginActive()).toBe(false);

    const contentSourceOwners = {
      weather: "weather",
      weatherText: "weather",
      meals: "meals-recipes",
      reminders: "reminders",
      message: "daily-messages",
    } as const;
    for (const [sourceId, pluginId] of Object.entries(contentSourceOwners)) {
      expect(briefing.isPluginContentSourceActive(sourceId)).toBe(false);
      await runtime.lifecycle.activate(pluginId);
      expect(briefing.isPluginContentSourceActive(sourceId)).toBe(true);
      await runtime.lifecycle.deactivate(pluginId);
      expect(briefing.isPluginContentSourceActive(sourceId)).toBe(false);
    }

    const reminders = manifest("reminders");
    expect(reminders.contributions.contentSources).toEqual(["reminders"]);
    expect(reminders.contributions.jobs).toEqual([]);
    const timeAnnouncements = manifest("time-announcements");
    expect(timeAnnouncements.contributions.services).toEqual([
      { id: "time-announcements-speaker", runtime: "browser" },
    ]);
    expect(timeAnnouncements.contributions.services).not.toContainEqual(
      expect.objectContaining({ runtime: "server" })
    );
  });
});
