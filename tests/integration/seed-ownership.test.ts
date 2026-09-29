import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import {
  DEMO_OWNED_TABLES,
  DEMO_SETTINGS_OBJECT_NAMES,
  beginSeedProfile,
  completeSeedProfile,
} from "../../src/server/db/seeds/ownership";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;

describe("seed ownership integration", () => {
  useIsolatedDb();

  it("declares the complete demo-owned table inventory and exact singleton Settings keys", () => {
    expect(DEMO_OWNED_TABLES).toEqual([
      "members",
      "calendar_events",
      "calendar_assignments",
      "calendar_external_sources",
      "routines",
      "chores",
      "routine_assignments",
      "chore_completions",
      "reminder",
      "reminder_assignment",
      "recipes",
      "meal_plans",
      "meal_entries",
      "daily_messages",
      "daily_briefing_optin",
      "daily_briefing_member_block_settings",
      "daily_briefing_block_order",
      "daily_briefing_settings",
      "time_announcements",
      "settings_objects",
    ]);
    expect(DEMO_SETTINGS_OBJECT_NAMES).toEqual([
      "locale",
      "weather",
      "printer",
      "printerTransport",
    ]);
  });

  it("refuses an unowned singleton Settings key on every rerun without deletion", () => {
    beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW });
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', '{}', ?)"
      )
      .run(NOW);
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('ordinary-setting', '{}', ?)"
      )
      .run(NOW);

    expect(() => beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 1 })).toThrow(
      /ordinary-setting/
    );
    expect(
      getDb().prepare("SELECT object_name FROM settings_objects ORDER BY object_name").all()
    ).toEqual([{ object_name: "locale" }, { object_name: "ordinary-setting" }]);
  });

  it("refuses an unrelated owned-table row on every rerun without deleting it", () => {
    beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW });
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('ordinary:member', 'Ordinary', 'parent', ?, ?)"
      )
      .run(NOW, NOW);

    expect(() => completeSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 1 })).toThrow(
      /ordinary:member/
    );
    expect(getDb().prepare("SELECT id FROM members").all()).toEqual([{ id: "ordinary:member" }]);
    expect(getDb().prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "running",
    });
  });

  it("keeps a completed same-date rerun canonical without duplicating or rewriting the marker", () => {
    beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW });
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('demo:member:marge', 'Marge', 'parent', ?, ?)"
      )
      .run(NOW, NOW);
    completeSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 1 });

    expect(beginSeedProfile(getDb(), { asOfDate: AS_OF_DATE, nowMs: NOW + 2 })).toEqual({
      action: "rerun",
      profile: "simpsons-demo",
      status: "complete",
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM seed_profile_state").get()).toEqual({
      count: 1,
    });
    expect(getDb().prepare("SELECT completed_at FROM seed_profile_state").get()).toEqual({
      completed_at: NOW + 1,
    });
  });

  it("rolls the complete public profile to a new date while preserving stable identities", async () => {
    const firstDate = "2026-09-23";
    const secondDate = "2026-09-30";

    await runSeedProfile({
      mode: "public",
      asOfDate: firstDate,
      nowMs: NOW,
      disposableTarget: true,
    });
    const firstInventory = rollingInventory();

    const sameDateReport = await runSeedProfile({
      mode: "public",
      asOfDate: firstDate,
      nowMs: NOW + 1,
      disposableTarget: true,
    });
    expect(sameDateReport.markerAction).toBe("rerun");
    expect(rollingInventory()).toEqual(firstInventory);

    const rolloverReport = await runSeedProfile({
      mode: "public",
      asOfDate: secondDate,
      nowMs: NOW + 2,
      disposableTarget: true,
    });
    const secondInventory = rollingInventory();

    expect(rolloverReport.markerAction).toBe("repair");
    expect(secondInventory.memberIds).toEqual(firstInventory.memberIds);
    expect(secondInventory.calendarIds).toEqual(firstInventory.calendarIds);
    expect(secondInventory.calendarDates).not.toEqual(firstInventory.calendarDates);
    expect(secondInventory.mealDates).not.toEqual(firstInventory.mealDates);
    expect(secondInventory.messageDates).not.toEqual(firstInventory.messageDates);
    expect(getDb().prepare("SELECT as_of_date, status FROM seed_profile_state").get()).toEqual({
      as_of_date: secondDate,
      status: "complete",
    });
  });
});

function rollingInventory(): {
  memberIds: string[];
  calendarIds: string[];
  calendarDates: string[];
  mealDates: string[];
  messageDates: string[];
} {
  const values = (sql: string, column: string) =>
    (getDb().prepare(sql).all() as Array<Record<string, string>>).map((row) => row[column]);

  return {
    memberIds: values("SELECT id FROM members ORDER BY id", "id"),
    calendarIds: values("SELECT id FROM calendar_events ORDER BY id", "id"),
    calendarDates: values(
      "SELECT COALESCE(start_date, start_utc) AS value FROM calendar_events ORDER BY id",
      "value"
    ),
    mealDates: values(
      "SELECT entry_date AS value FROM meal_entries WHERE entry_date IS NOT NULL ORDER BY id",
      "value"
    ),
    messageDates: values("SELECT date FROM daily_messages ORDER BY id", "date"),
  };
}
