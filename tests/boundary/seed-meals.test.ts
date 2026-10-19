import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { listRecipes } from "../../src/server/modules/meals";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const RERUN_NOW_MS = NOW_MS + 60_000;

describe("canonical demo meals seed boundary", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("populates the Simpsons catalogue and three navigable rolling weeks", async () => {
    await runMealsSeed("2026-09-25", Date.parse("2026-09-25T12:00:00.000Z"));

    expect(listRecipes().map(({ id, name, slots }) => ({ id, name, slots }))).toEqual([
      { id: "demo:recipe:apu-samosas", name: "Apu's Samosas", slots: ["snack", "dinner"] },
      { id: "demo:recipe:bart-pancakes", name: "Bart's Pancakes", slots: ["breakfast"] },
      {
        id: "demo:recipe:wiggum-chili",
        name: "Chief Wiggum's Chili",
        slots: ["lunch", "dinner"],
      },
      { id: "demo:recipe:flaming-moes", name: "Flaming Moe's", slots: ["snack"] },
      { id: "demo:recipe:krusty-burger", name: "Krusty Burger", slots: ["lunch", "dinner"] },
      { id: "demo:recipe:krusty-os", name: "Krusty-O's Cereal", slots: ["breakfast"] },
      { id: "demo:recipe:kwik-e-mart-squishee", name: "Kwik-E-Mart Squishee", slots: ["snack"] },
      { id: "demo:recipe:lard-lad-donut", name: "Lard Lad Donut", slots: ["breakfast", "snack"] },
      {
        id: "demo:recipe:lisa-lentil-stew",
        name: "Lisa's Lentil Stew",
        slots: ["lunch", "dinner"],
      },
      { id: "demo:recipe:lisa-veggie-wrap", name: "Lisa's Veggie Wrap", slots: ["lunch"] },
      { id: "demo:recipe:marge-pork-chops", name: "Marge's Pork Chops", slots: ["dinner"] },
      { id: "demo:recipe:marge-pretzels", name: "Marge's Pretzels", slots: ["snack"] },
      { id: "demo:recipe:marges-spaghetti", name: "Marge's Spaghetti", slots: ["lunch", "dinner"] },
      {
        id: "demo:recipe:marge-tomato-soup",
        name: "Marge's Tomato Soup",
        slots: ["lunch", "dinner"],
      },
      { id: "demo:recipe:moon-waffles", name: "Moon Waffles", slots: ["breakfast"] },
      { id: "demo:recipe:pink-donut", name: "Pink Donut", slots: ["breakfast", "snack"] },
      { id: "demo:recipe:steamed-hams", name: "Steamed Hams", slots: ["lunch", "dinner"] },
      { id: "demo:recipe:domingo-tacos", name: "Sunday Tacos", slots: ["lunch", "dinner"] },
    ]);

    const { getWeekMenu } = await import("../../src/server/modules/meals");
    for (const anchor of ["2026-09-18", "2026-09-25", "2026-10-02"]) {
      const week = getWeekMenu(anchor);
      expect(
        Object.values(week).filter((slots) =>
          Object.values(slots).some((items) => items.length > 0)
        ).length
      ).toBeGreaterThan(1);
    }
    const current = getWeekMenu("2026-09-25");
    expect(current["2026-09-21"].dinner.map((item) => item.entryId)).toEqual([
      "demo:meal-entry:recurring:mon:dinner",
      "demo:meal-entry:rolling:2026-09-21:dinner:current-dinner",
      "demo:meal-entry:rolling:2026-09-21:dinner:current-dinner-note",
    ]);
    for (const anchor of ["2026-09-25", "2026-10-02"]) {
      const origins = new Set(
        Object.values(getWeekMenu(anchor)).flatMap((slots) =>
          Object.values(slots).flatMap((items) => items.map((item) => item.planId ?? "oneoff"))
        )
      );
      expect([...origins].sort()).toEqual([
        "demo:meal-plan:school-lunches",
        "demo:meal-plan:simpson-family-week",
        "oneoff",
      ]);
    }
    expect(
      Object.values(getWeekMenu("2026-10-02")).some((slots) =>
        Object.values(slots).some((items) =>
          items.some((item) => item.source === "oneoff" && item.note !== null)
        )
      )
    ).toBe(true);
  });

  it("keeps authoritative Meals reads and persisted IDs identical across two same-date clocks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);

    const firstReport = await runMealsSeed(AS_OF_DATE, NOW_MS);
    const firstRows = mealRows();

    vi.setSystemTime(RERUN_NOW_MS);
    const secondReport = await runMealsSeed(AS_OF_DATE, RERUN_NOW_MS);
    const publicRead = await readMealsThroughPublicApi();

    expect(firstReport).toMatchObject({
      moduleIds: [
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
        "plugins:demo",
      ],
      asOfDate: AS_OF_DATE,
      status: "complete",
    });
    expect(secondReport).toMatchObject({
      moduleIds: [
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
        "plugins:demo",
      ],
      asOfDate: AS_OF_DATE,
      markerAction: "rerun",
      status: "complete",
    });
    expect(publicRead.recipes.map(withoutRecipeTimestamps)).toEqual([
      {
        id: "demo:recipe:apu-samosas",
        name: "Apu's Samosas",
        ingredients: ["potatoes", "peas", "pastry"],
        instructions: "Fill the pastry, seal it, and bake until golden.",
        slots: ["snack", "dinner"],
      },
      {
        id: "demo:recipe:bart-pancakes",
        name: "Bart's Pancakes",
        ingredients: ["flour", "milk", "eggs"],
        instructions: "Whisk the batter and cook pancakes on a warm griddle.",
        slots: ["breakfast"],
      },
      {
        id: "demo:recipe:wiggum-chili",
        name: "Chief Wiggum's Chili",
        ingredients: ["beans", "ground beef", "tomatoes", "mild peppers"],
        instructions: "Brown the beef, add everything else and simmer for an hour.",
        slots: ["lunch", "dinner"],
      },
      {
        id: "demo:recipe:flaming-moes",
        name: "Flaming Moe's",
        ingredients: ["citrus soda", "cherry syrup", "ice"],
        instructions: "Chill the ingredients and serve over ice.",
        slots: ["snack"],
      },
      {
        id: "demo:recipe:krusty-burger",
        name: "Krusty Burger",
        ingredients: ["bun", "patty", "pickles"],
        instructions: "Grill the patty and assemble the burger.",
        slots: ["lunch", "dinner"],
      },
      {
        id: "demo:recipe:krusty-os",
        name: "Krusty-O's Cereal",
        ingredients: ["Krusty-O's", "milk", "banana"],
        instructions: "Pour, add milk and slice a banana on top.",
        slots: ["breakfast"],
      },
      {
        id: "demo:recipe:kwik-e-mart-squishee",
        name: "Kwik-E-Mart Squishee",
        ingredients: ["crushed ice", "cherry syrup"],
        instructions: "Blend the ice and pour the syrup over it.",
        slots: ["snack"],
      },
      {
        id: "demo:recipe:lard-lad-donut",
        name: "Lard Lad Donut",
        ingredients: ["flour", "sugar", "chocolate glaze", "sprinkles"],
        instructions: "Fry the dough rings and dip them in chocolate glaze.",
        slots: ["breakfast", "snack"],
      },
      {
        id: "demo:recipe:lisa-lentil-stew",
        name: "Lisa's Lentil Stew",
        ingredients: ["lentils", "carrot", "celery"],
        instructions: "Simmer until the lentils are tender.",
        slots: ["lunch", "dinner"],
      },
      {
        id: "demo:recipe:lisa-veggie-wrap",
        name: "Lisa's Veggie Wrap",
        ingredients: ["tortilla", "hummus", "cucumber", "spinach"],
        instructions: "Spread the hummus, add the vegetables and roll it up.",
        slots: ["lunch"],
      },
      {
        id: "demo:recipe:marge-pork-chops",
        name: "Marge's Pork Chops",
        ingredients: ["pork chops", "applesauce", "green beans"],
        instructions: "Pan-fry the chops and serve with warm applesauce and beans.",
        slots: ["dinner"],
      },
      {
        id: "demo:recipe:marge-pretzels",
        name: "Marge's Pretzels",
        ingredients: ["flour", "yeast", "coarse salt"],
        instructions: "Twist the dough, dip in baking-soda water and bake until brown.",
        slots: ["snack"],
      },
      {
        id: "demo:recipe:marges-spaghetti",
        name: "Marge's Spaghetti",
        ingredients: ["spaghetti", "tomatoes", "garlic"],
        instructions: "Cook the pasta and toss it with the tomato sauce.",
        slots: ["lunch", "dinner"],
      },
      {
        id: "demo:recipe:marge-tomato-soup",
        name: "Marge's Tomato Soup",
        ingredients: ["tomatoes", "onion", "basil"],
        instructions: "Blend the cooked vegetables until smooth.",
        slots: ["lunch", "dinner"],
      },
      {
        id: "demo:recipe:moon-waffles",
        name: "Moon Waffles",
        ingredients: ["waffle batter", "caramel", "butter"],
        instructions: "Cook the waffles and drizzle with caramel.",
        slots: ["breakfast"],
      },
      {
        id: "demo:recipe:pink-donut",
        name: "Pink Donut",
        ingredients: ["flour", "strawberry glaze"],
        instructions: "Bake, then cover with pink glaze.",
        slots: ["breakfast", "snack"],
      },
      {
        id: "demo:recipe:steamed-hams",
        name: "Steamed Hams",
        ingredients: ["4 hamburger patties", "sesame buns", "ketchup", "mustard"],
        instructions: "Grill patties, toast buns, and assemble with cheese and condiments.",
        slots: ["lunch", "dinner"],
      },
      {
        id: "demo:recipe:domingo-tacos",
        name: "Sunday Tacos",
        ingredients: ["tortillas", "beans", "avocado"],
        instructions: "Warm tortillas and fill with beans and avocado.",
        slots: ["lunch", "dinner"],
      },
    ]);
    expect(publicRead.plans.map(withoutPlanTimestamps)).toEqual([
      { id: "demo:meal-plan:school-lunches", name: "School lunches", active: true },
      { id: "demo:meal-plan:simpson-family-week", name: "Simpson Family Week", active: true },
    ]);
    expect(publicRead.recurringEntries.map(withoutEntryTimestamp)).toEqual([
      {
        id: "demo:meal-entry:recurring:fri:dinner",
        kind: "recurring",
        mealPlanId: "demo:meal-plan:simpson-family-week",
        weekday: "fri",
        date: null,
        slot: "dinner",
        recipeId: "demo:recipe:lisa-lentil-stew",
        note: null,
      },
      {
        id: "demo:meal-entry:recurring:mon:dinner",
        kind: "recurring",
        mealPlanId: "demo:meal-plan:simpson-family-week",
        weekday: "mon",
        date: null,
        slot: "dinner",
        recipeId: "demo:recipe:marge-tomato-soup",
        note: null,
      },
      {
        id: "demo:meal-entry:recurring:sat:breakfast",
        kind: "recurring",
        mealPlanId: "demo:meal-plan:simpson-family-week",
        weekday: "sat",
        date: null,
        slot: "breakfast",
        recipeId: null,
        note: "Waffles with Grampa",
      },
      {
        id: "demo:meal-entry:recurring:sun:snack",
        kind: "recurring",
        mealPlanId: "demo:meal-plan:simpson-family-week",
        weekday: "sun",
        date: null,
        slot: "snack",
        recipeId: "demo:recipe:pink-donut",
        note: null,
      },
      {
        id: "demo:meal-entry:recurring:tue:dinner",
        kind: "recurring",
        mealPlanId: "demo:meal-plan:simpson-family-week",
        weekday: "tue",
        date: null,
        slot: "dinner",
        recipeId: null,
        note: "Leftovers night",
      },
      {
        id: "demo:meal-entry:recurring:wed:dinner",
        kind: "recurring",
        mealPlanId: "demo:meal-plan:simpson-family-week",
        weekday: "wed",
        date: null,
        slot: "dinner",
        recipeId: "demo:recipe:krusty-burger",
        note: null,
      },
    ]);
    expect(
      publicRead.schoolEntries.map(({ id, weekday, slot, recipeId, note }: any) => ({
        id,
        weekday,
        slot,
        recipeId,
        note,
      }))
    ).toEqual([
      {
        id: "demo:meal-entry:recurring:school-lunches:fri:lunch",
        weekday: "fri",
        slot: "lunch",
        recipeId: null,
        note: "Sandwich and fruit",
      },
      {
        id: "demo:meal-entry:recurring:school-lunches:mon:lunch",
        weekday: "mon",
        slot: "lunch",
        recipeId: "demo:recipe:marges-spaghetti",
        note: null,
      },
      {
        id: "demo:meal-entry:recurring:school-lunches:thu:lunch",
        weekday: "thu",
        slot: "lunch",
        recipeId: "demo:recipe:steamed-hams",
        note: null,
      },
      {
        id: "demo:meal-entry:recurring:school-lunches:thu:snack",
        weekday: "thu",
        slot: "snack",
        recipeId: "demo:recipe:apu-samosas",
        note: null,
      },
      {
        id: "demo:meal-entry:recurring:school-lunches:tue:lunch",
        weekday: "tue",
        slot: "lunch",
        recipeId: null,
        note: "Sandwich and fruit",
      },
      {
        id: "demo:meal-entry:recurring:school-lunches:wed:lunch",
        weekday: "wed",
        slot: "lunch",
        recipeId: "demo:recipe:lisa-lentil-stew",
        note: null,
      },
    ]);
    expect(publicRead.menu).toEqual([
      {
        entryId: "demo:meal-entry:recurring:school-lunches:wed:lunch",
        slot: "lunch",
        label: "Lisa's Lentil Stew",
        isTombstone: false,
        source: "recurring",
        planId: "demo:meal-plan:school-lunches",
        recipeId: "demo:recipe:lisa-lentil-stew",
        note: null,
      },
      {
        entryId: "demo:meal-entry:recurring:wed:dinner",
        slot: "dinner",
        label: "Krusty Burger",
        isTombstone: false,
        source: "recurring",
        planId: "demo:meal-plan:simpson-family-week",
        recipeId: "demo:recipe:krusty-burger",
        note: null,
      },
      {
        entryId: "demo:meal-entry:rolling:2026-09-23:breakfast:current-wed-breakfast",
        slot: "breakfast",
        label: "Moon Waffles",
        isTombstone: false,
        source: "oneoff",
        planId: null,
        recipeId: "demo:recipe:moon-waffles",
        note: null,
      },
      {
        entryId: "demo:meal-entry:rolling:2026-09-23:snack:current-snack",
        slot: "snack",
        label: "Pink Donut",
        isTombstone: false,
        source: "oneoff",
        planId: null,
        recipeId: "demo:recipe:pink-donut",
        note: null,
      },
    ]);
    expect(mealRows()).toEqual(firstRows);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing").get()).toEqual({
      count: 0,
    });
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing_block_cache").get()
    ).toEqual({ count: 0 });
  });
});

function withoutRecipeTimestamps({ createdAt: _createdAt, updatedAt: _updatedAt, ...recipe }: any) {
  return recipe;
}

function withoutPlanTimestamps({ createdAt: _createdAt, updatedAt: _updatedAt, ...plan }: any) {
  return plan;
}

function withoutEntryTimestamp({ createdAt: _createdAt, ...entry }: any) {
  return entry;
}

function runMealsSeed(asOfDate: string, nowMs: number) {
  return runSeedProfile({ mode: "public", asOfDate, nowMs, disposableTarget: true });
}

function mealRows() {
  return {
    recipes: getDb().prepare("SELECT * FROM recipes ORDER BY id").all(),
    plans: getDb().prepare("SELECT * FROM meal_plans ORDER BY id").all(),
    entries: getDb().prepare("SELECT * FROM meal_entries ORDER BY id").all(),
  };
}

async function readMealsThroughPublicApi() {
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  const deviceKey = seedDeviceKey();
  try {
    const recipes = await readJson(app, "/api/recipes", deviceKey);
    const plans = await readJson(app, "/api/meal-plans", deviceKey);
    const recurringEntries = await readJson(
      app,
      "/api/meal-plans/demo:meal-plan:simpson-family-week/entries",
      deviceKey
    );
    const schoolEntries = await readJson(
      app,
      "/api/meal-plans/demo:meal-plan:school-lunches/entries",
      deviceKey
    );
    const menu = await readJson(app, `/api/menu?date=${AS_OF_DATE}`, deviceKey);
    return { recipes, plans, recurringEntries, schoolEntries, menu };
  } finally {
    await app.close();
  }
}

function seedDeviceKey(): string {
  const deviceKey = "mpk-seed-meals-boundary";
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run("seed-meals-boundary-device", hashKey(deviceKey), NOW_MS);
  return deviceKey;
}

async function readJson(app: FastifyInstance, url: string, deviceKey: string) {
  const response = await app.inject({ method: "GET", url, cookies: { mp_device_key: deviceKey } });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body);
}
