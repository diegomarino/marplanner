import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authBoundary } from "../../src/server/auth/boundary.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { buildApp } from "../../src/server/app.js";
import { getDb } from "../../src/server/db/client.js";
import { PluginLifecycleBusyError, PluginLifecycleError } from "../../src/server/plugins/errors.js";
import type { PluginLifecycle } from "../../src/server/plugins/lifecycle.js";
import { pluginRoutes } from "../../src/server/plugins/routes.js";
import type { PluginCatalogEntry } from "../../src/shared/plugins.js";
import { useIsolatedDb } from "../helpers/db.js";

const ENTRY: PluginCatalogEntry = {
  id: "weather",
  label: "plugins.weather.label",
  description: "plugins.weather.description",
  trustTier: "first-party",
  contributions: {
    routes: ["weather-api"],
    admin: ["weather"],
    settings: ["weather-settings"],
    widgets: ["weather-summary"],
    services: ["weather", "weather-text"],
    jobs: [],
  },
  requirements: ["app-settings"],
  settingsSchema: [],
  state: "active",
  operation: null,
  health: { status: "healthy", code: null },
  updatedAt: "2026-09-27T10:15:30.000Z",
  error: null,
};

const CATALOG: readonly PluginCatalogEntry[] = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
].map((id) => ({
  ...ENTRY,
  id: id as PluginCatalogEntry["id"],
  label: `plugins.${id}.label`,
  description: `plugins.${id}.description`,
}));

const CATALOG_ENTRY_KEYS = [
  "contributions",
  "description",
  "error",
  "health",
  "id",
  "label",
  "operation",
  "requirements",
  "settingsSchema",
  "state",
  "trustTier",
  "updatedAt",
];

function seedKey(raw: string, kind: "device" | "integration"): void {
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', ?, ?)"
    )
    .run(`key-${raw}`, hashKey(raw), kind, Date.now());
}

function fakeLifecycle(): PluginLifecycle {
  return {
    listCatalog: vi.fn(async () => CATALOG),
    activate: vi.fn(async () => ENTRY),
    deactivate: vi.fn(async () => ({ ...ENTRY, state: "inactive" as const })),
    reportFault: vi.fn(async () => undefined),
    reconcileAll: vi.fn(async () => ({ results: [] })),
    isActive: vi.fn(() => true),
    canClaimWork: vi.fn(() => true),
  };
}

async function buildRoutes(lifecycle: PluginLifecycle) {
  const app = Fastify();
  await authBoundary(app);
  await pluginRoutes(app, lifecycle);
  return app;
}

const AUTHORIZATIONS = [
  {
    name: "device cookie",
    prepare: () => seedKey("device-full", "device"),
    request: { cookies: { mp_device_key: "device-full" } },
  },
  {
    name: "raw bearer key",
    prepare: () => seedKey("integration-full", "integration"),
    request: { headers: { authorization: "Bearer integration-full" } },
  },
] as const;

describe("plugin lifecycle routes", () => {
  useIsolatedDb();
  let lifecycle: PluginLifecycle;

  beforeEach(() => {
    lifecycle = fakeLifecycle();
  });

  it("mounts the lifecycle API in the application when the lifecycle dependency is supplied", async () => {
    seedKey("device-full", "device");
    const app = await buildApp({ pluginLifecycle: lifecycle });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().plugins).toHaveLength(9);
    } finally {
      await app.close();
    }
  });

  for (const authorization of AUTHORIZATIONS) {
    it(`serves the closed catalog with a valid ${authorization.name}`, async () => {
      authorization.prepare();
      const app = await buildRoutes(lifecycle);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/plugins",
          ...authorization.request,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.plugins).toHaveLength(9);
        expect(body.plugins.map((plugin: PluginCatalogEntry) => plugin.id)).toEqual([
          "daily-briefing",
          "printing",
          "weather",
          "time-announcements",
          "backups",
          "network-devices",
          "meals-recipes",
          "reminders",
          "daily-messages",
        ]);
        for (const plugin of body.plugins) {
          expect(Object.keys(plugin).sort()).toEqual(CATALOG_ENTRY_KEYS);
        }
      } finally {
        await app.close();
      }
    });

    it.each([
      ["activate", "activate"],
      ["deactivate", "deactivate"],
    ] as const)(`executes %s with a valid ${authorization.name}`, async (path, method) => {
      authorization.prepare();
      const app = await buildRoutes(lifecycle);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/plugins/weather/${path}`,
          ...authorization.request,
        });
        expect(response.statusCode).toBe(200);
        expect(lifecycle[method]).toHaveBeenCalledWith("weather");
      } finally {
        await app.close();
      }
    });

    it(`accepts an allow-listed contribution fault with a valid ${authorization.name}`, async () => {
      authorization.prepare();
      const app = await buildRoutes(lifecycle);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/plugins/weather/fault",
          payload: { code: "contribution_render_failed" },
          ...authorization.request,
        });
        expect(response.statusCode).toBe(204);
        expect(lifecycle.reportFault).toHaveBeenCalledWith("weather", {
          code: "contribution_failed",
        });
      } finally {
        await app.close();
      }
    });
  }

  it("rejects unknown plugin IDs before invoking lifecycle work", async () => {
    seedKey("device-full", "device");
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/external-calendar-sync/activate",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "plugin_not_found",
        message: "Plugin not found.",
      });
      expect(lifecycle.activate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { code: "raw adapter exploded" },
    { code: "contribution_render_failed", message: "secret at /private/config" },
    { code: "contribution_render_failed", url: "http://192.168.1.2/private" },
  ])(
    "rejects raw or unknown fault fields without invoking containment (case %#)",
    async (payload) => {
      seedKey("device-full", "device");
      const app = await buildRoutes(lifecycle);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/plugins/weather/fault",
          cookies: { mp_device_key: "device-full" },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(Object.keys(response.json()).sort()).toEqual(["code", "message"]);
        expect(response.body).not.toContain("secret");
        expect(response.body).not.toContain("192.168");
        expect(lifecycle.reportFault).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("maps opposite-target contention to the stable safe 409 shape", async () => {
    seedKey("device-full", "device");
    vi.mocked(lifecycle.activate).mockRejectedValueOnce(new PluginLifecycleBusyError());
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/weather/activate",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "plugin_lifecycle_busy",
        message: "A lifecycle operation is already in progress for this plugin.",
        plugin: ENTRY,
      });
    } finally {
      await app.close();
    }
  });

  it("retains the pre-operation catalog snapshot when busy handling cannot reread it", async () => {
    seedKey("device-full", "device");
    let mutationStarted = false;
    vi.mocked(lifecycle.listCatalog).mockImplementation(async () => {
      if (mutationStarted) throw new Error("catalog unavailable after mutation");
      return CATALOG;
    });
    vi.mocked(lifecycle.activate).mockImplementation(async () => {
      mutationStarted = true;
      throw new PluginLifecycleBusyError();
    });
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/weather/activate",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "plugin_lifecycle_busy",
        message: "A lifecycle operation is already in progress for this plugin.",
        plugin: ENTRY,
      });
    } finally {
      await app.close();
    }
  });

  it("maps lifecycle failure to the stable safe 503 shape without raw detail", async () => {
    seedKey("device-full", "device");
    vi.mocked(lifecycle.activate).mockRejectedValueOnce(
      new PluginLifecycleError("migration_failed")
    );
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/weather/activate",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "plugin_lifecycle_failed",
        message: "The plugin could not complete the requested lifecycle change.",
        plugin: ENTRY,
      });
      expect(response.body).not.toContain("migration_failed");
    } finally {
      await app.close();
    }
  });

  it("retains the pre-operation catalog snapshot when failure handling cannot reread it", async () => {
    seedKey("device-full", "device");
    let mutationStarted = false;
    vi.mocked(lifecycle.listCatalog).mockImplementation(async () => {
      if (mutationStarted) throw new Error("catalog unavailable after mutation");
      return CATALOG;
    });
    vi.mocked(lifecycle.activate).mockImplementation(async () => {
      mutationStarted = true;
      throw new PluginLifecycleError("migration_failed");
    });
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/weather/activate",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "plugin_lifecycle_failed",
        message: "The plugin could not complete the requested lifecycle change.",
        plugin: ENTRY,
      });
    } finally {
      await app.close();
    }
  });

  it("returns the closed safe catalog-unavailable 503 for a catalog read failure", async () => {
    seedKey("device-full", "device");
    vi.mocked(lifecycle.listCatalog).mockRejectedValueOnce(new Error("sqlite secret"));
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/plugins",
        cookies: { mp_device_key: "device-full" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "plugin_catalog_unavailable",
        message: "The plugin catalog is temporarily unavailable.",
      });
      expect(response.body).not.toContain("sqlite secret");
    } finally {
      await app.close();
    }
  });

  it.each(["activate", "deactivate", "fault"] as const)(
    "does not invoke %s when the pre-operation catalog snapshot is unavailable",
    async (operation) => {
      seedKey("device-full", "device");
      vi.mocked(lifecycle.listCatalog).mockRejectedValueOnce(new Error("sqlite secret"));
      const app = await buildRoutes(lifecycle);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/plugins/weather/${operation}`,
          cookies: { mp_device_key: "device-full" },
          ...(operation === "fault" ? { payload: { code: "contribution_render_failed" } } : {}),
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          code: "plugin_catalog_unavailable",
          message: "The plugin catalog is temporarily unavailable.",
        });
        expect(lifecycle.activate).not.toHaveBeenCalled();
        expect(lifecycle.deactivate).not.toHaveBeenCalled();
        expect(lifecycle.reportFault).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("denies unauthenticated catalog reads before lifecycle disclosure", async () => {
    const app = await buildRoutes(lifecycle);
    try {
      const response = await app.inject({ method: "GET", url: "/api/plugins" });
      expect(response.statusCode).toBe(401);
      expect(Object.keys(response.json()).sort()).toEqual(["code", "error", "message"]);
      expect(lifecycle.listCatalog).not.toHaveBeenCalled();
      expect(response.body).not.toContain("weather");
    } finally {
      await app.close();
    }
  });
});
