import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { assertWeekdayIntegrity } from "../../src/server/db/weekday-integrity";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { CANONICAL_WEEKDAY_ORDER, isWeekday, validateWeekdays } from "../../src/shared/weekdays";
import { useIsolatedDb } from "../helpers/db";

describe("canonical weekday integrity", () => {
  useIsolatedDb();

  it("rejects integer and noncanonical tokens without coercing or changing domain set policies", () => {
    expect(validateWeekdays(CANONICAL_WEEKDAY_ORDER)).toEqual(CANONICAL_WEEKDAY_ORDER);
    expect(validateWeekdays([])).toEqual([]);
    expect(validateWeekdays(["fri", "mon", "mon"])).toEqual(["fri", "mon", "mon"]);
    for (const value of [1, null, false, "MON", "monday", "1", {}, undefined]) {
      expect(isWeekday(value)).toBe(false);
      expect(() => validateWeekdays(["mon", value])).toThrow("Invalid weekday");
    }
    for (const value of [null, 1, "mon", {}]) {
      expect(() => validateWeekdays(value)).toThrow("weekdays must be an array");
    }
    class DomainError extends Error {}
    expect(() => validateWeekdays([1], DomainError)).toThrow(DomainError);
  });

  it("accepts fresh and public-seeded databases including null and empty masks", async () => {
    expect(() => assertWeekdayIntegrity()).not.toThrow();
    await runSeedProfile({ mode: "public", disposableTarget: true });
    expect(() => assertWeekdayIntegrity()).not.toThrow();
  });

  it("identifies corrupt persisted weekday rows in every domain without rewriting data", async () => {
    await runSeedProfile({ mode: "public", disposableTarget: true });
    const db = getDb();
    for (const [table, column] of [
      ["routine_assignments", "weekdays"],
      ["reminder_assignment", "weekdays"],
      ["daily_briefing_member_block_settings", "weekdays"],
      ["daily_briefing_optin", "weekdays"],
      ["time_announcements", "week_days"],
      ["meal_entries", "weekday"],
    ]) {
      const row = db.prepare(`SELECT rowid, ${column} AS value FROM ${table} LIMIT 1`).get() as {
        rowid: number;
        value: string | null;
      };
      expect(row).toBeDefined();
      for (const invalid of [
        "[1]",
        '["mon","bogus"]',
        "1",
        "null",
        "{}",
        "{broken",
        Buffer.from("[]"),
      ]) {
        db.pragma("ignore_check_constraints = ON");
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(invalid, row.rowid);
        db.pragma("ignore_check_constraints = OFF");
        expect(() => assertWeekdayIntegrity()).toThrow(`${table}.${column} row`);
        expect(
          db.prepare(`SELECT ${column} AS value FROM ${table} WHERE rowid = ?`).get(row.rowid)
        ).toEqual({ value: invalid });
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(row.value, row.rowid);
      }
    }
    db.prepare(
      "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, created_at, updated_at) VALUES ('bad-rule', 'scheduled', 'apply_to_all', 'Test', '[1]', 0, 0)"
    ).run();
    expect(() => assertWeekdayIntegrity()).toThrow("reminder.weekdays row bad-rule");
    db.prepare("UPDATE reminder SET weekdays = '[\"mon\"]' WHERE id = 'bad-rule'").run();
    expect(() => assertWeekdayIntegrity()).not.toThrow();
  });
});
