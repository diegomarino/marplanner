// ─────────────────────────────────────────────────────────────────────
// Weather forecast normalization — raw
// Open-Meteo `/v1/forecast` JSON -> the closed `ForecastResult` shape
// `src/shared/weather.ts` defines. Pure: no I/O, no clock (the raw
// payload already carries household-tz-local time/date strings because
// the port always requests `timezone=<household IANA>` — WEATHER-INV-04
// — so this module does no timezone math of its own, only field
// selection + shape validation).
//
// Source: docs/features/weather.md "Shared DTOs" +
// docs/features/weather.md.
// ─────────────────────────────────────────────────────────────────────

import {
  clampRainPct,
  conditionKeyForCode,
  type ForecastCurrent,
  type ForecastDay,
  type ForecastHour,
  type ForecastResult,
} from "../../../shared";

/** Reason codes for a normalization failure — surfaced verbatim in the port's telemetry
 * `data.reason` field so `forecast_fetch_failed` rows stay low-cardinality
 * and distinguishable (missing-daily is its own named failure mode in the test matrix,
 * distinct from a generically malformed body).
 */
export type WeatherNormalizeFailureReason = "missing_current" | "missing_hourly" | "missing_daily";

export class WeatherNormalizeError extends Error {
  readonly reason: WeatherNormalizeFailureReason;

  constructor(reason: WeatherNormalizeFailureReason) {
    super(`weather normalize: ${reason}`);
    this.name = "WeatherNormalizeError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** WMO code field may arrive as `weather_code` (current API) — malformed/absent -> "unknown". */
function conditionKeyFromRaw(value: unknown): ForecastCurrent["conditionKey"] {
  return typeof value === "number" ? conditionKeyForCode(value) : conditionKeyForCode(NaN);
}

function normalizeCurrent(
  raw: unknown,
  hourly: { time: string[]; precipitationProbability: number[] }
): ForecastCurrent {
  if (!isRecord(raw)) throw new WeatherNormalizeError("missing_current");
  const time = typeof raw.time === "string" ? raw.time : undefined;

  // The `current` block has no probability-of-rain field of its own (Open-Meteo only
  // publishes precipitation PROBABILITY on the hourly/daily blocks) — the current hour's
  // hourly entry stands in for "now"the rain probability. `current.time` is snapped to
  // 15-MINUTE granularity ("2026-09-04T21:45") while `hourly.time` is always on the hour
  // ("2026-09-04T21:00") — an exact string match therefore misses ~3 of every 4 renders and
  // silently fell back to hourly[0] (midnight, #74b2bae). Match on the HOUR
  // prefix instead ("YYYY-MM-DDTHH", the first 13 characters both forms share).
  const hourPrefix = time ? time.slice(0, 13) : undefined;
  const hourIndex = hourPrefix ? hourly.time.findIndex((t) => t.slice(0, 13) === hourPrefix) : -1;
  const rainSource =
    hourIndex >= 0
      ? hourly.precipitationProbability[hourIndex]
      : (hourly.precipitationProbability[0] ?? 0);

  return {
    conditionKey: conditionKeyFromRaw(raw.weather_code),
    tempC: asNumber(raw.temperature_2m),
    rainPct: clampRainPct(asNumber(rainSource)),
  };
}

function normalizeHourlyBlock(raw: unknown): {
  time: string[];
  precipitationProbability: number[];
  entries: ForecastHour[];
} {
  if (!isRecord(raw)) throw new WeatherNormalizeError("missing_hourly");
  const time = Array.isArray(raw.time) ? (raw.time as unknown[]) : undefined;
  if (!time) throw new WeatherNormalizeError("missing_hourly");

  const temperature = Array.isArray(raw.temperature_2m) ? (raw.temperature_2m as unknown[]) : [];
  const precipitationProbability = Array.isArray(raw.precipitation_probability)
    ? (raw.precipitation_probability as unknown[])
    : [];
  const weatherCode = Array.isArray(raw.weather_code) ? (raw.weather_code as unknown[]) : [];

  const timeStrings = time.map((t) => (typeof t === "string" ? t : ""));
  const rainPcts = timeStrings.map((_, i) => asNumber(precipitationProbability[i]));

  const entries: ForecastHour[] = timeStrings
    .filter((t) => t.length > 0)
    .map((t, i) => ({
      time: t,
      conditionKey: conditionKeyFromRaw(weatherCode[i]),
      tempC: asNumber(temperature[i]),
      rainPct: clampRainPct(rainPcts[i]),
    }));

  return { time: timeStrings, precipitationProbability: rainPcts, entries };
}

function normalizeDaily(raw: unknown): ForecastDay[] {
  if (!isRecord(raw)) throw new WeatherNormalizeError("missing_daily");
  const time = Array.isArray(raw.time) ? (raw.time as unknown[]) : undefined;
  if (!time) throw new WeatherNormalizeError("missing_daily");

  const weatherCode = Array.isArray(raw.weather_code) ? (raw.weather_code as unknown[]) : [];
  const tempMax = Array.isArray(raw.temperature_2m_max)
    ? (raw.temperature_2m_max as unknown[])
    : [];
  const tempMin = Array.isArray(raw.temperature_2m_min)
    ? (raw.temperature_2m_min as unknown[])
    : [];
  const rainMax = Array.isArray(raw.precipitation_probability_max)
    ? (raw.precipitation_probability_max as unknown[])
    : [];

  return time
    .map((t, i) => ({ t, i }))
    .filter((entry): entry is { t: string; i: number } => typeof entry.t === "string")
    .map(({ t, i }) => ({
      date: t,
      conditionKey: conditionKeyFromRaw(weatherCode[i]),
      tempMaxC: asNumber(tempMax[i]),
      tempMinC: asNumber(tempMin[i]),
      rainPct: clampRainPct(asNumber(rainMax[i])),
    }));
}

/** Normalize a raw Open-Meteo `/v1/forecast` response into the closed `ForecastResult` shape.
 * Throws `WeatherNormalizeError` when `current`, `hourly`, or `daily` is absent/malformed —
 * the port catches this and treats it exactly like any other fetch failure (null + one
 * telemetry row, WEATHER-INV-10/12), never propagating a normalization exception to a caller.
 */
export function normalizeForecast(raw: unknown): ForecastResult {
  if (!isRecord(raw)) throw new WeatherNormalizeError("missing_current");

  const hourlyBlock = normalizeHourlyBlock(raw.hourly);
  const current = normalizeCurrent(raw.current, {
    time: hourlyBlock.time,
    precipitationProbability: hourlyBlock.precipitationProbability,
  });
  const daily = normalizeDaily(raw.daily);

  return {
    current,
    hourly: hourlyBlock.entries,
    daily,
  };
}
