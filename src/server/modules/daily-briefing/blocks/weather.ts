/** Weather block (FR-013/FR-019).
 * WEATHER SEAM DECISION: already exposes exactly what this block needs through the
 * host-api barrel — `readWeatherLocation` + `getForecastPort` (both explicitly documented
 * there as the seam "the daily-briefing plugin resolves the household's location + forecast
 * port through", `src/server/host-api/index.ts`) — so this block reads through THAT existing
 * seam rather than defining a second `WeatherSource` port (the D6 fallback path — "if 016's
 * surface is insufficient the block calls its own port" — does not apply here: the surface IS
 * sufficient). No new Open-Meteo client, no `WeatherSource` type in `../external/ports.ts`.
 * This mirrors the ALREADY-MERGED inline resolver in `../index.ts`
 * (`resolveWeatherBlock`/`resolveForecast`) — same location → port → date-match shape — but
 * lives as a STANDALONE module under the new `blocks/` registry will wire up, deliberately
 * NOT importing from `../index.ts` (a queued path this module must not touch, and whose 010-era
 * inline resolver is exactly what the full-registry generation replaces).
 * Shared scope, cached per date (`getOrFetchOnceDaily`, `daily_briefing_block_cache` blockType
 * `"weather"`): at most one `getForecastPort` call per date per household, reused across every
 * member's briefing for that date (FR-019). A blank location resolves to `null` WITHOUT calling
 * the port — and that `null` IS cached, since an unconfigured location is a stable household
 * setting, not a transient failure.
 * (D3): `weather/port.ts` folds SEVERAL distinct causes into the same
 * `null` return — two of them are STABLE operator config, exactly like the blank-location case
 * above, not transient failures: the `weather.enabled === "false"` kill-switch (`NULL_PORT`,
 * zero fetch attempted) and a non-empty but INVALID `WEATHER_ENDPOINT` (`buildForecastUrl` throws
 * synchronously, caught inside `port.ts`). Both are deploy-time operator config that cannot
 * change between two calls in the same process, so — like the blank-location case — this block
 * detects them itself, BEFORE calling the port, mirroring `port.ts`'s own gates exactly
 * (`isWeatherSourceDisabled`/`hasInvalidConfiguredEndpoint` below), and treats their `null` as
 * cacheable. Only the REMAINING null-causes — timeout, network error, HTTP status, malformed
 * body — are genuine transient failures: those still make `getForecastPort` itself resolve to
 * `null` (since `port.ts` never throws for them either), so a `null` port result that survives
 * both stable-config gates above IS one of these transient causes, and this block re-throws so
 * `getOrFetchOnceDaily` does NOT cache it, letting the next generation pass retry rather than
 * being stuck on a transient outage until the date rolls over (FR-019 "no negative caching"). A
 * successful forecast with no `daily[]` entry for `date` resolves to `null` and IS cached — the
 * horizon genuinely does not cover this date, which would not change on an immediate retry.
 * that last "horizon-miss IS cached" rule only holds
 * for a `date` that is TODAY-OR-EARLIER (household-local): the near-term forecast horizon simply
 * does not cover that date and never will on retry, so caching is correct. For a FUTURE `date`
 * (an admin generating ahead of the household's scheduled day), a horizon miss instead means "this
 * date has not entered the provider's horizon YET" — a TRANSIENT condition that resolves itself
 * once the date is close enough. `daily_briefing_block_cache` has no eviction, so caching that
 * miss would poison the row forever: when the scheduled 06:00 pass for that date finally runs, it
 * would read the permanently-cached `null` instead of re-fetching, and the briefing would be
 * permanently weatherless. `generateWeatherBlock` therefore takes an explicit `now` (household-date
 * math needs a clock, per `readHouseholdTimezone`/`todayInHouseholdTz` convention — never a hidden
 * `Date.now` read) and only caches a horizon miss when `date <= todayInHouseholdTz(now)`; a
 * future-date miss throws instead (not cached), so the next generation pass — by which time the
 * date IS today and in horizon — retries.
 */
import {
  getForecastPort,
  getOperatorConfig,
  readHouseholdTimezone,
  readWeatherLocation,
  todayInHouseholdTz,
} from "../../../host-api";
import type { ForecastDay } from "../../../../shared";
import { getOrFetchOnceDaily, type DailyBlockCache } from "../external/shared-cache";

export type WeatherBlockData = ForecastDay;

const BLOCK_TYPE = "weather";

/** Mirrors `weather/port.ts`'s private default base URL — duplicated here ONLY for the
 * stable-vs-transient `null` classification below; this block never fetches
 * directly, `port.ts` still owns the actual request. Kept in lockstep by
 * `tests/integration/daily-briefing-blocks-external.test.ts` asserting against the SAME endpoint
 * behavior `tests/boundary/weather-forecast-port.test.ts` proves for `port.ts` itself.
 */
const DEFAULT_FORECAST_BASE_URL = "https://api.open-meteo.com";

/** residual gap: `weather.enabled`/`weather.endpoint` are OPERATOR (deploy-
 * time) config — `getOperatorConfig`/`process.env`-sourced, with NO HTTP write surface anywhere
 * in this codebase (unlike the household `weather` LOCATION object, whose write DOES evict the
 * shared cache — `external/shared-cache.ts#evictWeatherCache`, wired from
 * `routes/settings.ts`). A cached `null` from either gate below therefore has no eviction path:
 * flipping either env var requires a process RESTART to take effect at all (env vars don't
 * hot-reload), which already discards every in-memory Node state; only the PERSISTED
 * `daily_briefing_block_cache` row could theoretically outlive that restart and serve a stale
 * cached null for the rest of that calendar date. Accepted, documented limitation — not fixed
 * here, since there is no write path to hook eviction onto.
 */
/** `weather.enabled === "false"` is `port.ts`'s exact operator kill-switch gate. */
function isWeatherSourceDisabled(): boolean {
  return getOperatorConfig("weather.enabled") === "false";
}

/** Replicates `port.ts`'s `buildForecastUrl` validity check (`new URL("/v1/forecast", baseUrl)`)
 * without performing any fetch — an unset/empty `weather.endpoint` falls back to the same
 * default `port.ts` uses, which is always valid.
 */
function hasInvalidConfiguredEndpoint(): boolean {
  const endpoint = getOperatorConfig("weather.endpoint");
  const baseUrl = endpoint && endpoint.length > 0 ? endpoint : DEFAULT_FORECAST_BASE_URL;
  try {
    new URL("/v1/forecast", baseUrl);
    return false;
  } catch {
    return true;
  }
}

export async function generateWeatherBlock(
  cache: DailyBlockCache,
  date: string,
  now: number
): Promise<WeatherBlockData | null> {
  return getOrFetchOnceDaily(cache, BLOCK_TYPE, async () => {
    const location = readWeatherLocation();
    if (!location) return null;
    // Stable operator-config states — resolved WITHOUT calling the port, and
    // cacheable exactly like the blank-location case above.
    if (isWeatherSourceDisabled() || hasInvalidConfiguredEndpoint()) return null;
    const tz = readHouseholdTimezone();

    const forecast = await getForecastPort()(location, tz);
    if (!forecast) {
      // Having ruled out both stable-config gates above, a `null` port result here can only be
      // one of the genuinely transient causes (timeout/network/HTTP/malformed) — throw so the
      // combinator skips caching it, allowing the next generation pass to retry.
      throw new Error("daily-briefing.weather-block: forecast port returned null");
    }
    // Select the daily[] entry whose date matches the briefing's date exactly — never
    // substitute another day (same rule as the merged resolver, WEATHER-INV-05).
    const day = forecast.daily.find((entry) => entry.date === date);
    if (day) return day;

    // Horizon miss: cacheable only for today-or-earlier — a future date's
    // miss is transient (the date hasn't entered the horizon yet) and must NOT be cached, or a
    // later scheduled pass for that date would read a permanently-poisoned null.
    if (date <= todayInHouseholdTz(now)) return null;
    throw new Error(
      "daily-briefing.weather-block: forecast horizon does not yet cover a future date"
    );
  });
}
