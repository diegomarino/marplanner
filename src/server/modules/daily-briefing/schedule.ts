/** Per-member weekday pause schedule (admin parity, spec D1–D4). Stored as the nullable
 * `daily_briefing_optin.weekdays` JSON column (drizzle/0005): NULL means every day. Imports only
 * the host-api barrel, this plugin's own errors, and shared weekday helpers (lint zone).
 * Writes never touch `daily_briefing` — a schedule change never regenerates anything.
 */
import { assertActiveMember, getDb, readHouseholdTimezone, weekdayOf } from "../../host-api";
import { CANONICAL_WEEKDAY_ORDER, validateWeekdays } from "../../../shared/weekdays";
import type { WeekdayCode } from "../../../shared/weekdays";
import type { BriefingSchedule } from "../../../shared";
import { DailyBriefingValidationError } from "./errors";

function canonical(days: readonly WeekdayCode[]): WeekdayCode[] {
  const seen = new Set(days);
  return CANONICAL_WEEKDAY_ORDER.filter((day) => seen.has(day));
}

/** Stored values were validated on write and are re-checked at boot (weekday-integrity.ts). */
function parseStored(raw: string): WeekdayCode[] {
  return canonical(validateWeekdays(JSON.parse(raw)));
}

/** The weekdays on which `memberId`'s briefing runs; every day when no schedule is stored. */
export function readMemberWeekdays(memberId: string): WeekdayCode[] {
  const row = getDb()
    .prepare("SELECT weekdays FROM daily_briefing_optin WHERE member_id = ?")
    .get(memberId) as { weekdays: string | null } | undefined;
  return row?.weekdays ? parseStored(row.weekdays) : [...CANONICAL_WEEKDAY_ORDER];
}

/** Every stored schedule (members without one run every day and are omitted). */
export function listMemberSchedules(): BriefingSchedule[] {
  const rows = getDb()
    .prepare(
      "SELECT member_id, weekdays FROM daily_briefing_optin WHERE weekdays IS NOT NULL ORDER BY member_id ASC"
    )
    .all() as Array<{ member_id: string; weekdays: string }>;
  return rows.map((row) => ({ memberId: row.member_id, weekdays: parseStored(row.weekdays) }));
}

/** Validate and store a member's schedule. A member with no opt-in row gets one with
 * `enabled = 0` (absent and 0 both mean "not opted in"); an existing row keeps its flag. */
export function setMemberSchedule(memberId: string, weekdays: unknown): BriefingSchedule {
  const days = canonical(validateWeekdays(weekdays, DailyBriefingValidationError));
  try {
    assertActiveMember(memberId);
  } catch {
    throw new DailyBriefingValidationError(`Member "${memberId}" is not active`);
  }
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_optin (member_id, enabled, weekdays, created_at, updated_at)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET weekdays = excluded.weekdays, updated_at = excluded.updated_at`
    )
    .run(memberId, JSON.stringify(days), now, now);
  return { memberId, weekdays: days };
}

/** True when the member's briefing is not paused on `date`'s weekday. */
export function isBriefingScheduledOn(memberId: string, date: string): boolean {
  return readMemberWeekdays(memberId).includes(weekdayOf(date, readHouseholdTimezone()));
}
