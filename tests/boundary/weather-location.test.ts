import { describe, it, expect, afterEach } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import {
  WEATHER_DEFAULTS,
  validateWeather,
  readWeatherLocation,
} from "../../src/server/modules/weather/index";

/** docs/features/weather.md — weather location semantics (* "Settings objects" — `weather` row; FR-005..FR-008).
 * Covers what `tests/boundary/settings-write.test.ts` does not, since it exercises
 * the object registry as a whole over HTTP: the exact `[-90,90]`/`[-180,180]` range EDGES
 * (accept at the boundary, reject just past it), and the `readWeatherLocation` read-side
 * helper's distinct "STORED partial pair reads as blank" branch (never reachable via
 * `PUT /api/settings`, since `validateWeather` rejects a partial pair on write — this
 * module's raw-SQL seed below simulates a row that predates/bypasses that gate).
 */
describe("weather location semantics", () => {
  useIsolatedDb();

  function seedWeatherRow(data: Record<string, unknown>): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO settings_objects (object_name, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(object_name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run("weather", JSON.stringify(data), Date.now());
  }

  // ── validateWeather: range edges ────────────────────────────────────────

  it("accepts lat/lon exactly at the inclusive edges (+/-90, +/-180)", () => {
    expect(validateWeather({ lat: 90, lon: 180 })).toEqual({ lat: 90, lon: 180 });
    expect(validateWeather({ lat: -90, lon: -180 })).toEqual({ lat: -90, lon: -180 });
    expect(validateWeather({ lat: 90, lon: -180 })).toEqual({ lat: 90, lon: -180 });
    expect(validateWeather({ lat: -90, lon: 180 })).toEqual({ lat: -90, lon: 180 });
  });

  it("rejects lat/lon just past the edges (+/-90.01, +/-180.01)", () => {
    expect(validateWeather({ lat: 90.01, lon: 0 })).toBeNull();
    expect(validateWeather({ lat: -90.01, lon: 0 })).toBeNull();
    expect(validateWeather({ lat: 0, lon: 180.01 })).toBeNull();
    expect(validateWeather({ lat: 0, lon: -180.01 })).toBeNull();
  });

  // ── validateWeather: both-or-neither / clear-as-unit ───────────────────

  it("rejects a partial pair (lat without lon, and lon without lat)", () => {
    expect(validateWeather({ lat: 40, lon: null })).toBeNull();
    expect(validateWeather({ lat: null, lon: -3 })).toBeNull();
    expect(validateWeather({ lat: 40 })).toBeNull();
    expect(validateWeather({ lon: -3 })).toBeNull();
  });

  it("accepts both-null (or both-absent) as the blank state — clear-as-unit", () => {
    expect(validateWeather({ lat: null, lon: null })).toEqual(WEATHER_DEFAULTS);
    expect(validateWeather({})).toEqual(WEATHER_DEFAULTS);
  });

  // ── validateWeather: label ───────────────────────────────────────────────

  it("trims label whitespace and accepts up to 80 chars", () => {
    expect(validateWeather({ lat: 1, lon: 2, label: "  Madrid  " })).toEqual({
      lat: 1,
      lon: 2,
      label: "Madrid",
    });
    expect(validateWeather({ lat: 1, lon: 2, label: "x".repeat(80) })).toEqual({
      lat: 1,
      lon: 2,
      label: "x".repeat(80),
    });
  });

  it("rejects a label over 80 chars", () => {
    expect(validateWeather({ lat: 1, lon: 2, label: "x".repeat(81) })).toBeNull();
  });

  // ── readWeatherLocation: read-side semantics ────────────────────────────

  it("no persisted row -> null (blank, same as defaults)", () => {
    expect(readWeatherLocation()).toBeNull();
  });

  it("a complete persisted pair -> the WeatherLocation", () => {
    seedWeatherRow({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
    expect(readWeatherLocation()).toEqual({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
  });

  it("a complete persisted pair with no label omits the label key", () => {
    seedWeatherRow({ lat: 1, lon: 2 });
    expect(readWeatherLocation()).toEqual({ lat: 1, lon: 2 });
  });

  it("an explicit blank row ({lat:null, lon:null}) -> null", () => {
    seedWeatherRow({ lat: null, lon: null });
    expect(readWeatherLocation()).toBeNull();
  });

  // Distinct branch from reject-on-write: a STORED partial pair (never producible via
  // PUT /api/settings, since validateWeather rejects it — simulated here by writing the
  // row directly) reads as blank rather than throwing or half-rendering.
  it("a STORED partial pair (lat only) reads as blank, not a throw", () => {
    seedWeatherRow({ lat: 40.4168 });
    expect(readWeatherLocation()).toBeNull();
  });

  it("a STORED partial pair (lon only) reads as blank, not a throw", () => {
    seedWeatherRow({ lon: -3.7038 });
    expect(readWeatherLocation()).toBeNull();
  });

  // Same posture for a STORED out-of-range pair (also unreachable via PUT /api/settings,
  // since validateWeather range-checks first) — must not leak an invalid coordinate to a
  // future forecast provider call unfiltered.
  it("a STORED out-of-range pair (lat=999) reads as blank, not passed through", () => {
    seedWeatherRow({ lat: 999, lon: 0 });
    expect(readWeatherLocation()).toBeNull();
  });

  it("a STORED out-of-range pair (lon=-181) reads as blank, not passed through", () => {
    seedWeatherRow({ lat: 0, lon: -181 });
    expect(readWeatherLocation()).toBeNull();
  });

  // ── readWeatherLocation: no environment fallback (FR-008 / WEATHER-INV-03) ─────

  describe("WEATHER_LAT/WEATHER_LON env set", () => {
    const ORIGINAL_LAT = process.env.WEATHER_LAT;
    const ORIGINAL_LON = process.env.WEATHER_LON;

    afterEach(() => {
      if (ORIGINAL_LAT === undefined) delete process.env.WEATHER_LAT;
      else process.env.WEATHER_LAT = ORIGINAL_LAT;
      if (ORIGINAL_LON === undefined) delete process.env.WEATHER_LON;
      else process.env.WEATHER_LON = ORIGINAL_LON;
    });

    it("still reads as blank when no App Settings row is persisted (no env fallback)", () => {
      process.env.WEATHER_LAT = "40.4168";
      process.env.WEATHER_LON = "-3.7038";
      expect(readWeatherLocation()).toBeNull();
    });

    it("still reads as blank for a stored partial pair, even with env set", () => {
      process.env.WEATHER_LAT = "40.4168";
      process.env.WEATHER_LON = "-3.7038";
      seedWeatherRow({ lat: 40.4168 });
      expect(readWeatherLocation()).toBeNull();
    });
  });
});
