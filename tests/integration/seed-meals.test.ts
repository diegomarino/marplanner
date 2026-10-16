import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { getMenu, listMealPlans, listRecipes } from "../../src/server/modules/meals";
import { useIsolatedDb } from "../helpers/db";

const FIRST_DATE = "2026-09-25";
const SECOND_DATE = "2026-10-02";
const THIRD_DATE = "2026-10-09";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");

describe("demo meals seed integration", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances only a complete owned profile, replaces rolling entries, and refuses unrelated rows before moving again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    await runMealsSeed(FIRST_DATE, NOW_MS);

    const canonicalRecipes = listRecipes();
    const canonicalPlans = listMealPlans();
    const firstRollingRows = rollingRows();
    getDb()
      .prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'snack', NULL, ?, ?)"
      )
      .run(
        "demo:meal-entry:foreign-owned:2026-09-23",
        FIRST_DATE,
        "Foreign demo-owned meal",
        NOW_MS + 1
      );

    vi.setSystemTime(NOW_MS + 60_000);
    await expect(runMealsSeed(SECOND_DATE, NOW_MS + 60_000)).resolves.toMatchObject({
      asOfDate: SECOND_DATE,
      markerAction: "repair",
      status: "complete",
    });

    expect(listRecipes()).toEqual(canonicalRecipes);
    expect(listMealPlans()).toEqual(canonicalPlans);
    expect(rollingRows()).toEqual([
      { id: "demo:meal-entry:rolling:2026-09-25:dinner:previous-dinner", entry_date: "2026-09-25" },
      { id: "demo:meal-entry:rolling:2026-09-27:lunch:previous-lunch", entry_date: "2026-09-27" },
      {
        id: "demo:meal-entry:rolling:2026-09-28:breakfast:current-breakfast",
        entry_date: "2026-09-28",
      },
      { id: "demo:meal-entry:rolling:2026-09-28:dinner:current-dinner", entry_date: "2026-09-28" },
      {
        id: "demo:meal-entry:rolling:2026-09-28:dinner:current-dinner-note",
        entry_date: "2026-09-28",
      },
      { id: "demo:meal-entry:rolling:2026-09-28:lunch:current-lunch", entry_date: "2026-09-28" },
      { id: "demo:meal-entry:rolling:2026-09-30:snack:current-snack", entry_date: "2026-09-30" },
      { id: "demo:meal-entry:rolling:2026-10-04:dinner:current-friday", entry_date: "2026-10-04" },
      {
        id: "demo:meal-entry:rolling:2026-10-05:breakfast:next-breakfast",
        entry_date: "2026-10-05",
      },
      { id: "demo:meal-entry:rolling:2026-10-07:snack:next-snack", entry_date: "2026-10-07" },
      {
        id: "demo:meal-entry:rolling:2026-10-09:dinner:next-dinner-note",
        entry_date: "2026-10-09",
      },
      { id: "demo:meal-entry:rolling:2026-10-11:dinner:next-dinner", entry_date: "2026-10-11" },
    ]);
    expect(
      rollingRows()
        .map((row) => row.id)
        .filter((id) => firstRollingRows.some((old) => old.id === id))
    ).toEqual([]);
    expect(firstRollingRows).toHaveLength(12);
    expect(
      getDb()
        .prepare("SELECT id, entry_date, slot, note FROM meal_entries WHERE id = ?")
        .get("demo:meal-entry:foreign-owned:2026-09-23")
    ).toEqual({
      id: "demo:meal-entry:foreign-owned:2026-09-23",
      entry_date: FIRST_DATE,
      slot: "snack",
      note: "Foreign demo-owned meal",
    });
    expect(getMenu(SECOND_DATE, undefined)).toEqual([
      expect.objectContaining({
        entryId: "demo:meal-entry:recurring:school-lunches:fri:lunch",
        planId: "demo:meal-plan:school-lunches",
        recipeId: null,
        note: "Sandwich and fruit",
      }),
      expect.objectContaining({
        entryId: "demo:meal-entry:recurring:fri:dinner",
        planId: "demo:meal-plan:simpson-family-week",
        recipeId: "demo:recipe:lisa-lentil-stew",
        note: null,
      }),
    ]);
    expect(
      getDb()
        .prepare("SELECT as_of_date, status, started_at, completed_at FROM seed_profile_state")
        .get()
    ).toEqual({
      as_of_date: SECOND_DATE,
      status: "complete",
      started_at: NOW_MS + 60_000,
      completed_at: NOW_MS + 60_000,
    });

    getDb()
      .prepare(
        "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, 'lunch', NULL, ?, ?)"
      )
      .run("ordinary:meal-entry", SECOND_DATE, "Ordinary meal", NOW_MS + 60_001);

    await expect(runMealsSeed(THIRD_DATE, NOW_MS + 120_000)).rejects.toThrow(
      /unrelated row.*meal_entries/i
    );
    expect(
      getDb()
        .prepare("SELECT id, entry_date, note FROM meal_entries WHERE id = ?")
        .get("ordinary:meal-entry")
    ).toEqual({ id: "ordinary:meal-entry", entry_date: SECOND_DATE, note: "Ordinary meal" });
    expect(getDb().prepare("SELECT as_of_date, status FROM seed_profile_state").get()).toEqual({
      as_of_date: SECOND_DATE,
      status: "complete",
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing").get()).toEqual({
      count: 0,
    });
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing_block_cache").get()
    ).toEqual({ count: 0 });
  });
});

function runMealsSeed(asOfDate: string, nowMs: number) {
  return runSeedProfile({ mode: "public", asOfDate, nowMs, disposableTarget: true });
}

function rollingRows() {
  return (
    getDb()
      .prepare(
        "SELECT id, entry_date FROM meal_entries WHERE entry_date IS NOT NULL AND id LIKE 'demo:meal-entry:%' ORDER BY id"
      )
      .all() as { id: string; entry_date: string }[]
  ).filter(
    ({ id, entry_date }) =>
      /^demo:meal-entry:rolling:\d{4}-\d{2}-\d{2}:(?:breakfast|lunch|snack|dinner):[a-z0-9-]+$/.test(
        id
      ) && id.includes(`:${entry_date}:`)
  );
}
