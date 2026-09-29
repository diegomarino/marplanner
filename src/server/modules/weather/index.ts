import { getDb } from "../../host-api";
import type { WeatherLocation, WeatherSettingsObject } from "../../../shared";

/** Weather location semantics for the `weather` settings object.
 * The settings registry in `src/server/modules/settings/index.ts` imports
 * `{WEATHER_DEFAULTS, validateWeather}` from this module instead of declaring
 * the schema itself. This creates no import cycle: the
 * `import-x/no-restricted-paths` zone in eslint.config.mjs restricts what
 * `src/server/modules/weather/* ` may import (own subtree + `../../host-api` only) — it
 * permits the settings module to import this module through its declared seam,
 * and this module never imports the settings module back.
 * This module also owns `readWeatherLocation`, the read-side helper for the
 * forecast port and daily-briefing block. Neither consumer is installed in B0.
 */

/** Defaults for a cold read (no persisted `weather` row) — a blank location. */
export const WEATHER_DEFAULTS: WeatherSettingsObject = { lat: null, lon: null };

const WEATHER_KEYS = new Set(["lat", "lon", "label"]);

function isValidLat(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLon(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `weather` App Settings object's schema-registration validator:
 * `lat` in `[-90,90]`, `lon` in `[-180,180]` (edges inclusive), both-or-neither non-null
 * (a partial pair is rejected here — distinct from
 * `readWeatherLocation`'s read-side "treat a stored partial pair as blank" branch
 * below), `label` optional, trimmed, <=80 chars. Returns `null` on ANY schema violation,
 * matching the registry's `SettingsObjectDef.validate` contract
 * (`src/server/routes/settings.ts`).
 */
export function validateWeather(payload: unknown): WeatherSettingsObject | null {
  if (!isPlainObject(payload)) return null;
  if (Object.keys(payload).some((key) => !WEATHER_KEYS.has(key))) return null;

  const { lat: rawLat, lon: rawLon, label: rawLabel } = payload;
  const latBlank = rawLat === null || rawLat === undefined;
  const lonBlank = rawLon === null || rawLon === undefined;

  let lat: number | null;
  let lon: number | null;
  if (latBlank && lonBlank) {
    // Clear-as-unit: both null (or both absent) is the blank state.
    lat = null;
    lon = null;
  } else if (!latBlank && !lonBlank) {
    if (!isValidLat(rawLat) || !isValidLon(rawLon)) return null;
    lat = rawLat;
    lon = rawLon;
  } else {
    // Partial pair — reject on write, never completed or guessed.
    return null;
  }

  if (rawLabel === undefined || rawLabel === null) {
    return { lat, lon };
  }
  if (typeof rawLabel !== "string") return null;
  const label = rawLabel.trim();
  if (label.length > 80) return null;
  return { lat, lon, label };
}

/** Read-side location accessor: reads the persisted `weather` App Settings row
 * directly — raw SQL over `settings_objects` (this module's eslint zone permits only its
 * own subtree + the host-api barrel, so it reads via the barrel's `getDb` rather than
 * importing `../../db/schema`) — and resolves to a complete `WeatherLocation` or `null`.
 * A STORED partial pair (e.g. `lat` set, `lon` absent) — write-rejected in practice by
 * `validateWeather` above, but this function must not assume every row on disk was
 * written through that gate — reads as blank (`null`), rather than being rejected as on write.
 * Likewise, a STORED out-of-range pair (e.g. hand-inserted `{lat: 999, lon: 0}` — again
 * unreachable via `validateWeather`, but this function reads whatever is on disk) reuses
 * `isValidLat`/`isValidLon` and reads as blank too, rather than letting an out-of-range
 * coordinate reach a future forecast provider call unfiltered.
 * App Settings is the sole location source, with no environment fallback:
 * this function never reads `process.env` or `getOperatorConfig` for
 * lat/lon — a `WEATHER_LAT`/`WEATHER_LON` env var, even if set, has no effect here (those
 * names are not even registered in `getOperatorConfig`'s reserved-key map —
 * only `weather.endpoint`/`weather.enabled` are).
 */
export function readWeatherLocation(): WeatherLocation | null {
  const db = getDb();
  const row = db
    .prepare("SELECT data FROM settings_objects WHERE object_name = ?")
    .get("weather") as { data: string } | undefined;
  if (!row) return null;

  // Shared guard: a corrupt/malformed `data` column —
  // unreachable through the validated PUT boundary, but not something this read-side
  // accessor may assume can't happen on disk (a hand-edit, a migration bug, disk
  // corruption) — degrades to blank, exactly like a missing row. Every caller (`GET
  // /api/weather` via `routes/weather.ts`, and the Daily Briefing forecast resolve via
  // `daily-briefing/index.ts`'s `resolveWeatherBlock`) relies on this function never
  // throwing, so the guard lives HERE once rather than being duplicated at each call site.
  let parsed: Partial<WeatherSettingsObject>;
  try {
    parsed = JSON.parse(row.data) as Partial<WeatherSettingsObject>;
  } catch {
    return null;
  }
  const { lat, lon, label } = parsed;
  if (!isValidLat(lat) || !isValidLon(lon)) return null;

  return label !== undefined ? { lat, lon, label } : { lat, lon };
}
