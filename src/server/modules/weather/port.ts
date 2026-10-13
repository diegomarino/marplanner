// ─────────────────────────────────────────────────────────────────────
// Forecast port — the ONE injectable
// seam between the server and the outbound weather provider. Reached only
// through `getForecastPort`; `routes/weather.ts` never calls `fetch`
// itself and never knows the provider's URL shape.
//
// Source: docs/features/weather.md (seam shape, test-flag throw),
// D10 (telemetry identity); docs/features/weather.md FR-011..013/021.
// ─────────────────────────────────────────────────────────────────────

import { getOperatorConfig, isTestRuntime, writeClientLog } from "../../host-api";
import type { ForecastResult, WeatherLocation } from "../../../shared";
import { normalizeForecast, WeatherNormalizeError } from "./normalize";

/** `null` = unconfigured/disabled/failed — the caller always renders absence, never a throw. */
export type ForecastPort = (loc: WeatherLocation, tz: string) => Promise<ForecastResult | null>;

const DEFAULT_BASE_URL = "https://api.open-meteo.com";
const FETCH_TIMEOUT_MS = 5000;

// Fixed variable-selector constants: the ONLY request-dependent
// values are lat/lon/timezone (FR-012) — these three lists are NOT user- or household-
// supplied, so they carry no SSRF/abuse surface; without them Open-Meteo returns no weather
// fields at all and a healthy deployment would render permanent absence.
const CURRENT_VARS = "temperature_2m,weather_code,is_day,relative_humidity_2m,wind_speed_10m";
const HOURLY_VARS = "temperature_2m,precipitation_probability,weather_code,is_day";
const DAILY_VARS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset";

/** Telemetry producer identity — a synthetic, hand-written string that can
 * never collide with a real device/API key id (those are DB-generated UUIDs). `writeClientLog`
 * uses this value ONLY as the flood-window bucket key (`admitUnderFloodBound`, no FK, no
 * column stores it) — so a forecast-fetch storm is isolated in its OWN 600-per-5-minutes
 * budget, never borrowing from or exhausting any real kiosk key's budget. Decision recorded
 * here per the trap-sweep probe.
 */
const TELEMETRY_PRODUCER_ID = "system:weather-forecast-port";

export type WeatherFetchFailureReason =
  | "invalid_endpoint"
  | "timeout"
  | "network_error"
  | "http_status"
  | "malformed_response"
  | WeatherNormalizeError["reason"];

/** `AbortSignal.timeout(FETCH_TIMEOUT_MS)` firing rejects `fetch` with a `DOMException` named
 * `"TimeoutError"`; a manually aborted signal (not used here, but the same family) would be
 * `"AbortError"`. Anything else — DNS failure, connection refused, TLS error — is a genuine
 * network-level rejection, kept as its own `network_error` reason so the two failure MODES
 * stay distinguishable in telemetry.
 */
function isAbortOrTimeoutError(err: unknown): boolean {
  // Duck-typed on `.name` rather than `instanceof Error`/`instanceof DOMException`: the test
  // environment's DOMException can come from a different realm (jsdom vs Node) than the
  // `Error`/`DOMException` globals this module closes over, making `instanceof` unreliable —
  // empirically verified false-negative in this exact suite (a real DOMException named
  // "AbortError" failed `instanceof Error` here).
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function recordFetchFailure(url: URL, reason: WeatherFetchFailureReason, status?: number): void {
  writeClientLog(TELEMETRY_PRODUCER_ID, [
    {
      level: "warn",
      component: "weather",
      message: "forecast_fetch_failed",
      data: { reason, status, endpointHost: url.host },
    },
  ]);
}

/** Telemetry for a failure that happens BEFORE a `URL` object exists (safety an invalid
 * operator-configured `WEATHER_ENDPOINT` throws synchronously out of `new URL(...)`, so there
 * is no `.host` to extract) — logs the raw configured string instead.
 */
function recordInvalidEndpoint(rawBaseUrl: string): void {
  const reason: WeatherFetchFailureReason = "invalid_endpoint";
  writeClientLog(TELEMETRY_PRODUCER_ID, [
    {
      level: "warn",
      component: "weather",
      message: "forecast_fetch_failed",
      data: { reason, endpointHost: rawBaseUrl },
    },
  ]);
}

function buildForecastUrl(baseUrl: string, loc: WeatherLocation, tz: string): URL {
  const url = new URL("/v1/forecast", baseUrl);
  url.searchParams.set("latitude", String(loc.lat));
  url.searchParams.set("longitude", String(loc.lon));
  // WEATHER-INV-04: the household timezone is ALWAYS sent explicitly — never `auto`, never
  // omitted (which defaults the provider to UTC/`auto` behavior depending on the endpoint).
  url.searchParams.set("timezone", tz);
  url.searchParams.set("current", CURRENT_VARS);
  url.searchParams.set("hourly", HOURLY_VARS);
  url.searchParams.set("daily", DAILY_VARS);
  return url;
}

async function fetchAndNormalize(
  baseUrl: string,
  loc: WeatherLocation,
  tz: string
): Promise<ForecastResult | null> {
  // safety a non-empty but INVALID `WEATHER_ENDPOINT` (a deploy-time typo) throws
  // synchronously out of `new URL(...)` — caught here, separately from the fetch try/catch
  // below (no URL object exists yet to extract `endpointHost` from), so a bad operator
  // config degrades to absence + telemetry instead of a 500 (WEATHER-INV-10/12).
  let url: URL;
  try {
    url = buildForecastUrl(baseUrl, loc, tz);
  } catch {
    recordInvalidEndpoint(baseUrl);
    return null;
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    // Best-effort, WEATHER-INV-10: the failure never propagates, it becomes absence — but the
    // REASON still distinguishes a timed-out/aborted request from a genuine network-level
    // rejection (DNS, connection refused, TLS) so telemetry doesn't conflate the two modes.
    recordFetchFailure(url, isAbortOrTimeoutError(err) ? "timeout" : "network_error");
    return null;
  }

  if (!res.ok) {
    recordFetchFailure(url, "http_status", res.status);
    return null;
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    recordFetchFailure(url, "malformed_response", res.status);
    return null;
  }

  try {
    return normalizeForecast(raw);
  } catch (err) {
    const reason = err instanceof WeatherNormalizeError ? err.reason : "malformed_response";
    recordFetchFailure(url, reason, res.status);
    return null;
  }
}

/** Always-null port (operator kill-switch) — zero fetch calls, ever. */
const NULL_PORT: ForecastPort = async () => null;

interface ForecastPortConfig {
  endpoint: string | undefined;
  enabled: string | undefined;
}

/** Build a `ForecastPort` from resolved operator config — pure with respect to I/O timing
 * (the returned function is what performs the fetch), and directly unit-testable without
 * the `isTestRuntime` throw below (matrix: disabled -> null-port with zero calls;
 * healthy/failure behavior against an injected `baseUrl`).
 */
export function buildForecastPort(config: ForecastPortConfig): ForecastPort {
  // FR-013: operator-disableable — never from any household settings surface.
  if (config.enabled === "false") return NULL_PORT;

  const baseUrl =
    config.endpoint && config.endpoint.length > 0 ? config.endpoint : DEFAULT_BASE_URL;
  return (loc, tz) => fetchAndNormalize(baseUrl, loc, tz);
}

/** The production factory: reads `getOperatorConfig` for `weather.endpoint` /
 * `weather.enabled` and builds the real port. Constructing it while `isTestRuntime` is true
 * THROWS immediately — a forgotten `__setForecastPortForTests` injection in a test must fail
 * loud and instant, never fall through to a real (CI-forbidden) network call that would
 * otherwise just hang toward the suite's timeout.
 */
export function createOpenMeteoPort(): ForecastPort {
  if (isTestRuntime()) {
    throw new Error(
      "createOpenMeteoPort(): refusing to construct a real fetch-based port under the test " +
        "runtime — inject a port via __setForecastPortForTests() instead (research D4)."
    );
  }
  return buildForecastPort({
    endpoint: getOperatorConfig("weather.endpoint"),
    enabled: getOperatorConfig("weather.enabled"),
  });
}

let testPortOverride: ForecastPort | undefined;

/** Test-only injection seam (the `logger.ts` `__setTransportForTests` precedent). */
export function __setForecastPortForTests(port: ForecastPort | undefined): void {
  testPortOverride = port;
}

/** The single entrypoint `routes/weather.ts` calls. Prefers an injected test port when one is
 * set; otherwise falls through to `createOpenMeteoPort` — which throws under the test
 * runtime if no injection was ever made (see above).
 */
export function getForecastPort(): ForecastPort {
  if (testPortOverride !== undefined) return testPortOverride;
  return createOpenMeteoPort();
}
