import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  Briefing,
  BriefingReadResult,
  ForecastResult,
  WeatherLocation,
} from "../../src/shared";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/weather.md — snapshot-freeze regression for the weather block
 * (FR-020, WEATHER-INV-09/AC-08). "Briefing weather block":
 * "frozen once written — regeneration is the only refresh". This test adds NO new
 * production code (trap-sweep) — it is a regression fence over the behavior; a
 * failure here means the bug is in `daily-briefing/index.ts`, not here.
 * Clock PINNED (Date only) so fixture date 2026-09-04 stays inside calendar
 * getEvents -30d/+365d window (de-time-bomb; same pattern as daily-briefing-generate).
 */
describe("daily-briefing weather block snapshot freeze", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let memberId: string;
  const date = "2026-09-04";

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    const now = Date.now();
    const db = getDb();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    memberId = `member-${now}`;

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`device-${now}`, hashKey(deviceKey), now);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(memberId, "Ada", now, now);
    db.prepare(
      "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
    ).run(memberId, now, now);
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
    ).run(JSON.stringify({ lat: 40.4, lon: -3.7 }), now);
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
    ).run(JSON.stringify({ timezone: "Europe/Madrid", language: "es", weekStartDay: 1 }), now);

    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(async (loc: WeatherLocation): Promise<ForecastResult | null> => {
      // Location-sensitive stub — proves a LATER (post-change) generation actually uses the
      // NEW coordinates rather than replaying an earlier cached result.
      const isLocationB = loc.lat === 51.5;
      return {
        current: { conditionKey: "clear", tempC: 20, rainPct: 5 },
        hourly: [],
        daily: [
          {
            date,
            conditionKey: isLocationB ? "rain" : "clear",
            tempMinC: isLocationB ? 8 : 18,
            tempMaxC: isLocationB ? 12 : 26,
            rainPct: isLocationB ? 80 : 5,
          },
        ],
      };
    });

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    __setForecastPortForTests(undefined);
    vi.useRealTimers();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  async function generate(): Promise<Briefing> {
    const response = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      cookies: auth(),
      payload: { memberId, date },
    });
    expect(response.statusCode).toBe(200);
    return response.json<Briefing>();
  }

  async function read(): Promise<BriefingReadResult> {
    const response = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/${date}`,
      cookies: auth(),
    });
    expect(response.statusCode).toBe(200);
    return response.json<BriefingReadResult>();
  }

  function weatherData(briefing: Briefing): unknown {
    return briefing.payload.blocks.find((block) => block.type === "weather")?.data;
  }

  it("stays byte-identical after a location change made through the real settings write; only regeneration reflects the new coordinates", async () => {
    const initial = await generate();
    expect(weatherData(initial)).toEqual({
      date,
      conditionKey: "clear",
      tempMinC: 18,
      tempMaxC: 26,
      rainPct: 5,
    });

    // FR-020: change the location THROUGH the real PUT /api/settings write (the
    // registry), never a direct SQL edit — proves the freeze survives the real boundary.
    //
    //: this write ALSO evicts the daily-briefing shared
    // cache's "weather" rows (`routes/settings.ts` -> `external/shared-cache.ts#
    // evictWeatherCache`) — without that eviction, the regeneration below would replay the
    // FIRST location's cached forecast instead of reflecting the change, regressing this
    // TRACED 016 guarantee (FR-020/SC-005/SC-008, WEATHER-INV-09/AC-08).
    const putResponse = await app.inject({
      method: "PUT",
      url: "/api/settings",
      cookies: auth(),
      payload: { object: "weather", settings: { lat: 51.5, lon: -0.1 } },
    });
    expect(putResponse.statusCode).toBe(200);

    const frozen = await read();
    expect(frozen).toEqual({ generated: true, briefing: initial, printedStatus: "none" });

    const regenerated = await generate();
    expect(regenerated.id).toBe(initial.id);
    expect(weatherData(regenerated)).toEqual({
      date,
      conditionKey: "rain",
      tempMinC: 8,
      tempMaxC: 12,
      rainPct: 80,
    });
    expect(weatherData(regenerated)).not.toEqual(weatherData(initial));

    // The regenerated snapshot is now what a subsequent read returns — the freeze applies
    // to each generation's OWN moment, not a permanent lock.
    await expect(read()).resolves.toEqual({
      generated: true,
      briefing: regenerated,
      printedStatus: "none",
    });
  });
});
