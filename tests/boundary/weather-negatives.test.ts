import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { eventBus } from "../../src/server/lib/event-bus";
import { useIsolatedDb } from "../helpers/db";
import { ALL_SCHEMA_TABLES } from "../helpers/schema-tables";
import { healthyRawForecast } from "../helpers/weather-fixtures";

/** docs/features/weather.md — negative-surface sweep (..D10, FR-008,
 * FR-023, FR-024; quickstart scenario 8): the guarantees that are proven by something being
 * ABSENT rather than present, all in one place per the quickstart's own grouping. BLACK-BOX
 * against `buildApp` + Fastify `.inject`, exactly like `weather-read.test.ts` /
 * `settings-write.test.ts` — never an HTTP probe for route absence (`app.hasRoute`,
 * per-repo lesson: a 404 from the SPA catch-all gate would read as a false "absent").
 */
describe("weather negative-surface sweep (T014)", () => {
  useIsolatedDb();

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  function seedMember(id: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
      )
      .run(id, "Ada", now, now);
  }

  function seedOptIn(memberId: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
      )
      .run(memberId, now, now);
  }

  function seedWeatherLocation(lat: number, lon: number): void {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run(JSON.stringify({ lat, lon }), Date.now());
  }

  // ── (a) FR-023: no weather* table; the FULL table inventory is unchanged ───────────

  it("FR-023: sqlite_master has no weather* table, and the full table inventory is unchanged", () => {
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tables.some((t) => t.name.toLowerCase().startsWith("weather"))).toBe(false);
    // Exact-set proof (migrate-runner.test.ts precedent): weather adds NOTHING to the
    // schema — its only storage is the `weather` row inside the already-existing
    // `settings_objects` table (FR-023's "configuration lives only in App Settings").
    expect(tables.map((t) => t.name)).toEqual(ALL_SCHEMA_TABLES);
  });

  // ── (b) FR-024: no weather settings endpoint, on ANY settings-ish path/method ──────

  it("FR-024: exposes GET /api/weather only — no write method on it, and no settings-ish sibling path", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      expect(app.hasRoute({ method: "GET", url: "/api/weather" })).toBe(true);

      for (const method of ["PUT", "POST", "PATCH", "DELETE"] as const) {
        expect(app.hasRoute({ method, url: "/api/weather" })).toBe(false);
      }

      for (const url of ["/api/weather/settings", "/api/settings/weather"]) {
        for (const method of ["GET", "PUT", "POST", "PATCH", "DELETE"] as const) {
          expect(app.hasRoute({ method, url })).toBe(false);
        }
      }
    } finally {
      await app.close();
    }
  });

  // ── (c) FR-024: zero weather-prefixed bus events across a full fetch+briefing cycle ─

  it("FR-024: emits no weather-prefixed bus event across a full GET /api/weather + POST /api/daily-briefing/generate cycle", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit");
    const subscribeSpy = vi.spyOn(eventBus, "subscribe");

    seedWeatherLocation(40.4, -3.7);
    seedMember("m1");
    seedOptIn("m1");

    const { __setForecastPortForTests, buildForecastPort } =
      await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(
      buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined })
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(healthyRawForecast()), { status: 200 })) as typeof fetch;

    const deviceKey = seedDeviceKey();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const weatherRes = await app.inject({
        method: "GET",
        url: "/api/weather",
        cookies: { mp_device_key: deviceKey },
      });
      expect(weatherRes.statusCode).toBe(200);

      const briefingRes = await app.inject({
        method: "POST",
        url: "/api/daily-briefing/generate",
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: "m1", date: "2026-09-04" },
      });
      expect(briefingRes.statusCode).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }

    // Sanity: the cycle genuinely ran the daily-briefing generation path (which DOES emit
    // its own, non-weather event) — proves this isn't a vacuous "nothing was ever emitted"
    // pass; the assertion below is specifically about the weather PREFIX, not the total
    // count (FR-024, task).
    expect(emitSpy).toHaveBeenCalledWith(
      "daily_briefing.generated",
      expect.objectContaining({ memberId: "m1" })
    );
    const weatherPrefixedEmits = emitSpy.mock.calls.filter(([name]) =>
      String(name).startsWith("weather")
    );
    expect(weatherPrefixedEmits).toHaveLength(0);
    const weatherPrefixedSubscribes = subscribeSpy.mock.calls.filter(([name]) =>
      String(name).startsWith("weather")
    );
    expect(weatherPrefixedSubscribes).toHaveLength(0);
  });

  it("FR-024 (structural half): no file under src/server/modules/weather imports the event bus", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), "src", "server", "modules", "weather");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    // review (P2-b): a per-LINE `^\s*import\b` filter misses a Prettier-wrapped
    // multiline import whose `from "..."` clause lands on a later line than the `import`
    // keyword — the module specifier itself is never split across lines by any formatter, so
    // scanning the COMPLETE file content for the forbidden specifier (static OR the
    // `import(...)` dynamic form — both wrap the same quoted string) catches it regardless of
    // how the surrounding statement is line-wrapped. Proven RED-then-reverted against a
    // temporary multiline-import fixture file before this change landed (see the commit body).
    const FORBIDDEN_EVENT_BUS_SPECIFIER = /["'](?:\.\.\/)+lib\/event-bus(?:\.js)?["']/;
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(FORBIDDEN_EVENT_BUS_SPECIFIER.test(source)).toBe(false);
    }
  });

  // ── (d) GET /api/weather never 5xx across the failure matrix ──────────────────────

  describe("GET /api/weather never 5xx across the failure matrix", () => {
    async function injectWeatherGet(deviceKey: string): Promise<{ status: number }> {
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/weather",
          cookies: { mp_device_key: deviceKey },
        });
        return { status: res.statusCode };
      } finally {
        await app.close();
      }
    }

    it("a hang (aborted at the 5s budget) -> 200, never a 5xx", async () => {
      seedWeatherLocation(0, 0);
      const { buildForecastPort, __setForecastPortForTests } =
        await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: URL, opts: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "TimeoutError"));
              });
            })
        )
      );
      __setForecastPortForTests(
        buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined })
      );

      const { status } = await injectWeatherGet(seedDeviceKey());
      expect(status).toBe(200);
    }, 8000);

    it("a 500 upstream response -> 200, never a 5xx", async () => {
      seedWeatherLocation(0, 0);
      const { buildForecastPort, __setForecastPortForTests } =
        await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("server error", { status: 500 })))
      );
      __setForecastPortForTests(
        buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined })
      );

      const { status } = await injectWeatherGet(seedDeviceKey());
      expect(status).toBe(200);
    });

    it("a malformed (non-JSON) upstream body -> 200, never a 5xx", async () => {
      seedWeatherLocation(0, 0);
      const { buildForecastPort, __setForecastPortForTests } =
        await import("../../src/server/modules/weather/port");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("not json{{{", { status: 200 })))
      );
      __setForecastPortForTests(
        buildForecastPort({ endpoint: "https://fixture.example", enabled: undefined })
      );

      const { status } = await injectWeatherGet(seedDeviceKey());
      expect(status).toBe(200);
    });

    it("an INVALID operator-configured endpoint (deploy-time typo) -> 200, never a 5xx", async () => {
      seedWeatherLocation(0, 0);
      const { buildForecastPort, __setForecastPortForTests } =
        await import("../../src/server/modules/weather/port");
      // A URL-invalid base ("not a url at all") throws synchronously out of `new URL(...)`
      // inside `buildForecastUrl` — the exact P2 review scenario port.ts's own docblock
      // covers; asserted here at the ROUTE boundary rather than the port unit.
      __setForecastPortForTests(
        buildForecastPort({ endpoint: "not a url at all", enabled: undefined })
      );

      const { status } = await injectWeatherGet(seedDeviceKey());
      expect(status).toBe(200);
    });
  });

  // ── (e) WEATHER_LAT/WEATHER_LON env set -> still off through the REAL HTTP read path ─
  //
  // Unit-level coverage of "no environment fallback" (readWeatherLocation called
  // directly) already lives in tests/boundary/weather-location.test.ts ("WEATHER_LAT/
  // WEATHER_LON env set" describe block) — this adds the HTTP-boundary layer that file
  // doesn't: the REAL GET /api/weather route, through the REAL device-key gate, with zero
  // port invocations, never duplicating those unit assertions.

  describe("WEATHER_LAT/WEATHER_LON env set", () => {
    const ORIGINAL_LAT = process.env.WEATHER_LAT;
    const ORIGINAL_LON = process.env.WEATHER_LON;

    afterEach(() => {
      if (ORIGINAL_LAT === undefined) delete process.env.WEATHER_LAT;
      else process.env.WEATHER_LAT = ORIGINAL_LAT;
      if (ORIGINAL_LON === undefined) delete process.env.WEATHER_LON;
      else process.env.WEATHER_LON = ORIGINAL_LON;
    });

    it("FR-008: GET /api/weather still returns {forecast: null} with ZERO port calls when no App Settings row is persisted, even with the legacy env vars set", async () => {
      process.env.WEATHER_LAT = "40.4168";
      process.env.WEATHER_LON = "-3.7038";

      const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
      const portSpy = vi.fn(async () => null);
      __setForecastPortForTests(portSpy);

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
        expect(portSpy).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  });
});
