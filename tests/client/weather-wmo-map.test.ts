import { describe, it, expect } from "vitest";
import {
  WMO_CONDITION_MAP,
  conditionKeyForCode,
  clampRainPct,
  type WeatherConditionKey,
} from "../../src/shared/weather";

/** docs/features/weather.md — golden-table tests for the shared WMO condition map and
 * the rain-probability clamp helper ("Shared DTOs"). Pure
 * module: no server, no DB, no fetch — just the table and the two helpers built over it.
 */

const VALID_KEYS: readonly WeatherConditionKey[] = [
  "clear",
  "mostlyClear",
  "partlyCloudy",
  "overcast",
  "fog",
  "drizzle",
  "freezingDrizzle",
  "rain",
  "freezingRain",
  "snow",
  "snowGrains",
  "rainShowers",
  "snowShowers",
  "thunderstorm",
  "thunderstormHail",
  "unknown",
];

// The full WMO 4677 "present weather" code table Open-Meteo's weathercode field returns.
const EXPECTED_WMO_CODES = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86,
  95, 96, 99,
];

describe("WMO_CONDITION_MAP", () => {
  it("every mapped WMO code resolves to a WeatherConditionKey union member", () => {
    for (const [code, key] of Object.entries(WMO_CONDITION_MAP)) {
      expect(VALID_KEYS).toContain(key);
      expect(conditionKeyForCode(Number(code))).toBe(key);
    }
  });

  it("covers the full documented WMO 4677 code table, one entry per code", () => {
    for (const code of EXPECTED_WMO_CODES) {
      expect(WMO_CONDITION_MAP[code]).toBeDefined();
    }
    expect(Object.keys(WMO_CONDITION_MAP)).toHaveLength(EXPECTED_WMO_CODES.length);
  });

  it("an unmapped/unknown code resolves to 'unknown', never throws", () => {
    expect(conditionKeyForCode(9999)).toBe("unknown");
    expect(conditionKeyForCode(-1)).toBe("unknown");
    expect(conditionKeyForCode(4)).toBe("unknown"); // a gap in the real table
  });
});

describe("clampRainPct (WEATHER-INV-07)", () => {
  it("passes the edges 0 and 100 through unchanged", () => {
    expect(clampRainPct(0)).toBe(0);
    expect(clampRainPct(100)).toBe(100);
  });

  it("clamps a negative value to 0", () => {
    expect(clampRainPct(-5)).toBe(0);
    expect(clampRainPct(-0.4)).toBe(0);
  });

  it("clamps a value above 100 to 100", () => {
    expect(clampRainPct(101)).toBe(100);
    expect(clampRainPct(250)).toBe(100);
  });

  it("rounds a fractional value to the nearest integer before clamping", () => {
    expect(clampRainPct(42.4)).toBe(42);
    expect(clampRainPct(42.5)).toBe(43);
    expect(clampRainPct(42.6)).toBe(43);
    expect(clampRainPct(99.6)).toBe(100);
  });

  it("is non-finite-safe: NaN/Infinity/-Infinity resolve to 0, never propagate (016-review P3-3)", () => {
    expect(clampRainPct(NaN)).toBe(0);
    expect(clampRainPct(Infinity)).toBe(0);
    expect(clampRainPct(-Infinity)).toBe(0);
  });
});
