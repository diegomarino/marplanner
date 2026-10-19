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
    // Previous (Sep 21–27), current (Sep 28–Oct 4) and next (Oct 5–11) household weeks.
    expect(rollingRows()).toEqual(
      [
        ["2026-09-21", "breakfast", "previous-mon-breakfast"],
        ["2026-09-23", "dinner", "previous-wed-dinner"],
        ["2026-09-24", "lunch", "previous-thu-lunch"],
        ["2026-09-25", "dinner", "previous-dinner"],
        ["2026-09-26", "breakfast", "previous-sat-breakfast"],
        ["2026-09-26", "dinner", "previous-sat-dinner"],
        ["2026-09-27", "lunch", "previous-lunch"],
        ["2026-09-28", "breakfast", "current-breakfast"],
        ["2026-09-28", "dinner", "current-dinner"],
        ["2026-09-28", "dinner", "current-dinner-note"],
        ["2026-09-28", "lunch", "current-lunch"],
        ["2026-09-29", "breakfast", "current-tue-breakfast"],
        ["2026-09-29", "snack", "current-tue-snack"],
        ["2026-09-30", "breakfast", "current-wed-breakfast"],
        ["2026-09-30", "snack", "current-snack"],
        ["2026-10-01", "breakfast", "current-thu-breakfast"],
        ["2026-10-01", "dinner", "current-thu-dinner"],
        ["2026-10-02", "breakfast", "current-fri-breakfast"],
        ["2026-10-02", "snack", "current-fri-snack"],
        ["2026-10-03", "dinner", "current-sat-dinner"],
        ["2026-10-03", "lunch", "current-sat-lunch"],
        ["2026-10-03", "snack", "current-sat-snack"],
        ["2026-10-04", "breakfast", "current-sun-breakfast"],
        ["2026-10-04", "dinner", "current-friday"],
        ["2026-10-04", "lunch", "current-sun-lunch"],
        ["2026-10-05", "breakfast", "next-breakfast"],
        ["2026-10-06", "dinner", "next-tue-dinner"],
        ["2026-10-07", "snack", "next-snack"],
        ["2026-10-08", "breakfast", "next-thu-breakfast"],
        ["2026-10-09", "dinner", "next-dinner-note"],
        ["2026-10-10", "dinner", "next-sat-dinner"],
        ["2026-10-10", "lunch", "next-sat-lunch"],
        ["2026-10-11", "dinner", "next-dinner"],
      ].map(([date, slot, suffix]) => ({
        id: `demo:meal-entry:rolling:${date}:${slot}:${suffix}`,
        entry_date: date,
      }))
    );
    expect(
      rollingRows()
        .map((row) => row.id)
        .filter((id) => firstRollingRows.some((old) => old.id === id))
    ).toEqual([]);
    expect(firstRollingRows).toHaveLength(33);
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
      expect.objectContaining({
        entryId: "demo:meal-entry:rolling:2026-10-02:breakfast:current-fri-breakfast",
        planId: null,
        recipeId: "demo:recipe:bart-pancakes",
        note: null,
      }),
      expect.objectContaining({
        entryId: "demo:meal-entry:rolling:2026-10-02:snack:current-fri-snack",
        planId: null,
        recipeId: "demo:recipe:kwik-e-mart-squishee",
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
