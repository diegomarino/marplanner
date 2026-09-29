import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWeatherFetchGuard,
  readWeatherCache,
  weatherCacheKey,
  WEATHER_CACHE_TTL_MS,
  writeWeatherCache,
} from "@/home/weatherCache";
import type { ForecastResult } from "../../src/shared";

/** docs/features/weather.md — weather browser cache unit tests (* FR-017/WEATHER-INV-11/AC-06). Key change on A->B, TTL expiry (injected clock), in-flight
 * discard (generation guard), schema-version orphan.
 */
describe("weatherCache (T009)", () => {
  const forecast: ForecastResult = {
    current: { conditionKey: "clear", tempC: 20, rainPct: 5 },
    hourly: [],
    daily: [],
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  describe("weatherCacheKey — coordinate + schema version", () => {
    it("changes when coordinates change (A -> B)", () => {
      expect(weatherCacheKey(40.4, -3.7)).not.toBe(weatherCacheKey(41.0, -3.7));
      expect(weatherCacheKey(40.4, -3.7)).toBe("mp:weather:v1:40.4,-3.7");
    });
  });

  describe("readWeatherCache / writeWeatherCache", () => {
    it("a fresh write reads back within the TTL", () => {
      const now = 1_000_000;
      writeWeatherCache(40.4, -3.7, { fetchedAt: now, result: forecast });
      const entry = readWeatherCache(40.4, -3.7, now + 1_000);
      expect(entry).not.toBeNull();
      expect(entry!.result).toEqual(forecast);
    });

    it("a location change (A -> B) makes the A entry unreachable at B's key", () => {
      const now = 1_000_000;
      writeWeatherCache(40.4, -3.7, { fetchedAt: now, result: forecast });
      expect(readWeatherCache(41.0, -3.7, now)).toBeNull();
      // A's own key is still readable — only the DIFFERENT coordinate pair misses.
      expect(readWeatherCache(40.4, -3.7, now)).not.toBeNull();
    });

    it("TTL expiry (injected clock) — an entry older than 30 minutes is a miss", () => {
      const fetchedAt = 1_000_000;
      writeWeatherCache(40.4, -3.7, { fetchedAt, result: forecast });

      expect(readWeatherCache(40.4, -3.7, fetchedAt + WEATHER_CACHE_TTL_MS - 1)).not.toBeNull();
      expect(readWeatherCache(40.4, -3.7, fetchedAt + WEATHER_CACHE_TTL_MS + 1)).toBeNull();
    });

    it("schema-version orphan — an old-shaped key under a different version is a harmless miss", () => {
      // Simulate a pre-bump entry: written directly under a v0-prefixed key, never through
      // writeWeatherCache (which always writes the CURRENT version's key).
      window.localStorage.setItem(
        "mp:weather:v0:40.4,-3.7",
        JSON.stringify({ fetchedAt: Date.now(), result: forecast })
      );
      // The current reader looks up the v1 key — the v0 entry is simply unreadable, not
      // corrupt (WEATHER edge case: "Cache schema evolution").
      expect(readWeatherCache(40.4, -3.7, Date.now())).toBeNull();
    });

    it("a missing entry is a clean miss", () => {
      expect(readWeatherCache(0, 0, Date.now())).toBeNull();
    });

    it("a malformed stored value (bad JSON) is a clean miss, never a throw", () => {
      window.localStorage.setItem(weatherCacheKey(0, 0), "{not json");
      expect(() => readWeatherCache(0, 0, Date.now())).not.toThrow();
      expect(readWeatherCache(0, 0, Date.now())).toBeNull();
    });

    it("failure-open: a localStorage.getItem throw degrades to a miss, never propagates", () => {
      const original = window.localStorage.getItem;
      window.localStorage.getItem = () => {
        throw new Error("storage disabled");
      };
      try {
        expect(() => readWeatherCache(0, 0, Date.now())).not.toThrow();
        expect(readWeatherCache(0, 0, Date.now())).toBeNull();
      } finally {
        window.localStorage.getItem = original;
      }
    });

    it("failure-open: a localStorage.setItem throw (quota) is silently dropped, never propagates", () => {
      const original = window.localStorage.setItem;
      window.localStorage.setItem = () => {
        throw new Error("quota exceeded");
      };
      try {
        expect(() =>
          writeWeatherCache(0, 0, { fetchedAt: Date.now(), result: forecast })
        ).not.toThrow();
      } finally {
        window.localStorage.setItem = original;
      }
    });
  });

  describe("createWeatherFetchGuard — in-flight reordering discard (ChoresBoard.tsx precedent)", () => {
    it("only the most recently started generation is current", () => {
      const guard = createWeatherFetchGuard();
      const genA = guard.next();
      expect(guard.isCurrent(genA)).toBe(true);

      const genB = guard.next();
      // A stale in-flight response for the OLD coordinates (generation A) must be
      // discarded once a newer fetch (generation B) has started.
      expect(guard.isCurrent(genA)).toBe(false);
      expect(guard.isCurrent(genB)).toBe(true);
    });

    it("a generation id never issued is never current", () => {
      const guard = createWeatherFetchGuard();
      guard.next();
      expect(guard.isCurrent(999)).toBe(false);
    });
  });
});
