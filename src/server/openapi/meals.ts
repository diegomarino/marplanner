// Code-first OpenAPI: route schemas for the meals HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { ErrorSchema, Weekday, authenticationBackoffResponse } from "./common";

export const Slot = component("Slot", z.enum(["breakfast", "lunch", "snack", "dinner"]));

export const MealEntry = component(
  "MealEntry",
  z.looseObject({
    id: z.string(),
    kind: z.enum(["recurring", "oneoff"]),
    mealPlanId: z.string().nullable(),
    weekday: z.xor([Weekday, z.null()]),
    date: z.string().nullable().meta({ description: "YYYY-MM-DD (one-off only)" }),
    slot: Slot,
    recipeId: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.int(),
  }),
  {
    description:
      "discriminated: recurring (mealPlanId+weekday) | oneoff (date); content recipeId xor note",
  }
);

export const MealEntryEditInput = component(
  "MealEntryEditInput",
  z.strictObject({
    recipeId: z
      .string()
      .meta({ description: "MUST reference an existing recipe (FR-028)" })
      .optional(),
    note: z.string().min(1).optional(),
  }),
  {
    description:
      "Content-only edit (Clarifications): recipeId xor note, still handler-enforced xor. To change date/weekday/slot, delete the entry and add a new one.\n",
    minProperties: 1,
    maxProperties: 1,
  }
);

export const MealEntryInput = component(
  "MealEntryInput",
  z.strictObject({
    kind: z.enum(["recurring", "oneoff"]),
    mealPlanId: z
      .string()
      .meta({ description: "MUST reference an existing meal_plan (recurring only)" })
      .optional(),
    weekday: Weekday.optional(),
    date: z.string().meta({ description: "YYYY-MM-DD (oneoff only)" }).optional(),
    slot: Slot,
    recipeId: z
      .string()
      .meta({ description: "MUST reference an existing recipe (FR-028)" })
      .optional(),
    note: z.string().min(1).optional(),
  }),
  {
    description:
      "recurring (mealPlanId+weekday, no date) | oneoff (date, no mealPlanId/weekday); content is recipeId xor note",
  }
);

export const MealPlan = component(
  "MealPlan",
  z.looseObject({
    id: z.string(),
    name: z.string().min(1),
    active: z.boolean(),
    createdAt: z.int(),
    updatedAt: z.int(),
  }),
  { description: "A named recurring menu template. Deactivate-only (no hard delete)." }
);

export const MealPlanEditInput = component(
  "MealPlanEditInput",
  z.strictObject({ name: z.string().min(1).optional(), active: z.boolean().optional() }),
  {
    minProperties: 1,
    description: "Rename and/or activate/deactivate; at least one property required.",
  }
);

export const MealPlanInput = component(
  "MealPlanInput",
  z.strictObject({ name: z.string().min(1).meta({ example: "Semana normal" }) })
);

export const MenuItem = component(
  "MenuItem",
  z.looseObject({
    entryId: z.string(),
    slot: Slot,
    label: z.string(),
    isTombstone: z.boolean(),
    source: z.enum(["recurring", "oneoff"]),
    planId: z.string().nullable().meta({
      description:
        "The meal plan a recurring item comes from (its recurring entry's mealPlanId); null for a one-off item. Derived on read, never stored.\n",
    }),
    recipeId: z.string().nullable(),
    note: z.string().nullable(),
  })
);

export const Recipe = component(
  "Recipe",
  z.looseObject({
    id: z.string(),
    name: z.string().min(1),
    ingredients: z.array(z.string()).nullable(),
    instructions: z.string().nullable(),
    slots: z.array(Slot).nullable(),
    createdAt: z.int(),
    updatedAt: z.int(),
  })
);

export const RecipeDependentCounts = component(
  "RecipeDependentCounts",
  z.looseObject({ recurringCount: z.int(), oneOffCount: z.int() }),
  { description: "Split dependent counts, advisory pre-delete (AC-06)." }
);

export const RecipeEditInput = component(
  "RecipeEditInput",
  z.strictObject({
    name: z.string().min(1).optional(),
    ingredients: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    slots: z.array(Slot).optional(),
  }),
  { minProperties: 1, description: "Partial edit; at least one property required." }
);

export const RecipeInput = component(
  "RecipeInput",
  z.strictObject({
    name: z.string().min(1).meta({ example: "Lentejas" }),
    ingredients: z
      .array(z.string())
      .meta({ description: "One entry per line; blanks dropped module-side." })
      .optional(),
    instructions: z
      .string()
      .meta({ description: "Blank-after-trim normalizes to absent." })
      .optional(),
    slots: z
      .array(Slot)
      .meta({ description: "Absent/empty means suitable for all slots (picker suggestion only)." })
      .optional(),
  })
);

export const WeekMenu = component(
  "WeekMenu",
  z.record(z.string(), z.record(z.string(), z.array(MenuItem))),
  {
    description:
      "Week grid: a map of the 7 local YYYY-MM-DD dates of the week (from `weekStartDay` + tz) to that date's derived menu grouped by slot (breakfast/lunch/snack/dinner -> MenuItem[]; an empty slot is `[]`).\n",
  }
);

export const mealsSchemas = defineRouteSchemas({
  /** POST /api/meal-entries */
  createMealEntry: {
    operationId: "createMealEntry",
    tags: ["meals"],
    summary: "Add an entry, recurring (mealPlanId+weekday) or one-off (date).",
    security: [{ deviceKeyCookie: [] }],
    body: MealEntryInput,
    response: {
      201: {
        description: "The created entry.",
        content: { "application/json": { schema: MealEntry } },
      },
      400: {
        description:
          "Invalid kind/date/slot/weekday, both or neither of recipeId/note, date supplied on a recurring entry (or mealPlanId/weekday supplied on a oneoff entry), a recurring entry missing mealPlanId/weekday, or an unrecognized body property.\n",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description:
          "recipeId does not reference an existing recipe (FR-028), or mealPlanId does not reference an existing meal_plan (recurring entries).\n",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/meal-entries/{id} */
  editMealEntry: {
    operationId: "editMealEntry",
    tags: ["meals"],
    summary:
      "Content-only edit (Clarifications): recipeId xor note; date/weekday/slot/unknown keys are rejected. To move an entry, DELETE it and POST a new one.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: MealEntryEditInput,
    response: {
      200: {
        description: "The edited entry.",
        content: { "application/json": { schema: MealEntry } },
      },
      400: {
        description:
          "Both or neither of recipeId/note, a non-content key (date/weekday/slot), or an unrecognized body property.\n",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description:
          "No entry with that id (never or no longer exists), or recipeId does not reference an existing recipe (FR-028).\n",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/meal-entries/{id} */
  deleteMealEntry: {
    operationId: "deleteMealEntry",
    tags: ["meals"],
    summary:
      "Delete a meal entry. Idempotent-by-404 (FR-021 LWW, no etag/version): a second delete against an already-deleted id returns 404, never a no-op 204.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("The entry was removed."),
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No entry with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/meal-plans */
  listMealPlans: {
    operationId: "listMealPlans",
    tags: ["meals"],
    summary: "List all meal_plans (active and inactive).",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "The meal_plans, possibly empty.",
        content: { "application/json": { schema: z.array(MealPlan) } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/meal-plans */
  createMealPlan: {
    operationId: "createMealPlan",
    tags: ["meals"],
    summary: "Create a meal_plan (name required; always created active).",
    security: [{ deviceKeyCookie: [] }],
    body: MealPlanInput,
    response: {
      201: {
        description: "The created meal_plan.",
        content: { "application/json": { schema: MealPlan } },
      },
      400: {
        description: "Blank/missing name, or an unrecognized body property.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/meal-plans/{id} */
  getMealPlan: {
    operationId: "getMealPlan",
    tags: ["meals"],
    summary: "Fetch one meal_plan by id.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: { description: "The meal_plan.", content: { "application/json": { schema: MealPlan } } },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No meal_plan with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/meal-plans/{id} */
  editMealPlan: {
    operationId: "editMealPlan",
    tags: ["meals"],
    summary:
      "Rename and/or activate/deactivate, allow-list name/active (research D5 / #397 lesson — handler-enforced). Deactivate-only: there is NO delete route for meal_plans (Clarifications). Deactivating drops the plan's recurring entries from every derived menu WITHOUT deleting the rows (AC-05); reactivating restores them.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: MealPlanEditInput,
    response: {
      200: {
        description: "The edited meal_plan.",
        content: { "application/json": { schema: MealPlan } },
      },
      400: {
        description: "Blank name, empty patch body, or an unrecognized body property.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No meal_plan with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/meal-plans/{id}/entries */
  listPlanEntries: {
    operationId: "listPlanEntries",
    tags: ["meals"],
    summary:
      "List a plan's recurring entries for management — INCLUDING those of an INACTIVE (deactivated) plan (derived menu reads exclude inactive plans; this is the plan-management read so a deactivated plan's entries can be edited/deleted without reactivating).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: {
        description: "The plan's recurring entries (retained even while the plan is inactive).",
        content: { "application/json": { schema: z.array(MealEntry) } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No meal_plan with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/menu */
  getMenu: {
    operationId: "getMenu",
    tags: ["meals"],
    summary:
      "Derived day menu for ?date=YYYY-MM-DD[&slot=] — the union of recurring entries of every ACTIVE meal_plan whose weekday matches weekdayOf(date, householdTz) and one-off entries for that date, in the full D2 total order; no materialized rows (INV-03); empty list = absence (FR-012); a stale recipe reference renders as a tombstone item (isTombstone:true, INV-09).\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      date: z.string().meta({ description: "YYYY-MM-DD" }),
      slot: Slot.optional(),
    }),
    response: {
      200: {
        description: "The derived menu (MenuItem[]), possibly empty.",
        content: { "application/json": { schema: z.array(MenuItem) } },
      },
      400: {
        description: "Invalid date/slot.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/menu/week */
  getWeekMenu: {
    operationId: "getWeekMenu",
    tags: ["meals"],
    summary:
      "Derived week grid for ?date=YYYY-MM-DD — the 7 local dates of the week containing `date`, starting at the weekStartDay app-setting (0=Sunday/1=Monday, ADR-028), each mapped to its derived day menu grouped by slot (date -> slot -> MenuItem[]); a pure view, no stored week window (FR-019).\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({ date: z.string().meta({ description: "YYYY-MM-DD" }) }),
    response: {
      200: {
        description: "The week grid (WeekMenu).",
        content: { "application/json": { schema: WeekMenu } },
      },
      400: {
        description: "Invalid date.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/recipes */
  listRecipes: {
    operationId: "listRecipes",
    tags: ["meals"],
    summary:
      'List recipes, or search by name with `?search=` (case- and diacritic-insensitive substring match, JS-side — research D4; e.g. `lentejas` matches "Lentejas" and "Lentéjas").\n',
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({ search: z.string().optional() }),
    response: {
      200: {
        description:
          "The matching recipes (all recipes if `search` is absent/empty), possibly empty.",
        content: { "application/json": { schema: z.array(Recipe) } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/recipes */
  createRecipe: {
    operationId: "createRecipe",
    tags: ["meals"],
    summary: "Create a recipe (name required; ingredients/instructions/slots optional).",
    security: [{ deviceKeyCookie: [] }],
    body: RecipeInput,
    response: {
      201: {
        description: "The created recipe.",
        content: { "application/json": { schema: Recipe } },
      },
      400: {
        description: "Blank/missing name, or an unrecognized body property.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/recipes/{id} */
  getRecipe: {
    operationId: "getRecipe",
    tags: ["meals"],
    summary: "Fetch one recipe by id.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: { description: "The recipe.", content: { "application/json": { schema: Recipe } } },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No recipe with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/recipes/{id} */
  editRecipe: {
    operationId: "editRecipe",
    tags: ["meals"],
    summary:
      "Partial recipe edit, allow-list name/ingredients/instructions/slots (research D5 / #397 lesson — handler-enforced). Strict update-by-id (FR-005): a patch against a deleted/unknown id returns 404 and never recreates the row.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: RecipeEditInput,
    response: {
      200: {
        description: "The edited recipe.",
        content: { "application/json": { schema: Recipe } },
      },
      400: {
        description: "Blank name, empty patch body, or an unrecognized body property.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No recipe with that id (never or no longer exists) — no recreate.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/recipes/{id} */
  deleteRecipe: {
    operationId: "deleteRecipe",
    tags: ["meals"],
    summary:
      "Informed-cascade delete (FR-003/004, INV-08): removes the recipe and every referencing entry (recurring + one-off) atomically; an emptied meal_plan survives untouched. Strict update-by-id (FR-005): a delete against an already-deleted id returns 404, never a no-op 204.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("The recipe and its referencing entries were removed."),
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No recipe with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/recipes/{id}/dependents */
  getRecipeDependents: {
    operationId: "getRecipeDependents",
    tags: ["meals"],
    summary:
      "Split dependent counts for a recipe (recurringCount/oneOffCount), advisory pre-delete confirmation (AC-06).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: {
        description: "The split dependent counts.",
        content: { "application/json": { schema: RecipeDependentCounts } },
      },
      401: {
        description: "Missing/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No recipe with that id (never or no longer exists).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
