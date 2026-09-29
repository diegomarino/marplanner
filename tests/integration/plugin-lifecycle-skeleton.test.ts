import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import type { PluginLifecycle } from "../../src/server/plugins/lifecycle.js";
import { SAFE_LIFECYCLE_ERRORS } from "../../src/server/plugins/errors.js";
import type { PluginId, PluginState } from "../../src/shared/plugins.js";
import { useIsolatedDb } from "../helpers/db.js";

const NOW = "2026-09-27T10:15:30.000Z";
const UNAVAILABLE = {
  code: "plugin_unavailable",
  message: "This plugin is unavailable.",
};

function seedDeviceKey(): void {
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run("plugin-skeleton-device", hashKey("plugin-skeleton-device"), Date.parse(NOW));
}

function setPluginState(pluginId: PluginId, state: PluginState): void {
  const error = state === "errored" ? SAFE_LIFECYCLE_ERRORS.contribution_failed : null;
  getDb()
    .prepare(
      `UPDATE plugin_activation_registry
       SET state = ?, updated_at = ?, error_code = ?, error_message = ?
       WHERE plugin_id = ?`
    )
    .run(state, NOW, error?.code ?? null, error?.message ?? null, pluginId);
}

function seedInterruptedOperation(options: {
  pluginId: PluginId;
  state: "active" | "inactive";
  targetState: "active" | "inactive";
  phase: "running-migrations" | "draining";
}): void {
  setPluginState(options.pluginId, options.state);
  getDb()
    .prepare(
      `INSERT INTO plugin_lifecycle_operations
         (operation_id, plugin_id, target_state, phase, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      `interrupted-${options.pluginId}`,
      options.pluginId,
      options.targetState,
      options.phase,
      NOW,
      NOW
    );
}

function registryState(pluginId: PluginId): PluginState {
  return (
    getDb()
      .prepare("SELECT state FROM plugin_activation_registry WHERE plugin_id = ?")
      .get(pluginId) as { state: PluginState }
  ).state;
}

function fakeLifecycle(overrides: Partial<PluginLifecycle> = {}): PluginLifecycle {
  return {
    listCatalog: vi.fn(async () => []),
    activate: vi.fn(async () => {
      throw new Error("not used");
    }),
    deactivate: vi.fn(async () => {
      throw new Error("not used");
    }),
    reportFault: vi.fn(async () => undefined),
    reconcileAll: vi.fn(async () => ({ results: [] })),
    isActive: vi.fn(() => true),
    canClaimWork: vi.fn(() => true),
    ...overrides,
  };
}

async function injectWeather(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: "GET",
    url: "/api/weather",
    cookies: { mp_device_key: "plugin-skeleton-device" },
  });
}

describe("plugin lifecycle runnable server skeleton", () => {
  useIsolatedDb({ pluginState: "inactive" });

  beforeEach(() => {
    seedDeviceKey();
  });

  it("boots a fresh fixture inactive while keeping liveness minimal and unauthenticated", async () => {
    const app = await buildApp();
    try {
      const unavailable = await injectWeather(app);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual(UNAVAILABLE);

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
      expect(health.body).not.toContain("plugin");
    } finally {
      await app.close();
    }
  });

  it("boots a prior-baseline fixture active and preserves its established handler", async () => {
    getDb().prepare("UPDATE installation_lineage SET kind = 'prior_baseline'").run();
    setPluginState("weather", "active");
    const app = await buildApp();
    try {
      const response = await injectWeather(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ forecast: null });
    } finally {
      await app.close();
    }
  });

  it.each(["inactive", "errored"] as const)(
    "never executes an %s plugin handler and returns the stable safe unavailable response",
    async (state) => {
      setPluginState("weather", state);
      const handler = vi.fn(async () => ({ forecast: { shouldNeverLeak: true } }));
      const weather = async (scope: FastifyInstance) => {
        scope.get("/api/weather", handler);
      };
      const app = await buildApp({ pluginRouteRegistrars: { weather } });
      try {
        const response = await injectWeather(app);
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual(UNAVAILABLE);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("executes an active plugin handler through the same stable dispatch gate", async () => {
    setPluginState("weather", "active");
    const handler = vi.fn(async () => ({ forecast: null }));
    const weather = async (scope: FastifyInstance) => {
      scope.get("/api/weather", handler);
    };
    const app = await buildApp({ pluginRouteRegistrars: { weather } });
    try {
      const response = await injectWeather(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ forecast: null });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("does not finish application startup before lifecycle reconciliation settles", async () => {
    let finishReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const lifecycle = fakeLifecycle({
      reconcileAll: vi.fn(async () => {
        await reconciliation;
        return { results: [] };
      }),
    });

    let started = false;
    const starting = buildApp({ pluginLifecycle: lifecycle }).then((app) => {
      started = true;
      return app;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    expect(lifecycle.reconcileAll).toHaveBeenCalledOnce();

    finishReconciliation();
    const app = await starting;
    try {
      expect(started).toBe(true);
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("fails an interrupted activation closed before plugin traffic is accepted", async () => {
    seedInterruptedOperation({
      pluginId: "weather",
      state: "inactive",
      targetState: "active",
      phase: "running-migrations",
    });

    const app = await buildApp();
    try {
      expect(registryState("weather")).toBe("errored");
      expect(
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM plugin_lifecycle_operations WHERE plugin_id = ?")
          .get("weather")
      ).toEqual({ count: 0 });
      const response = await injectWeather(app);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(UNAVAILABLE);
    } finally {
      await app.close();
    }
  });

  it("completes an interrupted deactivation before plugin traffic is accepted", async () => {
    seedInterruptedOperation({
      pluginId: "weather",
      state: "active",
      targetState: "inactive",
      phase: "draining",
    });

    const app = await buildApp();
    try {
      expect(registryState("weather")).toBe("inactive");
      const response = await injectWeather(app);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(UNAVAILABLE);
    } finally {
      await app.close();
    }
  });

  it("contains one errored plugin without blocking the host or sibling catalog reads", async () => {
    setPluginState("weather", "errored");
    setPluginState("daily-messages", "active");
    const app = await buildApp();
    try {
      const catalog = await app.inject({
        method: "GET",
        url: "/api/plugins",
        cookies: { mp_device_key: "plugin-skeleton-device" },
      });
      expect(catalog.statusCode).toBe(200);
      const plugins = catalog.json().plugins as Array<{ id: PluginId; state: PluginState }>;
      expect(plugins.find(({ id }) => id === "weather")?.state).toBe("errored");
      expect(plugins.find(({ id }) => id === "daily-messages")?.state).toBe("active");
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
        status: "ok",
      });
    } finally {
      await app.close();
    }
  });
});
