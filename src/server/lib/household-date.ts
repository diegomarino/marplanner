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

/** Read only persisted locale fields; corrupt data uses defaults without rewriting the row. */
function readLocale(): Record<string, unknown> {
  const row = getDb()
    .prepare("SELECT data FROM settings_objects WHERE object_name = ?")
    .get("locale") as { data: string } | undefined;
  if (row) {
    try {
      const value: unknown = JSON.parse(row.data);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // A restored or corrupted locale must not abort calendar-date reads.
    }
  }
  return {};
}

/** Read a valid household timezone, falling back to Europe/Madrid when unset or invalid. */
export function readHouseholdTimezone(): string {
  const timezone = readLocale().timezone;
  if (typeof timezone === "string") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
      return timezone;
    } catch {
      // Invalid persisted timezone; retain the row and use the configured default.
    }
  }
  return DEFAULT_TZ;
}

/** Read the supported week-start value (0=Sunday, 1=Monday), defaulting to Monday. */
export function readWeekStartDay(): number {
  const weekStartDay = readLocale().weekStartDay;
  return weekStartDay === 0 || weekStartDay === 1 ? weekStartDay : DEFAULT_WEEK_START_DAY;
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
