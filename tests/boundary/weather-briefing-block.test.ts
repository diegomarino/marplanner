import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Briefing, ForecastResult } from "../../src/shared";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { registerDailyBriefingJob } from "../../src/server/modules/daily-briefing/job";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/weather.md — Daily Briefing weather block boundary tests
 * (FR-018/019, WEATHER-INV-05/09/10/12). BLACK-BOX: the real HTTP surface
 * (`POST /api/daily-briefing/generate[-all]`) + `__setForecastPortForTests` injection,
 * exactly like `tests/boundary/weather-read.test.ts`. Trap-sweep: HIGHEST RISK —
 * `generateBriefing`/`generateAllBriefings` became async so the forecast can be resolved
 * BEFORE `db.transaction` opens (better-sqlite3 transactions are synchronous); a
 * `{status:"failed"}` weather block would flip a briefing to `partial` (INV-10/12
 * violation) — the no-block-on-failure branch is the load-bearing assertion below.
 */
describe("daily-briefing weather block", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;

  afterEach(async () => {
    await app?.close();
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test path — nothing to drain.
    }
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(undefined);
  });

  function seedDeviceKey(): string {
    const key = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`${Date.now()}-${Math.random().toString(36).slice(2)}-device`, hashKey(key), Date.now());
    return key;
  }

  function seedMember(id: string, name = "Ada"): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
      )
      .run(id, name, now, now);
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

  /** Upsert so a test can change the household tz mid-test (the two-batch proof). */
  function seedTimezone(tz: string): void {
    getDb()
      .prepare(
        `INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)
         ON CONFLICT(object_name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify({ timezone: tz, language: "en", weekStartDay: 1 }), Date.now());
  }

  function forecastWithDaily(daily: ForecastResult["daily"]): ForecastResult {
    return {
      current: { conditionKey: "clear", tempC: 20, rainPct: 5 },
      hourly: [],
      daily,
    };
  }

  async function buildAppWithKey(weatherState: "active" | "inactive" = "active"): Promise<void> {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "UPDATE plugin_activation_registry SET state = 'active', activated_at = ?, updated_at = ? WHERE plugin_id = 'daily-briefing'"
      )
      .run(now, now);
    getDb()
      .prepare(
        "UPDATE plugin_activation_registry SET state = ?, activated_at = ?, updated_at = ? WHERE plugin_id = 'weather'"
      )
      .run(weatherState, weatherState === "active" ? now : null, now);
    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
    deviceKey = seedDeviceKey();
  }

  async function generate(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      cookies: { mp_device_key: deviceKey },
      payload: body,
    });
  }

  /** Changes the household timezone through the REAL `PUT /api/settings` write boundary (never
   * a direct SQL edit) — needed so `routes/settings.ts`'s cache-eviction hook actually fires
   * (restore: `evictWeatherCache` triggers on a "locale" write too, since tz is
   * a genuine input to `getForecastPort(location, tz)`, not just a display concern). */
  async function putLocale(tz: string): Promise<void> {
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      cookies: { mp_device_key: deviceKey },
      payload: { object: "locale", settings: { timezone: tz, language: "en", weekStartDay: 1 } },
    });
    expect(response.statusCode).toBe(200);
  }

  it("selects the daily[] entry matching the briefing's household-local date", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async () =>
      forecastWithDaily([
        { date: "2026-09-03", conditionKey: "rain", tempMinC: 10, tempMaxC: 15, rainPct: 80 },
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
        { date: "2026-09-05", conditionKey: "overcast", tempMinC: 14, tempMaxC: 19, rainPct: 40 },
      ])
    );

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-09-04" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    const weatherBlock = briefing.payload.blocks.find((block) => block.type === "weather");
    //: envelope v2 blocks also carry `index`/`title` (re-stamped from the
    // effective order, which now includes every block the full registry generates for this
    // member — not just weather) — `toMatchObject` checks the fields THIS test cares about.
    expect(weatherBlock).toMatchObject({
      type: "weather",
      scope: "shared",
      status: "ok",
      data: { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
    });
  });

  it("skips the block when the requested date is absent from daily[] — never substitutes another day (horizon edge)", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async () =>
      forecastWithDaily([
        { date: "2026-09-10", conditionKey: "rain", tempMinC: 10, tempMaxC: 15, rainPct: 80 },
      ])
    );

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-09-04" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.some((block) => block.type === "weather")).toBe(false);
    expect(briefing.status).toBe("ready");
  });

  it("omits both Weather content sources while the peer is inactive without calling its provider", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    const portSpy = vi.fn(async () =>
      forecastWithDaily([
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      ])
    );
    __setForecastPortForTests(portSpy);

    await buildAppWithKey("inactive");
    const response = await generate({ memberId: "m1", date: "2026-09-04" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.some(({ type }) => type === "weather")).toBe(false);
    expect(briefing.payload.blocks.some(({ type }) => type === "weatherText")).toBe(false);
    expect(briefing.status).toBe("ready");
    expect(portSpy).not.toHaveBeenCalled();
  });

  it("a forecast port failure adds NO block (never {status:failed}) and leaves status unchanged", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async () => null);

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-09-04" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.some((block) => block.type === "weather")).toBe(false);
    // A quiet day with no other blocks either — status must stay "ready", never "partial".
    expect(briefing.status).toBe("ready");
  });

  it("a REJECTING forecast port (a rejected promise, not just a resolved null) adds NO block and leaves status unchanged (651-review P2-1)", async () => {
    // Distinct from the resolved-null case above: this exercises resolveWeatherBlock's
    // defensive try/catch around `await resolveForecast(...)` — the production port itself
    // never throws (port.ts catches every failure mode internally), but a future regression
    // that lets a rejection escape must still degrade to silent absence, never a 500 and
    // never a `{status:"failed"}` block (WEATHER-INV-10/12).
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(() => Promise.reject(new Error("boom")));

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-09-04" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.some((block) => block.type === "weather")).toBe(false);
    expect(briefing.status).toBe("ready");
  });

  it("a corrupt (malformed-JSON) weather settings row adds NO block, never a 500 (Codex review PR #659 P2-2)", async () => {
    // readWeatherLocation (src/server/modules/weather/index.ts) now guards its own
    // JSON.parse — a row this malformed is unreachable through the validated PUT boundary,
    // but the briefing generator must not assume the DB can only ever hold a well-formed
    // row (a hand-edit, a migration bug, disk corruption). Before this fix the guard lived
    // only in routes/weather.ts, so this exact scenario 500'd manual/scheduled generation
    // instead of degrading to silent absence.
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run("{not valid json{{{", Date.now());
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    const portSpy = vi.fn(async () => null);
    __setForecastPortForTests(portSpy);

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-09-04" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.some((block) => block.type === "weather")).toBe(false);
    expect(briefing.status).toBe("ready");
    // A corrupt row reads as a BLANK location, never reaching the port at all.
    expect(portSpy).not.toHaveBeenCalled();
  });

  it("a hemisphere-split household (Madrid coords, Pacific/Auckland tz) requests the household tz and selects THAT date", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Pacific/Auckland");
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    let capturedTz: string | undefined;
    __setForecastPortForTests(async (_loc, tz) => {
      capturedTz = tz;
      return forecastWithDaily([
        { date: "2026-09-05", conditionKey: "snow", tempMinC: -2, tempMaxC: 2, rainPct: 60 },
      ]);
    });

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-09-05" });

    expect(response.statusCode).toBe(200);
    expect(capturedTz).toBe("Pacific/Auckland");
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.find((block) => block.type === "weather")?.data).toEqual({
      date: "2026-09-05",
      conditionKey: "snow",
      tempMinC: -2,
      tempMaxC: 2,
      rainPct: 60,
    });
  });

  it("a DST-transition day still matches by exact date string, no arithmetic drift", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid"); // DST ends 2026-10-25 (last Sunday of October).
    seedMember("m1");
    seedOptIn("m1");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async () =>
      forecastWithDaily([
        { date: "2026-10-24", conditionKey: "overcast", tempMinC: 8, tempMaxC: 14, rainPct: 50 },
        { date: "2026-10-25", conditionKey: "rain", tempMinC: 7, tempMaxC: 12, rainPct: 90 },
        {
          date: "2026-10-26",
          conditionKey: "partlyCloudy",
          tempMinC: 6,
          tempMaxC: 13,
          rainPct: 20,
        },
      ])
    );

    await buildAppWithKey();
    const response = await generate({ memberId: "m1", date: "2026-10-25" });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.payload.blocks.find((block) => block.type === "weather")?.data).toEqual({
      date: "2026-10-25",
      conditionKey: "rain",
      tempMinC: 7,
      tempMaxC: 12,
      rainPct: 90,
    });
  });

  it("memoizes per (lat,lon,date,tz) across generateAllBriefings — exactly one upstream call per batch", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1", "Ada");
    seedMember("m2", "Bo");
    seedOptIn("m1");
    seedOptIn("m2");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    const portSpy = vi.fn(async () =>
      forecastWithDaily([
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      ])
    );
    __setForecastPortForTests(portSpy);

    await buildAppWithKey();
    // buildApp stays scheduler-free (FR-015 structural gating) — wire a live singleton in
    // manually, exactly like tests/boundary/daily-briefing-optin-isolation.test.ts.
    initScheduler();
    registerDailyBriefingJob();

    const response = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate-all",
      cookies: { mp_device_key: deviceKey },
      payload: { date: "2026-09-04" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; count: number }>();
    expect(body.status).toBe("completed");
    expect(body.count).toBe(2);
    expect(portSpy).toHaveBeenCalledTimes(1);
  });

  it("the memo key includes tz — a household tz change evicts the shared weather cache, so the SAME date triggers a second upstream call (651-review P3-1; review fold P1-1 restore)", async () => {
    // `generateBriefing`'s third parameter is no longer an in-memory per-(lat,lon,date,tz) `Map`
    // (010/the `weatherMemo`, which never survived a process restart) — it is
    // `external/shared-cache.ts`'s `DailyBlockCache`, a `daily_briefing_block_cache` row keyed by
    // `(date, blockType)` alone (FR-019), restart-durable. tz is NOT part of that
    // key, but a household tz change is a genuine input change to `getForecastPort(location,
    // tz)` (not just a display concern) — so `routes/settings.ts`'s `PUT /api/settings` write
    // EVICTS the weather cache row on a "locale" write too, exactly like it does on a "weather"
    // (location) write (`evictWeatherCache`'s own doc comment). This restores the ORIGINAL
    // pre-019 guarantee (a tz change forces a fresh upstream call) through the NEW mechanism.
    seedWeatherLocation(40.4, -3.7);
    seedMember("m1", "Ada");
    seedMember("m2", "Bo");
    seedOptIn("m1");
    seedOptIn("m2");
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    const portSpy = vi.fn(async () =>
      forecastWithDaily([
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      ])
    );
    __setForecastPortForTests(portSpy);
    seedTimezone("Europe/Madrid");

    await buildAppWithKey();

    await generate({ memberId: "m1", date: "2026-09-04" });
    expect(portSpy).toHaveBeenCalledTimes(1);

    await putLocale("Pacific/Auckland");

    await generate({ memberId: "m2", date: "2026-09-04" });
    expect(portSpy).toHaveBeenCalledTimes(2);
  });

  it("a member archived WHILE the forecast await is pending (TOCTOU, Codex review PR #659 P2-1) writes NO snapshot — same outcome as a pre-archived member", async () => {
    seedWeatherLocation(40.4, -3.7);
    seedTimezone("Europe/Madrid");
    seedMember("m1");
    seedOptIn("m1");

    // A controlled, hand-releasable promise stands in for a slow upstream forecast fetch —
    // `portStarted` proves the port call has actually begun (the code is suspended on the
    // `await gate` below) before the test archives the member out from under it.
    let portStarted = false;
    let releasePort: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePort = resolve;
    });
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async () => {
      portStarted = true;
      await gate;
      return forecastWithDaily([
        { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      ]);
    });

    await buildAppWithKey();

    const generatePromise = generate({ memberId: "m1", date: "2026-09-04" });
    await vi.waitFor(() => {
      expect(portStarted).toBe(true);
    });

    // Archive the member WHILE the forecast fetch is still in flight — this is exactly the
    // race the post-await re-validation in generateBriefing (daily-briefing/index.ts) closes.
    getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run("m1");
    releasePort?.();

    const response = await generatePromise;

    // The SAME 400 a pre-archived member gets (tests/boundary/daily-briefing-generate.test.ts
    // "enforces opt-in and active lifecycle before any generation write") — never a stale
    // 200 snapshot for a member who lost eligibility mid-flight.
    expect(response.statusCode).toBe(400);
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?").get("m1")
    ).toEqual({ count: 0 });
  });
});
