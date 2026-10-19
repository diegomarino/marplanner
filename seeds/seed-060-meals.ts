import type { Slot, Weekday } from "../src/shared";
import type { SeedModule } from "../src/server/db/seeds/types";
import { readWeekStartDay } from "../src/server/lib/household-date";
import {
  replaceSeedRollingMealEntries,
  upsertSeedMealEntry,
  upsertSeedMealPlan,
  upsertSeedRecipe,
} from "../src/server/modules/meals";

const PLAN_ID = "demo:meal-plan:simpson-family-week";
const SCHOOL_PLAN_ID = "demo:meal-plan:school-lunches";

type RecurringSeed = readonly [
  weekday: Weekday,
  slot: Slot,
  content: { recipeId?: string; note?: string },
];

/** Simpson Family Week keeps its original ids: `demo:meal-entry:recurring:<weekday>:<slot>`. */
const SIMPSON_ENTRIES: readonly RecurringSeed[] = [
  ["mon", "dinner", { recipeId: "demo:recipe:marge-tomato-soup" }],
  ["tue", "dinner", { note: "Leftovers night" }],
  ["wed", "dinner", { recipeId: "demo:recipe:krusty-burger" }],
  ["fri", "dinner", { recipeId: "demo:recipe:lisa-lentil-stew" }],
  ["sat", "breakfast", { note: "Waffles with Grampa" }],
  ["sun", "snack", { recipeId: "demo:recipe:pink-donut" }],
];

/** School lunches ids: `demo:meal-entry:recurring:school-lunches:<weekday>:<slot>`. */
const SCHOOL_ENTRIES: readonly RecurringSeed[] = [
  ["mon", "lunch", { recipeId: "demo:recipe:marges-spaghetti" }],
  ["tue", "lunch", { note: "Sandwich and fruit" }],
  ["wed", "lunch", { recipeId: "demo:recipe:lisa-lentil-stew" }],
  ["thu", "lunch", { recipeId: "demo:recipe:steamed-hams" }],
  ["thu", "snack", { recipeId: "demo:recipe:apu-samosas" }],
  ["fri", "lunch", { note: "Sandwich and fruit" }],
];

const RECIPES = [
  {
    id: "demo:recipe:krusty-burger",
    name: "Krusty Burger",
    ingredients: ["bun", "patty", "pickles"],
    instructions: "Grill the patty and assemble the burger.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:lisa-lentil-stew",
    name: "Lisa's Lentil Stew",
    ingredients: ["lentils", "carrot", "celery"],
    instructions: "Simmer until the lentils are tender.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:marge-tomato-soup",
    name: "Marge's Tomato Soup",
    ingredients: ["tomatoes", "onion", "basil"],
    instructions: "Blend the cooked vegetables until smooth.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:pink-donut",
    name: "Pink Donut",
    ingredients: ["flour", "strawberry glaze"],
    instructions: "Bake, then cover with pink glaze.",
    slots: ["breakfast", "snack"] as Slot[],
  },
  {
    id: "demo:recipe:steamed-hams",
    name: "Steamed Hams",
    ingredients: ["4 hamburger patties", "sesame buns", "ketchup", "mustard"],
    instructions: "Grill patties, toast buns, and assemble with cheese and condiments.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:marges-spaghetti",
    name: "Marge's Spaghetti",
    ingredients: ["spaghetti", "tomatoes", "garlic"],
    instructions: "Cook the pasta and toss it with the tomato sauce.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:flaming-moes",
    name: "Flaming Moe's",
    ingredients: ["citrus soda", "cherry syrup", "ice"],
    instructions: "Chill the ingredients and serve over ice.",
    slots: ["snack"] as Slot[],
  },
  {
    id: "demo:recipe:domingo-tacos",
    name: "Sunday Tacos",
    ingredients: ["tortillas", "beans", "avocado"],
    instructions: "Warm tortillas and fill with beans and avocado.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:apu-samosas",
    name: "Apu's Samosas",
    ingredients: ["potatoes", "peas", "pastry"],
    instructions: "Fill the pastry, seal it, and bake until golden.",
    slots: ["snack", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:bart-pancakes",
    name: "Bart's Pancakes",
    ingredients: ["flour", "milk", "eggs"],
    instructions: "Whisk the batter and cook pancakes on a warm griddle.",
    slots: ["breakfast"] as Slot[],
  },
  {
    id: "demo:recipe:marge-pork-chops",
    name: "Marge's Pork Chops",
    ingredients: ["pork chops", "applesauce", "green beans"],
    instructions: "Pan-fry the chops and serve with warm applesauce and beans.",
    slots: ["dinner"] as Slot[],
  },
  {
    id: "demo:recipe:moon-waffles",
    name: "Moon Waffles",
    ingredients: ["waffle batter", "caramel", "butter"],
    instructions: "Cook the waffles and drizzle with caramel.",
    slots: ["breakfast"] as Slot[],
  },
  {
    id: "demo:recipe:krusty-os",
    name: "Krusty-O's Cereal",
    ingredients: ["Krusty-O's", "milk", "banana"],
    instructions: "Pour, add milk and slice a banana on top.",
    slots: ["breakfast"] as Slot[],
  },
  {
    id: "demo:recipe:wiggum-chili",
    name: "Chief Wiggum's Chili",
    ingredients: ["beans", "ground beef", "tomatoes", "mild peppers"],
    instructions: "Brown the beef, add everything else and simmer for an hour.",
    slots: ["lunch", "dinner"] as Slot[],
  },
  {
    id: "demo:recipe:lard-lad-donut",
    name: "Lard Lad Donut",
    ingredients: ["flour", "sugar", "chocolate glaze", "sprinkles"],
    instructions: "Fry the dough rings and dip them in chocolate glaze.",
    slots: ["breakfast", "snack"] as Slot[],
  },
  {
    id: "demo:recipe:kwik-e-mart-squishee",
    name: "Kwik-E-Mart Squishee",
    ingredients: ["crushed ice", "cherry syrup"],
    instructions: "Blend the ice and pour the syrup over it.",
    slots: ["snack"] as Slot[],
  },
  {
    id: "demo:recipe:marge-pretzels",
    name: "Marge's Pretzels",
    ingredients: ["flour", "yeast", "coarse salt"],
    instructions: "Twist the dough, dip in baking-soda water and bake until brown.",
    slots: ["snack"] as Slot[],
  },
  {
    id: "demo:recipe:lisa-veggie-wrap",
    name: "Lisa's Veggie Wrap",
    ingredients: ["tortilla", "hummus", "cucumber", "spinach"],
    instructions: "Spread the hummus, add the vegetables and roll it up.",
    slots: ["lunch"] as Slot[],
  },
];

type RollingEntry = { date: string; slot: Slot; suffix: string; recipeId?: string; note?: string };

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Pure, deterministic three-week fixture: previous/current/next household weeks. */
export function buildRollingMealEntries(asOfDate: string, weekStartDay: number): RollingEntry[] {
  const weekday = new Date(`${asOfDate}T00:00:00.000Z`).getUTCDay();
  const offset = (weekday - weekStartDay + 7) % 7;
  const weekStart = addDays(asOfDate, -offset);
  const at = (
    offsetFromWeekStart: number,
    slot: Slot,
    suffix: string,
    content: { recipeId?: string; note?: string }
  ) => ({ date: addDays(weekStart, offsetFromWeekStart), slot, suffix, ...content });
  // Together with the recurring plans, every day of the current week gets breakfast, lunch and
  // dinner; the previous and next weeks get a lighter, still navigable spread.
  return [
    at(-7, "breakfast", "previous-mon-breakfast", { recipeId: "demo:recipe:krusty-os" }),
    at(-5, "dinner", "previous-wed-dinner", { recipeId: "demo:recipe:marge-pork-chops" }),
    at(-4, "lunch", "previous-thu-lunch", { recipeId: "demo:recipe:lisa-veggie-wrap" }),
    at(-3, "dinner", "previous-dinner", { recipeId: "demo:recipe:steamed-hams" }),
    at(-2, "breakfast", "previous-sat-breakfast", { recipeId: "demo:recipe:moon-waffles" }),
    at(-2, "dinner", "previous-sat-dinner", { recipeId: "demo:recipe:wiggum-chili" }),
    at(-1, "lunch", "previous-lunch", { note: "Leftovers from the freezer" }),
    at(0, "breakfast", "current-breakfast", { recipeId: "demo:recipe:bart-pancakes" }),
    at(0, "lunch", "current-lunch", { recipeId: "demo:recipe:marges-spaghetti" }),
    at(0, "dinner", "current-dinner", { recipeId: "demo:recipe:krusty-burger" }),
    at(0, "dinner", "current-dinner-note", { note: "Pizza night" }),
    at(1, "breakfast", "current-tue-breakfast", { recipeId: "demo:recipe:krusty-os" }),
    at(1, "snack", "current-tue-snack", { recipeId: "demo:recipe:marge-pretzels" }),
    at(2, "breakfast", "current-wed-breakfast", { recipeId: "demo:recipe:moon-waffles" }),
    at(2, "snack", "current-snack", { recipeId: "demo:recipe:pink-donut" }),
    at(3, "breakfast", "current-thu-breakfast", { recipeId: "demo:recipe:lard-lad-donut" }),
    at(3, "dinner", "current-thu-dinner", { recipeId: "demo:recipe:marge-pork-chops" }),
    at(4, "breakfast", "current-fri-breakfast", { recipeId: "demo:recipe:bart-pancakes" }),
    at(4, "snack", "current-fri-snack", { recipeId: "demo:recipe:kwik-e-mart-squishee" }),
    at(5, "lunch", "current-sat-lunch", { recipeId: "demo:recipe:lisa-veggie-wrap" }),
    at(5, "dinner", "current-sat-dinner", { recipeId: "demo:recipe:wiggum-chili" }),
    at(5, "snack", "current-sat-snack", { note: "Chili cook-off tasting" }),
    at(6, "breakfast", "current-sun-breakfast", { recipeId: "demo:recipe:lard-lad-donut" }),
    at(6, "lunch", "current-sun-lunch", { note: "Barbecue at the Flanders'" }),
    at(6, "dinner", "current-friday", { recipeId: "demo:recipe:lisa-lentil-stew" }),
    at(7, "breakfast", "next-breakfast", { recipeId: "demo:recipe:pink-donut" }),
    at(8, "dinner", "next-tue-dinner", { recipeId: "demo:recipe:marge-pork-chops" }),
    at(9, "snack", "next-snack", { recipeId: "demo:recipe:apu-samosas" }),
    at(10, "breakfast", "next-thu-breakfast", { recipeId: "demo:recipe:moon-waffles" }),
    at(11, "dinner", "next-dinner-note", { note: "Takeout from Luigi's" }),
    at(12, "lunch", "next-sat-lunch", { recipeId: "demo:recipe:wiggum-chili" }),
    at(12, "dinner", "next-sat-dinner", { note: "Anniversary dinner out" }),
    at(13, "dinner", "next-dinner", { recipeId: "demo:recipe:domingo-tacos" }),
  ];
}

const mealsSeed: SeedModule = {
  id: "meals:demo",
  run({ asOfDate, nowMs }) {
    for (const recipe of RECIPES) upsertSeedRecipe({ ...recipe, nowMs });
    upsertSeedMealPlan({ id: PLAN_ID, nowMs, name: "Simpson Family Week" });
    // One millisecond later, so Simpson Family Week keeps the first plan colour (creation order).
    upsertSeedMealPlan({ id: SCHOOL_PLAN_ID, nowMs: nowMs + 1, name: "School lunches" });
    for (const [weekday, slot, content] of SIMPSON_ENTRIES) {
      upsertSeedMealEntry({
        id: `demo:meal-entry:recurring:${weekday}:${slot}`,
        nowMs,
        kind: "recurring",
        mealPlanId: PLAN_ID,
        weekday,
        slot,
        ...content,
      });
    }
    for (const [weekday, slot, content] of SCHOOL_ENTRIES) {
      upsertSeedMealEntry({
        id: `demo:meal-entry:recurring:school-lunches:${weekday}:${slot}`,
        nowMs,
        kind: "recurring",
        mealPlanId: SCHOOL_PLAN_ID,
        weekday,
        slot,
        ...content,
      });
    }
    const rollingEntries = buildRollingMealEntries(asOfDate, readWeekStartDay());
    const rollingIds = rollingEntries.map(
      (entry) => `demo:meal-entry:rolling:${entry.date}:${entry.slot}:${entry.suffix}`
    );
    replaceSeedRollingMealEntries(asOfDate, rollingIds);
    for (const entry of rollingEntries) {
      upsertSeedMealEntry({
        id: `demo:meal-entry:rolling:${entry.date}:${entry.slot}:${entry.suffix}`,
        nowMs,
        kind: "oneoff",
        date: entry.date,
        slot: entry.slot,
        recipeId: entry.recipeId,
        note: entry.note,
      });
    }
  },
};

export default mealsSeed;
