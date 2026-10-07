import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { authBoundary } from "../../src/server/auth/boundary.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import { PluginLifecycleError, SAFE_LIFECYCLE_ERRORS } from "../../src/server/plugins/errors.js";
import { createPluginLifecycle } from "../../src/server/plugins/lifecycle.js";
import { PLUGIN_MANIFESTS } from "../../src/server/plugins/manifest.js";
import { pluginRoutes } from "../../src/server/plugins/routes.js";
import type { PluginRuntimeAdapter } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import type { PluginId, PluginState } from "../../src/shared/plugins.js";
import { useIsolatedDb } from "../helpers/db.js";

const NOW = "2026-09-28T08:00:00.000Z";
const DEADLINE = { expiresAt: "2026-09-28T08:05:00.000Z" } as const;

type Effect = "settings" | "migrations" | "mount" | "block" | "drain" | "unmount";

interface AdapterControl {
  readonly effects: Effect[];
  failAt?: Effect;
  failure?: Error;
}

function manifest(pluginId: PluginId) {
  const value = PLUGIN_MANIFESTS.find(({ id }) => id === pluginId);
  if (!value) throw new Error(`Missing manifest for ${pluginId}`);
  return value;
}

function adapter(pluginId: PluginId, control: AdapterControl): PluginRuntimeAdapter {
  const effect = async (name: Effect): Promise<void> => {
    control.effects.push(name);
    if (control.failAt === name) {
      throw control.failure ?? new Error(`raw ${name} fault`);
    }
  };
  return {
    manifest: manifest(pluginId),
    ensureSettingsDefaults: () => effect("settings"),
    runPendingMigrations: () => effect("migrations"),
    mount: () => effect("mount"),
    blockNewClaims: () => {
      control.effects.push("block");
      if (control.failAt === "block") throw control.failure ?? new Error("raw block fault");
    },
    drain: async () => {
      await effect("drain");
      return "drained";
    },
    unmount: () => effect("unmount"),
  };
}

function setState(pluginId: PluginId, state: PluginState): void {
  getDb()
    .prepare(
      `UPDATE plugin_activation_registry
       SET state = ?, activated_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
       WHERE plugin_id = ?`
    )
    .run(state, state === "active" ? NOW : null, NOW, pluginId);
}

function harness(controls: Partial<Record<PluginId, AdapterControl>> = {}) {
  const store = new SqlitePluginLifecycleStore(getDb());
  const allControls = Object.fromEntries(
    PLUGIN_MANIFESTS.map(({ id }) => [id, controls[id] ?? { effects: [] }])
  ) as Record<PluginId, AdapterControl>;
  const lifecycle = createPluginLifecycle({
    store,
    adapters: PLUGIN_MANIFESTS.map(({ id }) => adapter(id, allControls[id])),
    now: () => NOW,
    operationId: (pluginId) => `operation-${pluginId}`,
    drainDeadline: () => DEADLINE,
  });
  return { lifecycle, store, controls: allControls };
}

describe("plugin lifecycle reconciliation", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it.each([
    ["migrations", "migration_failed"],
    ["mount", "runtime_mount_failed"],
    ["drain", "drain_failed"],
    ["unmount", "runtime_unmount_failed"],
  ] as const)(
    "contains a %s fault to one plugin while its active sibling remains usable",
    async (failAt, expectedCode) => {
      const target: PluginId = "weather";
      const sibling: PluginId = "daily-briefing";
      if (failAt === "drain" || failAt === "unmount") setState(target, "active");
      setState(sibling, "active");
      const targetControl: AdapterControl = {
        effects: [],
        failAt,
        failure: new Error(
          "mpk-private /Users/operator/plugin.db https://10.0.0.8 00:1A:2B:3C:4D:5E"
        ),
      };
      const { lifecycle, store, controls } = harness({ [target]: targetControl });

      const action =
        failAt === "drain" || failAt === "unmount"
          ? lifecycle.deactivate(target)
          : lifecycle.activate(target);
      const failure = await action.catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PluginLifecycleError);
      expect(failure).toMatchObject({ code: expectedCode });
      expect(store.getRegistry(target)).toMatchObject({
        state: "errored",
        error: SAFE_LIFECYCLE_ERRORS[expectedCode],
      });
      expect(store.getRegistry(sibling)).toMatchObject({ state: "active", error: null });
      expect(lifecycle.isActive(sibling)).toBe(true);
      expect(controls[sibling].effects).toEqual([]);
      expect(JSON.stringify(await lifecycle.listCatalog())).not.toMatch(
        /mpk-private|Users\/operator|10\.0\.0\.8|00:1A/i
      );
    }
  );

  it("runs pending migrations before a retry mount and never publishes a partial activation", async () => {
    const control: AdapterControl = { effects: [], failAt: "migrations" };
    const { lifecycle, store } = harness({ weather: control });

    await expect(lifecycle.activate("weather")).rejects.toMatchObject({
      code: "migration_failed",
    });
    expect(store.getRegistry("weather").state).toBe("errored");
    expect(control.effects).toEqual(["settings", "migrations", "block", "unmount"]);

    control.effects.length = 0;
    control.failAt = undefined;
    await expect(lifecycle.activate("weather")).resolves.toMatchObject({ state: "active" });

    expect(control.effects).toEqual(["settings", "migrations", "mount"]);
    expect(store.getOperation("weather")).toBeNull();
  });

  it.each([
    ["preparing-settings", "active", "errored", ["block", "unmount"]],
    ["running-migrations", "active", "errored", ["block", "unmount"]],
    ["mounting", "active", "errored", ["block", "unmount"]],
    ["committing-active", "active", "errored", ["block", "unmount"]],
    ["blocking-claims", "inactive", "inactive", ["block", "drain", "unmount"]],
    ["draining", "inactive", "inactive", ["block", "drain", "unmount"]],
    ["unmounting", "inactive", "inactive", ["block", "unmount"]],
    ["committing-inactive", "inactive", "inactive", ["block"]],
  ] as const)(
    "reconciles interrupted durable phase %s deterministically",
    async (phase, targetState, expectedState, expectedEffects) => {
      const pluginId: PluginId = "printing";
      if (targetState === "inactive") setState(pluginId, "active");
      const { lifecycle, store, controls } = harness();
      store.begin(pluginId, `restart-${phase}`, targetState, phase, NOW);

      await lifecycle.reconcileAll();

      expect(store.getRegistry(pluginId).state).toBe(expectedState);
      expect(store.getOperation(pluginId)).toBeNull();
      expect(controls[pluginId].effects).toEqual(expectedEffects);
    }
  );

  it("continues sibling reconciliation after a job drain fault", async () => {
    setState("printing", "active");
    setState("weather", "active");
    setState("daily-briefing", "active");
    const printing: AdapterControl = { effects: [], failAt: "drain" };
    const { lifecycle, store, controls } = harness({ printing });
    store.begin("printing", "restart-printing", "inactive", "draining", NOW);
    store.begin("weather", "restart-weather", "inactive", "unmounting", NOW);

    const report = await lifecycle.reconcileAll();

    expect(report.results).toEqual([
      { pluginId: "printing", state: "errored" },
      { pluginId: "weather", state: "inactive" },
    ]);
    expect(store.getRegistry("daily-briefing").state).toBe("active");
    expect(controls.weather.effects).toEqual(["block", "unmount"]);
  });

  it("treats allocation-adjacent exceptions as ordinary logic faults without claiming resource isolation", async () => {
    const control: AdapterControl = {
      effects: [],
      failAt: "mount",
      failure: new RangeError("Array buffer allocation failed after CPU pressure"),
    };
    const { lifecycle, store } = harness({ weather: control });

    await expect(lifecycle.activate("weather")).rejects.toMatchObject({
      code: "runtime_mount_failed",
      message: "Plugin services could not be started.",
    });
    expect(store.getRegistry("weather")).toMatchObject({
      state: "errored",
      error: SAFE_LIFECYCLE_ERRORS.runtime_mount_failed,
    });
    expect(Object.keys(SAFE_LIFECYCLE_ERRORS)).not.toContain("resource_isolated");
  });

  it("returns the post-failure errored snapshot with only stable public error fields", async () => {
    const control: AdapterControl = {
      effects: [],
      failAt: "migrations",
      failure: new Error("credential mpg-secret at /private/operator.json"),
    };
    const { lifecycle } = harness({ weather: control });
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run("key-plugin-t012", hashKey("plugin-t012"), Date.parse(NOW));
    const app = Fastify();
    await authBoundary(app);
    await pluginRoutes(app, lifecycle);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/weather/activate",
        cookies: { mp_device_key: "plugin-t012" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "plugin_lifecycle_failed",
        plugin: {
          id: "weather",
          state: "errored",
          health: { status: "attention", code: "migration_failed" },
          error: SAFE_LIFECYCLE_ERRORS.migration_failed,
        },
      });
      expect(response.body).not.toMatch(/mpg-secret|private\/operator|credential/i);
    } finally {
      await app.close();
    }
  });
});
