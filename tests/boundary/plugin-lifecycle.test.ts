
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { PLUGIN_MANIFESTS } from "../../src/server/plugins/manifest.js";
import {
  PluginLifecycleBusyError,
  PluginLifecycleError,
  SAFE_LIFECYCLE_ERRORS,
} from "../../src/server/plugins/errors.js";
import { createPluginLifecycle } from "../../src/server/plugins/lifecycle.js";
import type {
  PluginDrainDeadline,
  PluginRuntimeAdapter,
} from "../../src/server/plugins/runtime.js";
import {
  SqlitePluginLifecycleStore,
  type PluginLifecyclePhase,
} from "../../src/server/plugins/store.js";
import type { PluginId, PluginPublicErrorCode, PluginState } from "../../src/shared/plugins.js";
import { execBaseline } from "../helpers/baseline";

const NOW = "2026-09-27T10:15:30.000Z";
const DEADLINE: PluginDrainDeadline = { expiresAt: "2026-09-27T10:20:30.000Z" };

type Effect = "settings" | "migrations" | "mount" | "block" | "drain" | "unmount";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface FakeControls {
  readonly effects: Effect[];
  readonly settingsStarted?: Deferred<void>;
  readonly settingsGate?: Promise<void>;
  readonly failAt?: Effect;
  readonly drainResult?: "drained" | "expired";
  readonly rawFailure?: Error;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeAdapter(pluginId: PluginId, controls: FakeControls): PluginRuntimeAdapter {
  const manifest = PLUGIN_MANIFESTS.find(({ id }) => id === pluginId);
  if (!manifest) throw new Error(`Missing test manifest for ${pluginId}`);

  const run = async (effect: Effect): Promise<void> => {
    controls.effects.push(effect);
    if (effect === "settings") {
      controls.settingsStarted?.resolve();
      await controls.settingsGate;
    }
    if (controls.failAt === effect) {
      throw controls.rawFailure ?? new Error(`raw ${effect} failure`);
    }
  };

  return {
    manifest,
    ensureSettingsDefaults: () => run("settings"),
    runPendingMigrations: () => run("migrations"),
    mount: () => run("mount"),
    blockNewClaims: () => {
      controls.effects.push("block");
      if (controls.failAt === "block") throw controls.rawFailure ?? new Error("raw block failure");
    },
    drain: async (deadline) => {
      expect(deadline).toEqual(DEADLINE);
      await run("drain");
      return controls.drainResult ?? "drained";
    },
    unmount: () => run("unmount"),
  };
}

function createDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  execBaseline(db, NOW);
  return db;
}

function setState(
  db: Database.Database,
  pluginId: PluginId,
  state: PluginState,
  errorCode: PluginPublicErrorCode | null = null
): void {
  const error = errorCode === null ? null : SAFE_LIFECYCLE_ERRORS[errorCode];
  db.prepare(
    `UPDATE plugin_activation_registry
     SET state = ?, activated_at = ?, updated_at = ?, error_code = ?, error_message = ?
     WHERE plugin_id = ?`
  ).run(state, state === "active" ? NOW : null, NOW, errorCode, error?.message ?? null, pluginId);
}

function createOperation(
  db: Database.Database,
  pluginId: PluginId,
  targetState: "active" | "inactive",
  phase: PluginLifecyclePhase
): void {
  db.prepare(
    `INSERT INTO plugin_lifecycle_operations
       (operation_id, plugin_id, target_state, phase, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`restart-${pluginId}`, pluginId, targetState, phase, NOW, NOW);
}

function operationCount(db: Database.Database, pluginId: PluginId): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM plugin_lifecycle_operations WHERE plugin_id = ?")
      .get(pluginId) as { count: number }
  ).count;
}

function registryState(db: Database.Database, pluginId: PluginId): PluginState {
  return (
    db
      .prepare("SELECT state FROM plugin_activation_registry WHERE plugin_id = ?")
      .get(pluginId) as { state: PluginState }
  ).state;
}

async function captureFailure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

function expectSanitizedPersistenceFailure(error: unknown): void {
  expect(error).toBeInstanceOf(PluginLifecycleError);
  expect(error).toMatchObject({
    name: "PluginLifecycleError",
    code: "reconciliation_failed",
    message: "Plugin recovery requires attention.",
  });
  expect(String(error)).not.toContain("raw sqlite");
  expect(error).not.toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER" });
}

function createHarness(
  db: Database.Database,
  adapterControls: Partial<Record<PluginId, FakeControls>> = {}
) {
  const store = new SqlitePluginLifecycleStore(db);
  const controls = Object.fromEntries(
    PLUGIN_MANIFESTS.map(({ id }) => [id, adapterControls[id] ?? { effects: [] }])
  ) as Record<PluginId, FakeControls>;
  const adapters = PLUGIN_MANIFESTS.map(({ id }) => fakeAdapter(id, controls[id]));
  const lifecycle = createPluginLifecycle({
    store,
    adapters,
    now: () => NOW,
    operationId: (pluginId) => `operation-${pluginId}`,
    drainDeadline: () => DEADLINE,
  });
  return { lifecycle, store, controls };
}

const databases: Database.Database[] = [];

function testDatabase(): Database.Database {
  const db = createDatabase();
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("plugin lifecycle coordinator", () => {
  it("activates in durable phase order and atomically publishes active while deleting the operation", async () => {
    const db = testDatabase();
    const observed: string[] = [];
    const store = new SqlitePluginLifecycleStore(db);
    const controls: FakeControls = { effects: [] };
    const baseAdapter = fakeAdapter("weather", controls);
    const adapter: PluginRuntimeAdapter = {
      ...baseAdapter,
      ensureSettingsDefaults: async () => {
        observed.push(store.getOperation("weather")?.phase ?? "missing");
        await baseAdapter.ensureSettingsDefaults();
      },
      runPendingMigrations: async () => {
        observed.push(store.getOperation("weather")?.phase ?? "missing");
        await baseAdapter.runPendingMigrations();
      },
      mount: async () => {
        observed.push(store.getOperation("weather")?.phase ?? "missing");
        await baseAdapter.mount();
      },
    };
    const lifecycle = createPluginLifecycle({
      store,
      adapters: [adapter],
      now: () => NOW,
      operationId: () => "activation-operation",
      drainDeadline: () => DEADLINE,
    });

    await lifecycle.activate("weather");

    expect(controls.effects).toEqual(["settings", "migrations", "mount"]);
    expect(observed).toEqual(["preparing-settings", "running-migrations", "mounting"]);
    expect(store.getRegistry("weather")).toMatchObject({
      state: "active",
      activatedAt: NOW,
      error: null,
    });
    expect(store.getOperation("weather")).toBeNull();

    setState(db, "weather", "inactive");
    createOperation(db, "weather", "active", "committing-active");
    db.exec(`
      CREATE TRIGGER reject_activation_operation_delete
      BEFORE DELETE ON plugin_lifecycle_operations
      BEGIN
        SELECT RAISE(ABORT, 'delete rejected');
      END;
    `);
    expect(() => store.complete("weather", "active", NOW)).toThrow("delete rejected");
    expect(registryState(db, "weather")).toBe("inactive");
    expect(operationCount(db, "weather")).toBe(1);
  });

  it("keeps canonical active through drain, blocks claims, and atomically completes deactivation", async () => {
    const db = testDatabase();
    setState(db, "printing", "active");
    const store = new SqlitePluginLifecycleStore(db);
    const controls: FakeControls = { effects: [] };
    const baseAdapter = fakeAdapter("printing", controls);
    const observations: Array<{
      phase: PluginLifecyclePhase | null;
      active: boolean;
      claim: boolean;
    }> = [];
    let lifecycle!: ReturnType<typeof createPluginLifecycle>;
    const observe = () => {
      observations.push({
        phase: store.getOperation("printing")?.phase ?? null,
        active: lifecycle.isActive("printing"),
        claim: lifecycle.canClaimWork("printing"),
      });
    };
    const adapter: PluginRuntimeAdapter = {
      ...baseAdapter,
      blockNewClaims: () => {
        observe();
        baseAdapter.blockNewClaims();
      },
      drain: async (deadline) => {
        observe();
        return baseAdapter.drain(deadline);
      },
      unmount: async () => {
        observe();
        await baseAdapter.unmount();
      },
    };
    lifecycle = createPluginLifecycle({
      store,
      adapters: [adapter],
      now: () => NOW,
      operationId: () => "deactivation-operation",
      drainDeadline: () => DEADLINE,
    });

    await lifecycle.deactivate("printing");

    expect(controls.effects).toEqual(["block", "drain", "unmount"]);
    expect(observations).toEqual([
      { phase: "blocking-claims", active: true, claim: false },
      { phase: "draining", active: true, claim: false },
      { phase: "unmounting", active: true, claim: false },
    ]);
    expect(registryState(db, "printing")).toBe("inactive");
    expect(operationCount(db, "printing")).toBe(0);

    setState(db, "printing", "active");
    createOperation(db, "printing", "inactive", "committing-inactive");
    db.exec(`
      CREATE TRIGGER reject_deactivation_operation_delete
      BEFORE DELETE ON plugin_lifecycle_operations
      BEGIN
        SELECT RAISE(ABORT, 'delete rejected');
      END;
    `);
    expect(() => store.complete("printing", "inactive", NOW)).toThrow("delete rejected");
    expect(registryState(db, "printing")).toBe("active");
    expect(operationCount(db, "printing")).toBe(1);
  });

  it("shares the exact promise for same-target overlap and rejects the opposite target without mutation", async () => {
    const db = testDatabase();
    const started = deferred<void>();
    const gate = deferred<void>();
    const controls: FakeControls = {
      effects: [],
      settingsStarted: started,
      settingsGate: gate.promise,
    };
    const { lifecycle, store } = createHarness(db, { weather: controls });

    const first = lifecycle.activate("weather");
    await started.promise;
    const second = lifecycle.activate("weather");
    expect(second).toBe(first);

    const before = store.getRegistry("weather");
    await expect(lifecycle.deactivate("weather")).rejects.toMatchObject({
      code: "plugin_lifecycle_busy",
      message: "Plugin lifecycle operation is already in progress.",
    });
    expect(store.getRegistry("weather")).toEqual(before);
    expect(store.getOperation("weather")).toMatchObject({ targetState: "active" });

    gate.resolve();
    await expect(first).resolves.toMatchObject({ id: "weather", state: "active" });
    expect(controls.effects).toEqual(["settings", "migrations", "mount"]);
  });

  it("returns already-terminal states without replaying adapter effects", async () => {
    const db = testDatabase();
    setState(db, "daily-briefing", "active");
    const { lifecycle, controls } = createHarness(db);

    await expect(lifecycle.activate("daily-briefing")).resolves.toMatchObject({ state: "active" });
    await expect(lifecycle.deactivate("weather")).resolves.toMatchObject({ state: "inactive" });

    expect(controls["daily-briefing"].effects).toEqual([]);
    expect(controls.weather.effects).toEqual([]);
    expect(operationCount(db, "daily-briefing")).toBe(0);
    expect(operationCount(db, "weather")).toBe(0);
  });

  it.each([
    ["settings", "settings_initialization_failed", "Plugin settings could not be prepared."],
    ["migrations", "migration_failed", "Plugin data could not be prepared."],
    ["mount", "runtime_mount_failed", "Plugin services could not be started."],
    ["drain", "drain_failed", "Plugin work could not stop safely."],
    ["unmount", "runtime_unmount_failed", "Plugin services could not be stopped."],
  ] as const)(
    "maps %s failure to a stable safe error, quiesces best-effort, and atomically clears the operation",
    async (failAt, code, message) => {
      const db = testDatabase();
      const pluginId: PluginId = "network-devices";
      if (failAt === "drain" || failAt === "unmount") setState(db, pluginId, "active");
      const rawFailure = new Error(
        "secret mpk-raw-key /Users/operator/private.sqlite https://192.168.1.1"
      );
      const controls: FakeControls = { effects: [], failAt, rawFailure };
      const { lifecycle, store } = createHarness(db, { [pluginId]: controls });

      const request =
        failAt === "drain" || failAt === "unmount"
          ? lifecycle.deactivate(pluginId)
          : lifecycle.activate(pluginId);
      const rejection = await request.catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(PluginLifecycleError);
      expect(rejection).toMatchObject({ code, message });
      expect(JSON.stringify(rejection)).not.toContain("mpk-raw-key");
      expect(JSON.stringify(rejection)).not.toContain("192.168.1.1");
      expect(store.getRegistry(pluginId)).toMatchObject({
        state: "errored",
        error: { code, message },
      });
      expect(store.getOperation(pluginId)).toBeNull();
      expect(controls.effects).toContain("block");
      expect(controls.effects).toContain("unmount");
    }
  );

  it("maps an expired drain to the same fail-closed drain error", async () => {
    const db = testDatabase();
    setState(db, "printing", "active");
    const controls: FakeControls = { effects: [], drainResult: "expired" };
    const { lifecycle, store } = createHarness(db, { printing: controls });

    await expect(lifecycle.deactivate("printing")).rejects.toMatchObject({
      code: "drain_failed",
      message: "Plugin work could not stop safely.",
    });
    expect(store.getRegistry("printing").state).toBe("errored");
    expect(store.getOperation("printing")).toBeNull();
  });

  it("records a contribution fault through a durable operation and quiesces only that plugin", async () => {
    const db = testDatabase();
    setState(db, "daily-messages", "active");
    setState(db, "daily-briefing", "active");
    const { lifecycle, controls, store } = createHarness(db);

    await lifecycle.reportFault("daily-messages", { code: "contribution_failed" });

    expect(controls["daily-messages"].effects).toEqual(["block", "unmount"]);
    expect(controls["daily-briefing"].effects).toEqual([]);
    expect(store.getRegistry("daily-messages")).toMatchObject({
      state: "errored",
      error: SAFE_LIFECYCLE_ERRORS.contribution_failed,
    });
    expect(store.getOperation("daily-messages")).toBeNull();
    expect(store.getRegistry("daily-briefing").state).toBe("active");
  });

  it("retains a durably recorded contribution fault when restart resumes containment", async () => {
    const db = testDatabase();
    setState(db, "daily-messages", "active");
    db.transaction(() => {
      createOperation(db, "daily-messages", "inactive", "blocking-claims");
      setState(db, "daily-messages", "errored", "contribution_failed");
    })();

    const { lifecycle, controls, store } = createHarness(db);
    await lifecycle.reconcileAll();

    expect(controls["daily-messages"].effects).toEqual(["block", "unmount"]);
    expect(store.getRegistry("daily-messages")).toMatchObject({
      state: "errored",
      error: SAFE_LIFECYCLE_ERRORS.contribution_failed,
    });
    expect(store.getOperation("daily-messages")).toBeNull();
  });

  it.each(["preparing-settings", "running-migrations", "mounting", "committing-active"] as const)(
    "fails closed when reconciling interrupted activation phase %s",
    async (phase) => {
      const db = testDatabase();
      createOperation(db, "weather", "active", phase);
      const { lifecycle, controls, store } = createHarness(db);

      await lifecycle.reconcileAll();

      expect(controls.weather.effects).toEqual(["block", "unmount"]);
      expect(controls.weather.effects).not.toContain("settings");
      expect(controls.weather.effects).not.toContain("migrations");
      expect(controls.weather.effects).not.toContain("mount");
      expect(store.getRegistry("weather")).toMatchObject({
        state: "errored",
        error: SAFE_LIFECYCLE_ERRORS.reconciliation_failed,
      });
      expect(store.getOperation("weather")).toBeNull();
    }
  );

  it.each([
    ["blocking-claims", ["block", "drain", "unmount"]],
    ["draining", ["block", "drain", "unmount"]],
    ["unmounting", ["block", "unmount"]],
    ["committing-inactive", ["block"]],
  ] as const)(
    "reconciles interrupted deactivation phase %s without remounting stale active state",
    async (phase, effects) => {
      const db = testDatabase();
      setState(db, "printing", "active");
      createOperation(db, "printing", "inactive", phase);
      const { lifecycle, controls, store } = createHarness(db);

      expect(lifecycle.isActive("printing")).toBe(true);
      expect(lifecycle.canClaimWork("printing")).toBe(false);
      await lifecycle.reconcileAll();

      expect(controls.printing.effects).toEqual(effects);
      expect(controls.printing.effects).not.toContain("mount");
      expect(store.getRegistry("printing").state).toBe("inactive");
      expect(store.getOperation("printing")).toBeNull();
    }
  );

  it("contains one reconciliation failure without blocking or changing its sibling", async () => {
    const db = testDatabase();
    createOperation(db, "weather", "active", "running-migrations");
    createOperation(db, "printing", "active", "mounting");
    setState(db, "daily-briefing", "active");
    const weather: FakeControls = {
      effects: [],
      failAt: "migrations",
      rawFailure: new Error("private migration failure"),
    };
    const printing: FakeControls = { effects: [] };
    const { lifecycle, store } = createHarness(db, { weather, printing });

    const report = await lifecycle.reconcileAll();

    expect(report.results).toEqual([
      { pluginId: "printing", state: "errored" },
      { pluginId: "weather", state: "errored" },
    ]);
    expect(store.getRegistry("weather").state).toBe("errored");
    expect(store.getRegistry("printing").state).toBe("errored");
    expect(store.getRegistry("daily-briefing").state).toBe("active");
    expect(printing.effects).toEqual(["block", "unmount"]);
  });

  describe("persistence failure sanitization", () => {
    it("sanitizes operation begin failure without mutating canonical state", async () => {
      const db = testDatabase();
      db.exec(`
        CREATE TRIGGER reject_operation_begin
        BEFORE INSERT ON plugin_lifecycle_operations
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite begin rejected');
        END;
      `);
      const { lifecycle, store } = createHarness(db);

      const rejection = await captureFailure(() => lifecycle.activate("weather"));

      expectSanitizedPersistenceFailure(rejection);
      expect(store.getRegistry("weather").state).toBe("inactive");
      expect(store.getOperation("weather")).toBeNull();
    });

    it("sanitizes phase update failure and settles safely when error persistence succeeds", async () => {
      const db = testDatabase();
      db.exec(`
        CREATE TRIGGER reject_phase_update
        BEFORE UPDATE ON plugin_lifecycle_operations
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite phase rejected');
        END;
      `);
      const { lifecycle, controls, store } = createHarness(db);

      const rejection = await captureFailure(() => lifecycle.activate("weather"));

      expectSanitizedPersistenceFailure(rejection);
      expect(controls.weather.effects).toEqual(["settings", "block", "unmount"]);
      expect(store.getRegistry("weather")).toMatchObject({
        state: "errored",
        error: SAFE_LIFECYCLE_ERRORS.reconciliation_failed,
      });
      expect(store.getOperation("weather")).toBeNull();
    });

    it("quiesces a mounted runtime when persisting the committing-active phase fails", async () => {
      const db = testDatabase();
      db.exec(`
        CREATE TRIGGER reject_committing_active_phase
        BEFORE UPDATE ON plugin_lifecycle_operations
        WHEN NEW.phase = 'committing-active'
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite post-mount phase rejected');
        END;
      `);
      const { lifecycle, controls, store } = createHarness(db);

      const rejection = await captureFailure(() => lifecycle.activate("weather"));

      expectSanitizedPersistenceFailure(rejection);
      expect(controls.weather.effects).toEqual([
        "settings",
        "migrations",
        "mount",
        "block",
        "unmount",
      ]);
      expect(store.getRegistry("weather")).toMatchObject({
        state: "errored",
        error: SAFE_LIFECYCLE_ERRORS.reconciliation_failed,
      });
      expect(store.getOperation("weather")).toBeNull();
    });

    it("sanitizes terminal success failure and preserves its atomic rollback", async () => {
      const db = testDatabase();
      createOperation(db, "weather", "active", "committing-active");
      db.exec(`
        CREATE TRIGGER reject_success_cleanup
        BEFORE DELETE ON plugin_lifecycle_operations
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite success rejected');
        END;
      `);
      const { lifecycle, store } = createHarness(db);

      const rejection = await captureFailure(() => lifecycle.activate("weather"));

      expectSanitizedPersistenceFailure(rejection);
      expect(store.getRegistry("weather").state).toBe("inactive");
      expect(store.getOperation("weather")).toMatchObject({ phase: "committing-active" });
    });

    it("quiesces a mounted runtime when terminal activation persistence fails", async () => {
      const db = testDatabase();
      db.exec(`
        CREATE TRIGGER reject_mounted_activation_cleanup
        BEFORE DELETE ON plugin_lifecycle_operations
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite mounted activation rejected');
        END;
      `);
      const { lifecycle, controls, store } = createHarness(db);

      const rejection = await captureFailure(() => lifecycle.activate("weather"));

      expectSanitizedPersistenceFailure(rejection);
      expect(controls.weather.effects).toEqual([
        "settings",
        "migrations",
        "mount",
        "block",
        "unmount",
      ]);
      expect(store.getRegistry("weather")).toMatchObject({ state: "inactive", error: null });
      expect(store.getOperation("weather")).toMatchObject({ phase: "committing-active" });
    });

    it("sanitizes terminal failure persistence and preserves its atomic rollback", async () => {
      const db = testDatabase();
      db.exec(`
        CREATE TRIGGER reject_failure_cleanup
        BEFORE DELETE ON plugin_lifecycle_operations
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite failure rejected');
        END;
      `);
      const controls: FakeControls = { effects: [], failAt: "settings" };
      const { lifecycle, store } = createHarness(db, { weather: controls });

      const rejection = await captureFailure(() => lifecycle.activate("weather"));

      expectSanitizedPersistenceFailure(rejection);
      expect(store.getRegistry("weather").state).toBe("inactive");
      expect(store.getOperation("weather")).toMatchObject({ phase: "preparing-settings" });
    });

    it("sanitizes atomic fault persistence failure without leaving a partial operation", async () => {
      const db = testDatabase();
      setState(db, "daily-messages", "active");
      db.exec(`
        CREATE TRIGGER reject_fault_state
        BEFORE UPDATE ON plugin_activation_registry
        WHEN NEW.state = 'errored'
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite fault rejected');
        END;
        `);
      const { lifecycle, controls, store } = createHarness(db);

      const rejection = await captureFailure(() =>
        lifecycle.reportFault("daily-messages", { code: "contribution_failed" })
      );

      expectSanitizedPersistenceFailure(rejection);
      expect(controls["daily-messages"].effects).toEqual([]);
      expect(store.getRegistry("daily-messages")).toMatchObject({
        state: "active",
        error: null,
      });
      expect(store.getOperation("daily-messages")).toBeNull();
    });

    it("sanitizes reconciliation settlement failure after processing independent siblings", async () => {
      const db = testDatabase();
      createOperation(db, "printing", "active", "mounting");
      createOperation(db, "weather", "active", "committing-active");
      db.exec(`
        CREATE TRIGGER reject_weather_reconciliation_cleanup
        BEFORE DELETE ON plugin_lifecycle_operations
        WHEN OLD.plugin_id = 'weather'
        BEGIN
          SELECT RAISE(ABORT, 'raw sqlite reconciliation rejected');
        END;
        `);
      const { lifecycle, store } = createHarness(db);

      const rejection = await captureFailure(() => lifecycle.reconcileAll());

      expectSanitizedPersistenceFailure(rejection);
      expect(store.getRegistry("printing")).toMatchObject({
        state: "errored",
        error: SAFE_LIFECYCLE_ERRORS.reconciliation_failed,
      });
      expect(store.getOperation("printing")).toBeNull();
      expect(store.getRegistry("weather").state).toBe("inactive");
      expect(store.getOperation("weather")).toMatchObject({ phase: "committing-active" });
    });
  });

  it("derives activity and claim eligibility only from canonical state plus operation semantics", () => {
    const db = testDatabase();
    const { lifecycle } = createHarness(db);

    expect(lifecycle.isActive("weather")).toBe(false);
    expect(lifecycle.canClaimWork("weather")).toBe(false);

    setState(db, "weather", "active");
    expect(lifecycle.isActive("weather")).toBe(true);
    expect(lifecycle.canClaimWork("weather")).toBe(true);

    createOperation(db, "weather", "inactive", "draining");
    expect(lifecycle.isActive("weather")).toBe(true);
    expect(lifecycle.canClaimWork("weather")).toBe(false);

    expect(() => new PluginLifecycleBusyError()).not.toThrow();
  });
});
