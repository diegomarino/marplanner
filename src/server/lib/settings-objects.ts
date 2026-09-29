import { getDb } from "../db/client";

/** Generic, read-only `settings_objects` row reader (ADR-039 Rule B host-mediation seam).
 * `household-date.ts`'s `readHouseholdTimezone`/`readWeekStartDay` and
 * `modules/weather/index.ts`'s `readWeatherLocation` each reimplement this exact
 * `SELECT data FROM settings_objects WHERE object_name = ?` inline for their own hardcoded
 * object name; this is the generic primitive for any OTHER named object a plugin needs to
 * read through the host-API barrel — narrow and read-only by design: no write
 * path, and no JSON parsing here, since each object's shape/corruption handling is the
 * caller's own schema concern (mirroring `readWeatherLocation`'s and `getBriefingTime`'s * independent parse/fallback branches — a shared parse step would force one corruption
 * policy on every future object).
 * Returns the raw persisted `data` column (still JSON-encoded) for `name`, or `undefined`
 * when no row is persisted under that name yet.
 */
export function readSettingsObject(name: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT data FROM settings_objects WHERE object_name = ?").get(name) as
    { data: string } | undefined;
  return row?.data;
}
