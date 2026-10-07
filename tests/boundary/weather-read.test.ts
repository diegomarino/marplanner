import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { healthyRawForecast } from "../helpers/weather-fixtures";

/** docs/features/weather.md — `GET /api/weather` boundary tests (FR-012/024,
 * WEATHER-INV-12). BLACK-BOX: buildApp + Fastify.inject only, exactly like
 * `settings-write.test.ts`. Absence is ALWAYS 200 `{forecast: null}` — never a 5xx.
 */
describe("weather-read", () => {
  useIsolatedDb();

  afterEach(async () => {
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(undefined);
  });

  function seedDeviceKey(): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const db = getDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return deviceKey;
  }

  function seedWeatherLocation(lat: number, lon: number, label?: string): void {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run(JSON.stringify(label ? { lat, lon, label } : { lat, lon }), Date.now());
  }

  it("blank location -> 200 {forecast: null} with ZERO port calls", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    const portSpy = { calls: 0 };
    __setForecastPortForTests(async () => {
      portSpy.calls += 1;
      return null;
    });

    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ forecast: null });
      expect(portSpy.calls).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("a partial (single-coordinate) stored pair reads as blank, not a crash (edge case)", async () => {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run(JSON.stringify({ lat: 40.4, lon: null }), Date.now());

    const deviceKey = seedDeviceKey();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ forecast: null });
    } finally {
      await app.close();
    }
  });

  it("a corrupt (malformed-JSON) settings row -> 200 {forecast: null}, never a 5xx (reconciliation P2-2)", async () => {
    // readWeatherLocation (src/server/modules/weather/index.ts) does an unguarded
    // JSON.parse over the row's `data` column — a row this malformed is unreachable through
    // the validated PUT boundary, but the route must not assume the DB can never hold one
    // (a hand-edit, a migration bug, disk corruption). The route wraps the call so this
    // degrades to blank absence exactly like every other failure mode, never a 500.
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run("{not valid json{{{", Date.now());

    const deviceKey = seedDeviceKey();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ forecast: null });
    } finally {
      await app.close();
    }
  });

  it("configured location + healthy port -> 200 with a normalized body matching the contract shape", async () => {
    seedWeatherLocation(40.4, -3.7, "Home");

    const { buildApp } = await import("../../src/server/app.ts");
    const { __setForecastPortForTests, buildForecastPort } =
      await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(
      buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined })
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(healthyRawForecast()), { status: 200 })) as typeof fetch;

    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { forecast: unknown };
      // Hand-diff against the contract's WeatherResponse/ForecastResult shape (drift gate is
      // route-only — 016-review precedent): exactly {current, hourly, daily}, nothing else.
      expect(Object.keys(body)).toEqual(["forecast"]);
      expect(body.forecast).not.toBeNull();
      const forecast = body.forecast as {
        current: unknown;
        hourly: unknown[];
        daily: unknown[];
      };
      expect(Object.keys(forecast).sort()).toEqual(["current", "daily", "hourly"]);
      expect(Array.isArray(forecast.hourly)).toBe(true);
      expect(Array.isArray(forecast.daily)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });

  it("configured location + failed port -> 200 {forecast: null}, never a 5xx", async () => {
    seedWeatherLocation(40.4, -3.7);

    const { buildApp } = await import("../../src/server/app.ts");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async () => null);

    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ forecast: null });
    } finally {
      await app.close();
    }
  });

  it("no weather SETTINGS endpoint exists (FR-024) — only the read route is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      expect(app.hasRoute({ method: "GET", url: "/api/weather" })).toBe(true);
      expect(app.hasRoute({ method: "PUT", url: "/api/weather" })).toBe(false);
      expect(app.hasRoute({ method: "POST", url: "/api/weather" })).toBe(false);
    } finally {
      await app.close();
    }
  });
});
