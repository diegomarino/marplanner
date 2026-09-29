import { getDb } from "../db/client";
import { localDateParts } from "../../shared/householdTime.js";

const DEFAULT_TZ = "Europe/Madrid";
const DEFAULT_WEEK_START_DAY = 1; // Monday (ADR-028/app-settings-registry.md); no new setting added.

// The pure tz/DST math moved verbatim to
// `src/shared/householdTime.ts` (server + client share ONE implementation);
// this module keeps only the three IMPURE readers below (they touch
// `getDb`) and re-exports the moved pure set so no server call site
// changes — every existing `from "../lib/household-date"` / `from
// "./household-date"` import keeps resolving exactly as before.
export type { WeekdayCode } from "../../shared/householdTime.js";
export {
  isDateOnly,
  isStrictCalendarDate,
  weekdayOf,
  nextOccurrenceInTz,
} from "../../shared/householdTime.js";

/** Read the household timezone from persisted settings.
 * Returns the timezone from the 'locale' settings object, or the default
 * (Europe/Madrid) when no such object exists.
 */
export function readHouseholdTimezone(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT data FROM settings_objects WHERE object_name = ?")
    .get("locale") as { data: string } | undefined;
  if (row) {
    const persisted: Record<string, unknown> = JSON.parse(row.data);
    if (persisted.timezone) return persisted.timezone as string;
  }
  return DEFAULT_TZ;
}

/** Read the `weekStartDay` app-setting (0=Sunday, 1=Monday) from the same
 * `locale` settings object `readHouseholdTimezone` reads — moved from meals'
 * local copy (ADR-039 §2b′ host-mediation; no new setting added).
 */
export function readWeekStartDay(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT data FROM settings_objects WHERE object_name = ?")
    .get("locale") as { data: string } | undefined;
  if (row) {
    const persisted: Record<string, unknown> = JSON.parse(row.data);
    if (typeof persisted.weekStartDay === "number") {
      return persisted.weekStartDay;
    }
  }
  return DEFAULT_WEEK_START_DAY;
}

/** Household-local calendar date ("YYYY-MM-DD") for the given epoch-ms
 * instant, in the household's configured timezone (same Intl technique as
 * daily-briefing's private `resolveBusinessDate`, which stays untouched).
 * Unlike `resolveBusinessDate`, this takes an explicit `now` so callers
 * (the scheduler) stay deterministic under an injected clock
 * instead of reading `Date.now` internally.
 */
export function todayInHouseholdTz(now: number): string {
  const tz = readHouseholdTimezone();
  const { y, m, d } = localDateParts(now, tz);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
