import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { getDb } from "../../src/server/db/client";
import { hashKey } from "../../src/server/auth/credentials";
import { reconcileManagement } from "../../src/server/auth/reconcile";
import { authBoundary } from "../../src/server/auth/boundary";
import { requireManagementKey } from "../../src/server/auth/capability";
import { AUTH_SCOPE_DENIED_CODE } from "../../src/shared";
import { main } from "../../src/server/index";
import { readWeekStartDay } from "../../src/server/lib/household-date";
import { readSettingsObject } from "../../src/server/lib/settings-objects";
import { readWeatherLocation } from "../../src/server/modules/weather/index";
import { configurePluginJobLifecycleGate, createScheduler } from "../../src/server/scheduler/index";
import {
  createDailyBlockCache,
  evictWeatherCache,
  getOrFetchOnceDaily,
} from "../../src/server/modules/daily-briefing/external/shared-cache";
import { useIsolatedDb } from "../helpers/db";

describe("foundation runtime persistence", () => {
  useIsolatedDb({ pluginState: "inactive" });
  afterEach(() => vi.restoreAllMocks());

  it("shares successful and null results across cache instances and retries fetch failures", async () => {
    const first = createDailyBlockCache("2026-09-29");
    const overlapping = createDailyBlockCache("2026-09-29");
    const fetchQuote = vi.fn(async () => ({ text: "Today" }));
    expect(await getOrFetchOnceDaily(first, "quoteOfDay", fetchQuote)).toEqual({ text: "Today" });
    expect(await getOrFetchOnceDaily(overlapping, "quoteOfDay", fetchQuote)).toEqual({
      text: "Today",
    });
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    expect(createDailyBlockCache("2026-09-29").get("quoteOfDay")).toEqual({ text: "Today" });

    const fetchEmpty = vi.fn(async () => null);
    expect(await getOrFetchOnceDaily(first, "onThisDay", fetchEmpty)).toBeNull();
    expect(
      await getOrFetchOnceDaily(createDailyBlockCache("2026-09-29"), "onThisDay", fetchEmpty)
    ).toBeNull();
    expect(fetchEmpty).toHaveBeenCalledTimes(1);

    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream unavailable"))
      .mockResolvedValueOnce("recovered");
    expect(await getOrFetchOnceDaily(first, "retry", retry)).toBeNull();
    expect(await getOrFetchOnceDaily(first, "retry", retry)).toBe("recovered");
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("evicts weather across dates and discards a stale in-flight write", async () => {
    createDailyBlockCache("2026-09-28").set("weather", "old-day");
    createDailyBlockCache("2026-09-29").set("weather", "old-location");
    const cache = createDailyBlockCache("2026-09-30");
    let resolveFetch: ((value: string) => void) | undefined;
    const pending = getOrFetchOnceDaily(
      cache,
      "weather",
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    evictWeatherCache();
    resolveFetch?.("stale-location");
    expect(await pending).toBe("stale-location");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale-write-discarded"));
    for (const date of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      expect(createDailyBlockCache(date).get("weather")).toBeUndefined();
    }
    expect(
      await getOrFetchOnceDaily(
        createDailyBlockCache("2026-09-30"),
        "weather",
        async () => "new-location"
      )
    ).toBe("new-location");
  });

  it("retains an in-memory result if persistence fails, while a fresh instance misses", async () => {
    const cache = createDailyBlockCache("2026-09-29");
    getDb().exec("DROP TABLE daily_briefing_block_cache");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getOrFetchOnceDaily(cache, "quoteOfDay", async () => "available")).toBe(
      "available"
    );
    expect(cache.get("quoteOfDay")).toBe("available");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("persist-failed"));
  });

  it("seeds a configured management key once and leaves revoked keys revoked", () => {
    const previous = process.env.MP_MANAGEMENT_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env.MP_MANAGEMENT_KEY;
      reconcileManagement();
      expect(getDb().prepare("SELECT count(*) AS count FROM api_keys").get()).toEqual({ count: 0 });
      process.env.MP_MANAGEMENT_KEY = "invalid";
      expect(() => reconcileManagement()).toThrow("MP_MANAGEMENT_KEY");
      process.env.MP_MANAGEMENT_KEY = "mpk-management-fixture";
      reconcileManagement();
      reconcileManagement();
      const row = getDb().prepare("SELECT id, key_hash, kind, scope FROM api_keys").get() as {
        id: string;
        key_hash: string;
        kind: string;
        scope: string;
      };
      expect(row).toMatchObject({
        key_hash: hashKey(process.env.MP_MANAGEMENT_KEY),
        kind: "integration",
        scope: "*",
      });
      expect(getDb().prepare("SELECT count(*) AS count FROM api_keys").get()).toEqual({ count: 1 });
      getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), row.id);
      reconcileManagement();
      expect(getDb().prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(row.id)).toEqual({
        revoked_at: expect.any(Number),
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("REVOKED or EXPIRED"));
    } finally {
      process.env.MP_MANAGEMENT_KEY = previous;
    }
  });

  it("reads only persisted settings and rejects corrupt or incomplete weather locations", () => {
    expect(readSettingsObject("missing")).toBeUndefined();
    expect(readWeekStartDay()).toBe(1);
    expect(readWeatherLocation()).toBeNull();
    getDb()
      .prepare("INSERT INTO settings_objects (object_name, data, updated_at) VALUES (?, ?, ?)")
      .run("locale", JSON.stringify({ timezone: "UTC", weekStartDay: 0 }), Date.now());
    expect(readSettingsObject("locale")).toContain('"weekStartDay":0');
    expect(readWeekStartDay()).toBe(0);
    const writeWeather = (data: string) =>
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?) ON CONFLICT(object_name) DO UPDATE SET data = excluded.data"
        )
        .run(data, Date.now());
    writeWeather("broken-json");
    expect(readWeatherLocation()).toBeNull();
    writeWeather(JSON.stringify({ lat: 41 }));
    expect(readWeatherLocation()).toBeNull();
    writeWeather(JSON.stringify({ lat: 41, lon: 2, label: "Barcelona" }));
    expect(readWeatherLocation()).toEqual({ lat: 41, lon: 2, label: "Barcelona" });
  });

  it("drains selected jobs by deadline and applies the lifecycle gate to manual runs", async () => {
    const scheduler = createScheduler();
    let release: (() => void) | undefined;
    scheduler.registerJob({
      id: "foundation.probe",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    configurePluginJobLifecycleGate(() => false);
    try {
      expect(await scheduler.runJobNow("foundation.probe")).toEqual({ status: "already_running" });
      configurePluginJobLifecycleGate(() => true);
      const running = scheduler.runJobNow("foundation.probe");
      expect(await scheduler.drainJobs(["missing"], { expiresAt: "invalid" })).toBe("drained");
      expect(await scheduler.drainJobs(["foundation.probe"], { expiresAt: "invalid" })).toBe(
        "expired"
      );
      expect(
        await scheduler.drainJobs(["foundation.probe"], {
          expiresAt: new Date(Date.now() - 1).toISOString(),
        })
      ).toBe("expired");
      expect(
        await scheduler.drainJobs(["foundation.probe"], {
          expiresAt: new Date(Date.now() + 15).toISOString(),
        })
      ).toBe("expired");
      const draining = scheduler.drainJobs(["foundation.probe"], {
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      });
      release?.();
      expect(await running).toEqual({ status: "completed", result: undefined });
      expect(await draining).toBe("drained");
    } finally {
      release?.();
      configurePluginJobLifecycleGate(undefined);
      await scheduler.stop();
    }
  });

  it("keeps management routes inaccessible to a provisioned device key", async () => {
    const now = Date.now();
    for (const [id, kind] of [
      ["device", "device"],
      ["operator", "integration"],
    ]) {
      getDb()
        .prepare(
          "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', ?, ?)"
        )
        .run(id, hashKey(`mpk-${id}`), kind, now);
    }
    const app = Fastify();
    await authBoundary(app);
    app.get("/api/plugins/management-probe", { preHandler: requireManagementKey() }, async () => ({
      ok: true,
    }));
    try {
      const denied = await app.inject({
        method: "GET",
        url: "/api/plugins/management-probe",
        cookies: { mp_device_key: "mpk-device" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe(AUTH_SCOPE_DENIED_CODE);
      const allowed = await app.inject({
        method: "GET",
        url: "/api/plugins/management-probe",
        headers: { authorization: "Bearer mpk-operator" },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("boots the foundation listener and drains its scheduler on shutdown", async () => {
    const previous = {
      port: process.env.PORT,
      host: process.env.HOST,
      disabled: process.env.SCHEDULER_DISABLED,
      bootstrap: process.env.MP_BOOTSTRAP_KEY,
      management: process.env.MP_MANAGEMENT_KEY,
      readiness: process.env.MP_LOCAL_READINESS,
    };
    process.env.PORT = "0";
    process.env.HOST = "127.0.0.1";
    process.env.SCHEDULER_DISABLED = "1";
    process.env.MP_LOCAL_READINESS = "1";
    delete process.env.MP_BOOTSTRAP_KEY;
    delete process.env.MP_MANAGEMENT_KEY;
    const before = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main();
      expect(log).toHaveBeenCalledWith("scheduler disabled");
      const readyLine = log.mock.calls
        .map(([message]) => message)
        .find((message) => typeof message === "string" && message.startsWith("MP_LOCAL_READY "));
      expect(readyLine).toBeDefined();
      const ready = JSON.parse(String(readyLine).slice("MP_LOCAL_READY ".length)) as {
        type: string;
        port: number;
      };
      expect(ready.type).toBe("ready");
      expect(ready.port).toBeGreaterThan(0);
      const origin = `http://127.0.0.1:${ready.port}`;
      const health = await fetch(`${origin}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      expect((await fetch(`${origin}/api/members`)).status).toBe(401);
      const shutdown = process.listeners("SIGINT").find((listener) => !before.SIGINT.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.("SIGINT");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(log).toHaveBeenCalledWith("scheduler drained");
      const messages = log.mock.calls.map(([message]) => message);
      const stopping = messages.indexOf('MP_LOCAL_READY {"type":"stopping"}');
      expect(stopping).toBeGreaterThan(-1);
      expect(stopping).toBeLessThan(messages.indexOf("scheduler drained"));
      await expect(fetch(`${origin}/health`)).rejects.toThrow();
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].has(listener)) process.off(signal, listener);
        }
      }
      for (const [key, value] of Object.entries({
        PORT: previous.port,
        HOST: previous.host,
        SCHEDULER_DISABLED: previous.disabled,
        MP_BOOTSTRAP_KEY: previous.bootstrap,
        MP_MANAGEMENT_KEY: previous.management,
        MP_LOCAL_READINESS: previous.readiness,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
