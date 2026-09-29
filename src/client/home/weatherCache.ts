/** Browser forecast cache keyed by exact coordinates and schema version, with a
 * 30-minute TTL. Changing location selects a different key, so old coordinates
 * cannot supply the new location's forecast.
 */
import type { ForecastResult } from "../../shared";

/** Weather browser cache — `localStorage` keyed by the exact
 * coordinate pair plus a schema version, with a 30-minute TTL. The key IS the invalidation:
 * changing the household location changes the key, so a stale coordinate's cache entry is
 * simply unreachable — no explicit cache-clearing code path exists to forget
 * (WEATHER-INV-11/AC-06).
 * docs/features/weather.md.
 */

export interface WeatherCacheEntry {
  /** epoch ms */
  fetchedAt: number;
  result: ForecastResult;
}

/** Schema version — bumping this orphans every entry under the old prefix as a harmless miss. */
const CACHE_SCHEMA_VERSION = "v1";

export const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;

export function weatherCacheKey(lat: number, lon: number): string {
  return `mp:weather:${CACHE_SCHEMA_VERSION}:${lat},${lon}`;
}

/** Read a still-fresh cache entry for the given coordinates, or `null` on a miss, an expired
 * entry, a schema-version orphan, or ANY localStorage failure (private-mode, quota, disabled
 * storage) — failure-open: the caller always falls back to fetching (never throws).
 */
export function readWeatherCache(lat: number, lon: number, now: number): WeatherCacheEntry | null {
  try {
    const raw = window.localStorage.getItem(weatherCacheKey(lat, lon));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WeatherCacheEntry>;
    if (typeof parsed.fetchedAt !== "number" || !parsed.result) return null;
    if (now - parsed.fetchedAt > WEATHER_CACHE_TTL_MS) return null;
    return parsed as WeatherCacheEntry;
  } catch {
    return null;
  }
}

/** Best-effort write — a storage failure is silently dropped (failure-open, never throws). */
export function writeWeatherCache(lat: number, lon: number, entry: WeatherCacheEntry): void {
  try {
    window.localStorage.setItem(weatherCacheKey(lat, lon), JSON.stringify(entry));
  } catch {
    /* failure-open: quota exceeded / private mode / storage disabled */
  }
}

/** Monotonic in-flight-fetch guard (the `ChoresBoard.tsx` `generationRef` precedent) — a
 * response for coordinates the caller has since changed away from is discarded. Factored out
 * of the React component so it is unit-testable without rendering (`weather-cache.test.ts`).
 */
export interface WeatherFetchGuard {
  /** Call when starting a new fetch; returns this fetch's generation id. */
  next(): number;
  /** True only for the MOST RECENTLY started fetch's generation. */
  isCurrent(generation: number): boolean;
}

export function createWeatherFetchGuard(): WeatherFetchGuard {
  let current = 0;
  return {
    next: () => (current += 1),
    isCurrent: (generation: number) => generation === current,
  };
}
