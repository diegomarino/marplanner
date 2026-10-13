// ─────────────────────────────────────────────────────────────────────
// Weather DTOs + the canonical WMO condition-code table — pure: no I/O,
// no clock, no imports beyond shared.
// These shared DTOs describe weather settings and forecast presentation.
//
// ONE table serves BOTH surfaces (the kiosk pill and the Daily Briefing
// block, WEATHER-INV-06/AC-04) — v1 shipped two condition maps that could
// (and did) drift; a single shared pure module both sides import is the
// fix.
// ─────────────────────────────────────────────────────────────────────

/** WeatherConditionKey — closed union rendered through i18n
 * (`t("weather.condition.<key>")`) by both surfaces. `unknown` is the
 * catch-all for a WMO code the table doesn't recognize — never a crash,
 * never raw English (WEATHER-INV-06/AC-04).
 */
export type WeatherConditionKey =
  | "clear"
  | "mostlyClear"
  | "partlyCloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "freezingDrizzle"
  | "rain"
  | "freezingRain"
  | "snow"
  | "snowGrains"
  | "rainShowers"
  | "snowShowers"
  | "thunderstorm"
  | "thunderstormHail"
  | "unknown";

/** WMO_CONDITION_MAP — the full WMO 4677 "present weather" code table (the
 * codes Open-Meteo's `weathercode`/`weather_code` fields return), mapped to
 * the closed `WeatherConditionKey` union. A code absent from this table (or
 * any non-numeric input) resolves to `"unknown"` via `conditionKeyForCode`
 * below — never a thrown error, never an unrendered value.
 */
export const WMO_CONDITION_MAP: Record<number, WeatherConditionKey> = {
  0: "clear",
  1: "mostlyClear",
  2: "partlyCloudy",
  3: "overcast",
  45: "fog",
  48: "fog",
  51: "drizzle",
  53: "drizzle",
  55: "drizzle",
  56: "freezingDrizzle",
  57: "freezingDrizzle",
  61: "rain",
  63: "rain",
  65: "rain",
  66: "freezingRain",
  67: "freezingRain",
  71: "snow",
  73: "snow",
  75: "snow",
  77: "snowGrains",
  80: "rainShowers",
  81: "rainShowers",
  82: "rainShowers",
  85: "snowShowers",
  86: "snowShowers",
  95: "thunderstorm",
  96: "thunderstormHail",
  99: "thunderstormHail",
};

/** WMO code → condition key; a code absent from the table resolves to `"unknown"`. */
export function conditionKeyForCode(code: number): WeatherConditionKey {
  return WMO_CONDITION_MAP[code] ?? "unknown";
}

/** WeatherLocation — the non-null coordinate pair the forecast port and
 * normalizer consume once a stored location has been read as complete
 * when a stored location is complete. Distinct from `WeatherSettingsObject`
 * below, which is the nullable at-rest shape the App Settings write
 * boundary persists (a location can be blank) — the openapi contract names
 * that nullable shape `WeatherLocation` too; the two are related but not
 * interchangeable, so this module keeps them as two named types.
 */
export interface WeatherLocation {
  lat: number;
  lon: number;
  label?: string;
}

/** WeatherSettingsObject — the `weather` App Settings object as persisted
 * and returned by GET/PUT `/api/settings`: both coordinates are nullable TOGETHER (a blank
 * location is `{lat: null, lon: null}` — clear-as-unit, WEATHER-INV-02),
 * optional free-text label.
 * `WeatherLocation` is the validated location shape.
 */
export interface WeatherSettingsObject {
  lat: number | null;
  lon: number | null;
  label?: string;
}

/** Current-conditions slice of a normalized forecast. */
export interface ForecastCurrent {
  conditionKey: WeatherConditionKey;
  tempC: number;
  rainPct: number;
  /** The optional fields below are absent when the provider omits them; a consumer renders
   * without them rather than treating the forecast as failed. */
  isDay?: boolean;
  /** Relative humidity, integer percent. */
  humidityPct?: number;
  windKmh?: number;
  /** Today's sunrise/sunset, ISO datetime, household tz. */
  sunrise?: string;
  sunset?: string;
}

/** One hourly entry of a normalized forecast. */
export interface ForecastHour {
  /** ISO datetime, household tz. */
  time: string;
  conditionKey: WeatherConditionKey;
  tempC: number;
  rainPct: number;
  /** Absent when the provider omits it. */
  isDay?: boolean;
}

/** One daily entry of a normalized forecast. */
export interface ForecastDay {
  /** YYYY-MM-DD, household tz (WEATHER-INV-04). */
  date: string;
  conditionKey: WeatherConditionKey;
  tempMinC: number;
  tempMaxC: number;
  rainPct: number;
}

/** The forecast port's/normalizer's output shape — never persisted server-side. */
export interface ForecastResult {
  current: ForecastCurrent;
  hourly: ForecastHour[];
  daily: ForecastDay[];
}

/** Integer rain-probability clamp (WEATHER-INV-07): rounds to the nearest
 * integer, then clamps into `[0, 100]`. Applied at normalization AND at
 * any render site that computes rather than passes a value through
 * unchanged. This is the designated INV-07 enforcement point, so it must be
 * safe against a non-finite input (`NaN`/`Infinity`/`-Infinity`) rather than
 * propagate one into a normalized payload — a malformed/missing upstream
 * field resolves to `0`, never `NaN`.
 */
export function clampRainPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `GET /api/weather`'s response body. `forecast: null` is silent absence —
 * blank location, operator-disabled, or a failed/timed-out fetch (WEATHER-INV-12) — NEVER
 * expressed as an HTTP error.
 * `WeatherResponse` is the API response shape.
 */
export interface WeatherResponse {
  forecast: ForecastResult | null;
}
