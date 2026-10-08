import { getDb } from "./client";
import { isWeekday, validateWeekdays } from "../../shared/weekdays";

/** Fail before serving or scheduling; never repair persisted recurrence data implicitly. */
export function assertWeekdayIntegrity(): void {
  const db = getDb();
  for (const [table, column, nullable] of [
    ["routine_assignments", "weekdays", false],
    ["reminder", "weekdays", true],
    ["reminder_assignment", "weekdays", false],
    ["daily_briefing_member_block_settings", "weekdays", true],
    ["time_announcements", "week_days", false],
    ["meal_entries", "weekday", true],
  ] as const) {
    const id =
      table === "daily_briefing_member_block_settings" ? "member_id || ':' || block_type" : "id";
    const rows = db.prepare(`SELECT ${id} AS id, ${column} AS value FROM ${table}`).all() as {
      id: string;
      value: unknown;
    }[];
    for (const row of rows) {
      if (row.value === null && nullable) continue;
      try {
        if (table === "meal_entries") {
          if (!isWeekday(row.value)) throw new Error("invalid weekday token");
        } else {
          if (typeof row.value !== "string") throw new Error("expected JSON text");
          validateWeekdays(JSON.parse(row.value));
        }
      } catch (cause) {
        throw new Error(`Weekday integrity failed: ${table}.${column} row ${row.id}`, { cause });
      }
    }
  }
}
