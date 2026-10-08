import { isWeekday } from "../../../shared/weekdays";
import { randomUUID } from "node:crypto";
import type {
  Recipe,
  MealPlan,
  MealPlanEditInput,
  MealEntry,
  MealEntryEditInput,
  MenuItem,
  RecipeDependentCounts,
  Slot,
  Weekday,
} from "../../../shared";
import {
  isStrictCalendarDate,
  readHouseholdTimezone,
  weekdayOf,
  readWeekStartDay,
  getDb,
} from "../../host-api";

// ── Error types ────────────────────────────────────────────────────────────

export class MealValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealValidationError";
  }
}

export class MealNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealNotFoundError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_SLOTS = new Set<string>(["breakfast", "lunch", "snack", "dinner"]);

// ── Recipe field normalization (FR-001/FR-002) ──────────────────────────────

type RecipeRow = {
  id: string;
  name: string;
  ingredients: string | null;
  instructions: string | null;
  slots: string | null;
  created_at: number;
  updated_at: number;
};

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    name: row.name,
    ingredients: row.ingredients === null ? null : row.ingredients.split("\n"),
    instructions: row.instructions,
    slots: row.slots === null ? null : (JSON.parse(row.slots) as Slot[]),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize `ingredients`: split every element on embedded newlines too (so a create
 * response and the persisted/read value always agree — `\n`-joined storage would
 * otherwise re-split an embedded newline on read), trim each resulting line, drop
 * blanks. `[]`/all-blank -> null.
 */
function normalizeIngredients(value: unknown): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || !value.every((line) => typeof line === "string")) {
    throw new MealValidationError("ingredients must be an array of strings");
  }
  const normalized = value
    .flatMap((line) => line.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return normalized.length > 0 ? normalized : null;
}

/** Blank-after-trim `instructions` normalizes to absent (null); non-blank stored verbatim. */
function normalizeInstructions(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new MealValidationError("instructions must be a string");
  }
  return value.trim().length > 0 ? value : null;
}

/** Absent/empty `slots` -> null (suitable for all slot pickers, FR-002). */
function normalizeSlots(value: unknown): Slot[] | null {
  if (value === undefined) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    !value.every((slot) => typeof slot === "string" && VALID_SLOTS.has(slot))
  ) {
    throw new MealValidationError("slots must be an array of valid slot values");
  }
  return value.length > 0 ? (value as Slot[]) : null;
}

type SeedObject = Record<string, unknown> & { id: string; nowMs: number };

function seedObject(input: unknown, idPrefix: string, allowedKeys: string[]): SeedObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MealValidationError("Seed input must be an object");
  }
  const value = input as Record<string, unknown>;
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(`Unsupported field(s) in seed body: ${unknownKeys.join(", ")}`);
  }
  if (
    typeof value.id !== "string" ||
    !value.id.startsWith(idPrefix) ||
    value.id.length === idPrefix.length
  ) {
    throw new MealValidationError(`Seed ID must start with ${idPrefix}`);
  }
  if (typeof value.nowMs !== "number" || !Number.isSafeInteger(value.nowMs) || value.nowMs < 0) {
    throw new MealValidationError("Seed timestamp must be a non-negative integer");
  }
  return value as SeedObject;
}

function requiredRecipeName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MealValidationError("name is required and must not be blank");
  }
  return value.trim();
}

// ── Create recipe ────────────────────────────────────────────────────────

const ALLOWED_RECIPE_CREATE_KEYS = new Set(["name", "ingredients", "instructions", "slots"]);

const SEED_RECIPE_ID_PREFIX = "demo:recipe:";
const SEED_MEAL_PLAN_ID_PREFIX = "demo:meal-plan:";
const SEED_MEAL_ENTRY_ID_PREFIX = "demo:meal-entry:";
const SEED_ROLLING_MEAL_ENTRY_ID =
  /^demo:meal-entry:rolling:(\d{4}-\d{2}-\d{2}):(breakfast|lunch|snack|dinner):[a-z0-9-]+$/;

/** Create a recipe. `name` is required, non-blank, and stored * trimmed* * (`MEALS-RECIPES-INV-11`, — required, non-blank, trimmed).
 * `ingredients` normalize one-per-line with blanks dropped; `instructions`
 * blank normalizes to absent but is otherwise stored * verbatim* (trim only
 * validates — same rule as the note-verbatim fix, INV-13, which does
 * NOT extend to `name`); absent/empty `slots` means suitable for all slots
 * (FR-001/FR-002).
 */
export function createRecipe(input: unknown): Recipe {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MealValidationError("Request body must be an object");
  }

  const unknownKeys = Object.keys(input).filter((key) => !ALLOWED_RECIPE_CREATE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(`Unsupported field(s) in recipe body: ${unknownKeys.join(", ")}`);
  }

  const { name, ingredients, instructions, slots } = input as {
    name?: unknown;
    ingredients?: unknown;
    instructions?: unknown;
    slots?: unknown;
  };

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new MealValidationError("name is required and must not be blank");
  }
  const trimmedName = name.trim();

  const normalizedIngredients = normalizeIngredients(ingredients);
  const normalizedInstructions = normalizeInstructions(instructions);
  const normalizedSlots = normalizeSlots(slots);

  const id = randomUUID();
  const now = Date.now();
  const db = getDb();
  db.prepare(
    "INSERT INTO recipes (id, name, ingredients, instructions, slots, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    trimmedName,
    normalizedIngredients ? normalizedIngredients.join("\n") : null,
    normalizedInstructions,
    normalizedSlots ? JSON.stringify(normalizedSlots) : null,
    now,
    now
  );

  return {
    id,
    name: trimmedName,
    ingredients: normalizedIngredients,
    instructions: normalizedInstructions,
    slots: normalizedSlots,
    createdAt: now,
    updatedAt: now,
  };
}

/** Canonical seed-only recipe write. The stable demo ID and injected timestamp deliberately stay
 * outside the ordinary public create surface, whose UUID/clock remain authoritative for users.
 */
export function upsertSeedRecipe(input: unknown): Recipe {
  const value = seedObject(input, SEED_RECIPE_ID_PREFIX, [
    "id",
    "nowMs",
    "name",
    "ingredients",
    "instructions",
    "slots",
  ]);
  const name = requiredRecipeName(value.name);
  const ingredients = normalizeIngredients(value.ingredients);
  const instructions = normalizeInstructions(value.instructions);
  const slots = normalizeSlots(value.slots);
  const db = getDb();
  const ingredientsValue = ingredients ? ingredients.join("\n") : null;
  const slotsValue = slots ? JSON.stringify(slots) : null;

  db.prepare(
    `INSERT INTO recipes (id, name, ingredients, instructions, slots, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       ingredients = excluded.ingredients,
       instructions = excluded.instructions,
       slots = excluded.slots,
       updated_at = excluded.updated_at
     WHERE name IS NOT excluded.name
        OR ingredients IS NOT excluded.ingredients
        OR instructions IS NOT excluded.instructions
        OR slots IS NOT excluded.slots`
  ).run(value.id, name, ingredientsValue, instructions, slotsValue, value.nowMs, value.nowMs);

  return getRecipe(value.id);
}

// ── Edit recipe (partial, strict update-by-id) ───────────────────────────

const EDITABLE_RECIPE_KEYS = new Set(["name", "ingredients", "instructions", "slots"]);

/** Partial recipe edit, allow-list `name`/`ingredients`/`instructions`/`slots`
 * (lesson — handler AND module both enforce). Strict
 * update-by-id (FR-005): a patch against a deleted/unknown id throws
 * `MealNotFoundError`, never recreating the row.
 */
export function editRecipe(id: string, patch: unknown): Recipe {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MealValidationError("Patch body must be a JSON object");
  }

  const patchKeys = Object.keys(patch);
  const unknownKeys = patchKeys.filter((key) => !EDITABLE_RECIPE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(`Unsupported field(s) in patch body: ${unknownKeys.join(", ")}`);
  }
  if (patchKeys.length === 0) {
    throw new MealValidationError(
      "Patch body must include at least one of: name, ingredients, instructions, slots"
    );
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | undefined;
  if (!row) {
    throw new MealNotFoundError(`Recipe not found: ${id}`);
  }

  const { name, ingredients, instructions, slots } = patch as {
    name?: unknown;
    ingredients?: unknown;
    instructions?: unknown;
    slots?: unknown;
  };

  const updates: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new MealValidationError("name must not be blank");
    }
    updates.push("name = ?");
    params.push(name.trim());
  }
  if (ingredients !== undefined) {
    const normalized = normalizeIngredients(ingredients);
    updates.push("ingredients = ?");
    params.push(normalized ? normalized.join("\n") : null);
  }
  if (instructions !== undefined) {
    const normalized = normalizeInstructions(instructions);
    updates.push("instructions = ?");
    params.push(normalized);
  }
  if (slots !== undefined) {
    const normalized = normalizeSlots(slots);
    updates.push("slots = ?");
    params.push(normalized ? JSON.stringify(normalized) : null);
  }

  const now = Date.now();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(id);

  db.prepare(`UPDATE recipes SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  return getRecipe(id);
}

// ── List / get / search recipes ──────────────────────────────────────────

/** List all recipes, ordered by name (matches the `recipes(name)` list-ordering index). */
export function listRecipes(): Recipe[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM recipes ORDER BY name ASC, id ASC").all() as RecipeRow[];
  return rows.map(rowToRecipe);
}

/** Fetch one recipe by id. Throws `MealNotFoundError` if it never existed or was deleted. */
export function getRecipe(id: string): Recipe {
  const db = getDb();
  const row = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | undefined;
  if (!row) {
    throw new MealNotFoundError(`Recipe not found: ${id}`);
  }
  return rowToRecipe(row);
}

/** NFD-diacritic-strip + lowercase, for case/diacritic-insensitive substring search. */
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Search recipes by name, case- and diacritic-insensitive substring match
 * (— JS-side, not a DB column/index; kiosk-scale row count).
 * Stored names are never mutated by search.
 */
export function searchRecipes(query: string): Recipe[] {
  const normalizedQuery = normalizeForSearch(query);
  return listRecipes().filter((recipe) =>
    normalizeForSearch(recipe.name).includes(normalizedQuery)
  );
}

// ── Meal plans (deactivate-only — no hard delete, Clarifications) ──────────

type MealPlanRow = {
  id: string;
  name: string;
  active: number;
  created_at: number;
  updated_at: number;
};

function rowToMealPlan(row: MealPlanRow): MealPlan {
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ALLOWED_MEAL_PLAN_CREATE_KEYS = new Set(["name"]);

/** Create a meal_plan. `name` is required, non-blank, stored trimmed; always created active. */
export function createMealPlan(input: unknown): MealPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MealValidationError("Request body must be an object");
  }

  const unknownKeys = Object.keys(input).filter((key) => !ALLOWED_MEAL_PLAN_CREATE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(
      `Unsupported field(s) in meal_plan body: ${unknownKeys.join(", ")}`
    );
  }

  const { name } = input as { name?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new MealValidationError("name is required and must not be blank");
  }
  const trimmedName = name.trim();

  const id = randomUUID();
  const now = Date.now();
  const db = getDb();
  db.prepare(
    "INSERT INTO meal_plans (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)"
  ).run(id, trimmedName, now, now);

  return { id, name: trimmedName, active: true, createdAt: now, updatedAt: now };
}

/** Canonical seed-only plan write with a stable demo ID and injected timestamp. */
export function upsertSeedMealPlan(input: unknown): MealPlan {
  const value = seedObject(input, SEED_MEAL_PLAN_ID_PREFIX, ["id", "nowMs", "name"]);
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new MealValidationError("name is required and must not be blank");
  }
  const name = value.name.trim();
  const db = getDb();
  db.prepare(
    `INSERT INTO meal_plans (id, name, active, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       active = excluded.active,
       updated_at = excluded.updated_at
     WHERE name IS NOT excluded.name OR active IS NOT excluded.active`
  ).run(value.id, name, value.nowMs, value.nowMs);
  return getMealPlan(value.id);
}

/** List all meal_plans (active and inactive), ordered by name. */
export function listMealPlans(): MealPlan[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM meal_plans ORDER BY name ASC, id ASC")
    .all() as MealPlanRow[];
  return rows.map(rowToMealPlan);
}

/** Fetch one meal_plan by id. Throws `MealNotFoundError` if it never existed. */
export function getMealPlan(id: string): MealPlan {
  const db = getDb();
  const row = db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(id) as
    MealPlanRow | undefined;
  if (!row) {
    throw new MealNotFoundError(`Meal plan not found: ${id}`);
  }
  return rowToMealPlan(row);
}

/** Rename a meal_plan. `name` must be non-blank; throws `MealNotFoundError` for an unknown id. */
export function renameMealPlan(id: string, name: unknown): MealPlan {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new MealValidationError("name must not be blank");
  }
  const trimmedName = name.trim();

  const db = getDb();
  const existing = db.prepare("SELECT id FROM meal_plans WHERE id = ?").get(id);
  if (!existing) {
    throw new MealNotFoundError(`Meal plan not found: ${id}`);
  }

  const now = Date.now();
  db.prepare("UPDATE meal_plans SET name = ?, updated_at = ? WHERE id = ?").run(
    trimmedName,
    now,
    id
  );
  return getMealPlan(id);
}

/** Activate/deactivate a meal_plan (no hard delete, Clarifications). Deactivating drops the
 * plan's recurring entries from every derived menu WITHOUT deleting the rows (AC-05);
 * reactivating restores them. Throws `MealNotFoundError` for an unknown id.
 */
export function setMealPlanActive(id: string, active: unknown): MealPlan {
  if (typeof active !== "boolean") {
    throw new MealValidationError("active must be a boolean");
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM meal_plans WHERE id = ?").get(id);
  if (!existing) {
    throw new MealNotFoundError(`Meal plan not found: ${id}`);
  }

  const now = Date.now();
  db.prepare("UPDATE meal_plans SET active = ?, updated_at = ? WHERE id = ?").run(
    active ? 1 : 0,
    now,
    id
  );
  return getMealPlan(id);
}

const EDITABLE_MEAL_PLAN_KEYS = new Set(["name", "active"]);

/** Partial meal_plan edit — allow-list `name`/`active` (lesson —
 * handler-enforced), at least one required. Dispatches to `renameMealPlan`/`setMealPlanActive`
 * inside ONE `db.transaction` so a rejected PATCH persists nothing: e.g. a valid `name` with
 * an invalid `active` must not commit the rename before the `active` validation throws.
 */
export function editMealPlan(id: string, patch: unknown): MealPlan {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MealValidationError("Patch body must be a JSON object");
  }

  const patchKeys = Object.keys(patch);
  const unknownKeys = patchKeys.filter((key) => !EDITABLE_MEAL_PLAN_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(`Unsupported field(s) in patch body: ${unknownKeys.join(", ")}`);
  }
  if (patchKeys.length === 0) {
    throw new MealValidationError("Patch body must include at least one of: name, active");
  }

  const { name, active } = patch as MealPlanEditInput;
  const db = getDb();
  db.transaction(() => {
    if (name !== undefined) {
      renameMealPlan(id, name);
    }
    if (active !== undefined) {
      setMealPlanActive(id, active);
    }
  })();
  return getMealPlan(id);
}

/** List a meal_plan's recurring entries for management — INCLUDING those of an INACTIVE plan
 * (derived menu reads exclude inactive plans, so a deactivated plan's retained entries would
 * otherwise be unreachable for edit/delete). Throws `MealNotFoundError` for an unknown plan id.
 */
export function listPlanEntries(planId: string): MealEntry[] {
  const db = getDb();
  const plan = db.prepare("SELECT id FROM meal_plans WHERE id = ?").get(planId);
  if (!plan) {
    throw new MealNotFoundError(`Meal plan not found: ${planId}`);
  }

  const rows = db
    .prepare("SELECT * FROM meal_entries WHERE meal_plan_id = ? ORDER BY created_at ASC, id ASC")
    .all(planId) as EntryRow[];
  return rows.map(rowToMealEntry);
}

// ── Create entry (recurring | one-off) ───────────────────────────────────

/** Add a meal entry — recurring (`mealPlanId`+`weekday`) or one-off (`date`)
 * — with content `recipeId` xor `note`. `recipeId` MUST reference an
 * existing recipe (FR-028) and `mealPlanId` MUST reference an existing
 * meal_plan (same rationale), both checked here before insert so an unknown
 * ref never surfaces as a raw DB FK-constraint error.
 */
export function createEntry(input: unknown): MealEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MealValidationError("Request body must be an object");
  }

  const allowedKeys = new Set([
    "kind",
    "date",
    "slot",
    "recipeId",
    "note",
    "mealPlanId",
    "weekday",
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(`Unsupported field(s) in entry body: ${unknownKeys.join(", ")}`);
  }

  const { kind, date, slot, recipeId, note, mealPlanId, weekday } = input as {
    kind?: unknown;
    date?: unknown;
    slot?: unknown;
    recipeId?: unknown;
    note?: unknown;
    mealPlanId?: unknown;
    weekday?: unknown;
  };

  if (kind !== "oneoff" && kind !== "recurring") {
    throw new MealValidationError('kind must be "oneoff" or "recurring"');
  }
  if (typeof slot !== "string" || !VALID_SLOTS.has(slot)) {
    throw new MealValidationError(`Invalid slot "${String(slot)}"`);
  }

  const hasRecipeId = recipeId !== undefined;
  const hasNote = note !== undefined;
  if (hasRecipeId === hasNote) {
    throw new MealValidationError("Exactly one of recipeId or note is required");
  }

  const db = getDb();

  let content: { recipeId: string | null; note: string | null };
  if (hasRecipeId) {
    if (typeof recipeId !== "string" || recipeId.trim().length === 0) {
      throw new MealValidationError("recipeId must be a non-blank string");
    }
    const recipeRow = db.prepare("SELECT id FROM recipes WHERE id = ?").get(recipeId);
    if (!recipeRow) {
      throw new MealNotFoundError(`Recipe not found: ${recipeId}`);
    }
    content = { recipeId, note: null };
  } else {
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new MealValidationError("note must be a non-blank string");
    }
    content = { recipeId: null, note };
  }

  // Kind discriminant: "oneoff" carries exactly `date` and never
  // the recurring pair; "recurring" carries exactly `mealPlanId`+`weekday`
  // and never `date`.
  let mealPlanIdValue: string | null = null;
  let weekdayValue: string | null = null;
  let dateValue: string | null = null;

  if (kind === "oneoff") {
    if (mealPlanId !== undefined || weekday !== undefined) {
      throw new MealValidationError("mealPlanId/weekday are not allowed on a oneoff entry");
    }
    if (typeof date !== "string" || !isStrictCalendarDate(date)) {
      throw new MealValidationError(`Invalid date "${String(date)}"`);
    }
    dateValue = date;
  } else {
    if (date !== undefined) {
      throw new MealValidationError("date is not allowed on a recurring entry");
    }
    if (typeof mealPlanId !== "string" || mealPlanId.trim().length === 0) {
      throw new MealValidationError("mealPlanId is required for a recurring entry");
    }
    if (!isWeekday(weekday)) {
      throw new MealValidationError(`Invalid weekday "${String(weekday)}"`);
    }
    const planRow = db.prepare("SELECT id FROM meal_plans WHERE id = ?").get(mealPlanId);
    if (!planRow) {
      throw new MealNotFoundError(`Meal plan not found: ${mealPlanId}`);
    }
    mealPlanIdValue = mealPlanId;
    weekdayValue = weekday;
  }

  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, mealPlanIdValue, weekdayValue, dateValue, slot, content.recipeId, content.note, now);

  return {
    id,
    kind,
    mealPlanId: mealPlanIdValue,
    weekday: weekdayValue as Weekday | null,
    date: dateValue,
    slot: slot as Slot,
    recipeId: content.recipeId,
    note: content.note,
    createdAt: now,
  };
}

/** Canonical seed-only entry write. It retains the same kind/content/FK validation as user writes
 * while making the identity and write timestamp explicit for deterministic demo data.
 */
export function upsertSeedMealEntry(input: unknown): MealEntry {
  const value = seedObject(input, SEED_MEAL_ENTRY_ID_PREFIX, [
    "id",
    "nowMs",
    "kind",
    "date",
    "slot",
    "recipeId",
    "note",
    "mealPlanId",
    "weekday",
  ]);
  const entry = validatedEntry(value);
  const db = getDb();
  db.prepare(
    `INSERT INTO meal_entries
       (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       meal_plan_id = excluded.meal_plan_id,
       weekday = excluded.weekday,
       entry_date = excluded.entry_date,
       slot = excluded.slot,
       recipe_id = excluded.recipe_id,
       note = excluded.note
     WHERE meal_plan_id IS NOT excluded.meal_plan_id
        OR weekday IS NOT excluded.weekday
        OR entry_date IS NOT excluded.entry_date
        OR slot IS NOT excluded.slot
        OR recipe_id IS NOT excluded.recipe_id
        OR note IS NOT excluded.note`
  ).run(
    value.id,
    entry.mealPlanId,
    entry.weekday,
    entry.date,
    entry.slot,
    entry.recipeId,
    entry.note,
    value.nowMs
  );

  return seedMealEntry(value.id);
}

/** Removes only exact rolling rows owned by this seed; unrelated rows abort the seed transaction. */
export function replaceSeedRollingMealEntries(
  asOfDate: string,
  keepIds: readonly string[] = []
): void {
  if (!isStrictCalendarDate(asOfDate)) {
    throw new MealValidationError(`Invalid date "${String(asOfDate)}"`);
  }
  const db = getDb();
  const rows = db
    .prepare("SELECT id, entry_date FROM meal_entries WHERE entry_date IS NOT NULL")
    .all() as { id: string; entry_date: string }[];
  const remove = db.prepare("DELETE FROM meal_entries WHERE id = ?");
  const keep = new Set(keepIds);
  for (const row of rows) {
    if (isSeedRollingMealEntry(row) && !keep.has(row.id)) remove.run(row.id);
    else if (!row.id.startsWith("demo:meal-entry:"))
      throw new MealValidationError(`unrelated row in meal_entries: ${row.id}`);
  }
}

function isSeedRollingMealEntry(row: { id: string; entry_date: string }): boolean {
  const match = SEED_ROLLING_MEAL_ENTRY_ID.exec(row.id);
  return match !== null && match[1] === row.entry_date && isStrictCalendarDate(match[1]);
}

// ── Edit entry (content-only, strict-by-id) ──────────────────────────────

type EntryRow = {
  id: string;
  meal_plan_id: string | null;
  weekday: string | null;
  entry_date: string | null;
  slot: string;
  recipe_id: string | null;
  note: string | null;
  created_at: number;
};

function rowToMealEntry(row: EntryRow): MealEntry {
  return {
    id: row.id,
    kind: row.meal_plan_id !== null ? "recurring" : "oneoff",
    mealPlanId: row.meal_plan_id,
    weekday: row.weekday as MealEntry["weekday"],
    date: row.entry_date,
    slot: row.slot as Slot,
    recipeId: row.recipe_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

type ValidatedEntry = {
  kind: "oneoff" | "recurring";
  mealPlanId: string | null;
  weekday: Weekday | null;
  date: string | null;
  slot: Slot;
  recipeId: string | null;
  note: string | null;
};

function validatedEntry(value: Record<string, unknown>): ValidatedEntry {
  const { kind, date, slot, recipeId, note, mealPlanId, weekday } = value;
  if (kind !== "oneoff" && kind !== "recurring") {
    throw new MealValidationError('kind must be "oneoff" or "recurring"');
  }
  if (typeof slot !== "string" || !VALID_SLOTS.has(slot)) {
    throw new MealValidationError(`Invalid slot "${String(slot)}"`);
  }

  const hasRecipeId = recipeId !== undefined;
  const hasNote = note !== undefined;
  if (hasRecipeId === hasNote) {
    throw new MealValidationError("Exactly one of recipeId or note is required");
  }

  const db = getDb();
  let content: { recipeId: string | null; note: string | null };
  if (hasRecipeId) {
    if (typeof recipeId !== "string" || recipeId.trim().length === 0) {
      throw new MealValidationError("recipeId must be a non-blank string");
    }
    if (!db.prepare("SELECT id FROM recipes WHERE id = ?").get(recipeId)) {
      throw new MealNotFoundError(`Recipe not found: ${recipeId}`);
    }
    content = { recipeId, note: null };
  } else {
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new MealValidationError("note must be a non-blank string");
    }
    content = { recipeId: null, note };
  }

  if (kind === "oneoff") {
    if (mealPlanId !== undefined || weekday !== undefined) {
      throw new MealValidationError("mealPlanId/weekday are not allowed on a oneoff entry");
    }
    if (typeof date !== "string" || !isStrictCalendarDate(date)) {
      throw new MealValidationError(`Invalid date "${String(date)}"`);
    }
    return {
      kind,
      mealPlanId: null,
      weekday: null,
      date,
      slot: slot as Slot,
      ...content,
    };
  }

  if (date !== undefined) {
    throw new MealValidationError("date is not allowed on a recurring entry");
  }
  if (typeof mealPlanId !== "string" || mealPlanId.trim().length === 0) {
    throw new MealValidationError("mealPlanId is required for a recurring entry");
  }
  if (!isWeekday(weekday)) {
    throw new MealValidationError(`Invalid weekday "${String(weekday)}"`);
  }
  if (!db.prepare("SELECT id FROM meal_plans WHERE id = ?").get(mealPlanId)) {
    throw new MealNotFoundError(`Meal plan not found: ${mealPlanId}`);
  }
  return {
    kind,
    mealPlanId,
    weekday: weekday as Weekday,
    date: null,
    slot: slot as Slot,
    ...content,
  };
}

function seedMealEntry(id: string): MealEntry {
  const row = getDb().prepare("SELECT * FROM meal_entries WHERE id = ?").get(id) as
    EntryRow | undefined;
  if (!row) {
    throw new MealNotFoundError(`Meal entry not found: ${id}`);
  }
  return rowToMealEntry(row);
}

const EDITABLE_ENTRY_KEYS = new Set(["recipeId", "note"]);

/** Content-only entry edit (Clarifications): the allow-list is exactly
 * `recipeId`/`note`, still content-discriminant xor (FR-010/011) — any
 * other key (`date`/`weekday`/`slot`/unknown) is rejected with 400; to move
 * an entry to a different date/slot, delete it and add a new one. `recipeId`
 * is existence-checked before the write (FR-028), never a raw FK error.
 * Strict update-by-id (FR-005): a patch against a deleted/unknown id throws
 * `MealNotFoundError`, never recreating the row.
 */
export function editEntry(id: string, patch: unknown): MealEntry {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MealValidationError("Patch body must be a JSON object");
  }

  const patchKeys = Object.keys(patch);
  const unknownKeys = patchKeys.filter((key) => !EDITABLE_ENTRY_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new MealValidationError(
      `Unsupported field(s) in entry patch body (content-only: recipeId/note): ${unknownKeys.join(", ")}`
    );
  }

  const { recipeId, note } = patch as MealEntryEditInput;
  const hasRecipeId = recipeId !== undefined;
  const hasNote = note !== undefined;
  if (hasRecipeId === hasNote) {
    throw new MealValidationError("Exactly one of recipeId or note is required");
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM meal_entries WHERE id = ?").get(id);
  if (!existing) {
    throw new MealNotFoundError(`Meal entry not found: ${id}`);
  }

  let newRecipeId: string | null;
  let newNote: string | null;
  if (hasRecipeId) {
    if (typeof recipeId !== "string" || recipeId.trim().length === 0) {
      throw new MealValidationError("recipeId must be a non-blank string");
    }
    const recipeRow = db.prepare("SELECT id FROM recipes WHERE id = ?").get(recipeId);
    if (!recipeRow) {
      throw new MealNotFoundError(`Recipe not found: ${recipeId}`);
    }
    newRecipeId = recipeId;
    newNote = null;
  } else {
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new MealValidationError("note must be a non-blank string");
    }
    newRecipeId = null;
    newNote = note;
  }

  db.prepare("UPDATE meal_entries SET recipe_id = ?, note = ? WHERE id = ?").run(
    newRecipeId,
    newNote,
    id
  );

  const row = db.prepare("SELECT * FROM meal_entries WHERE id = ?").get(id) as EntryRow;
  return rowToMealEntry(row);
}

// ── Delete entry (idempotent, LWW) ────────────────────────────────────────

/** Delete a meal entry by id. Idempotent by design (FR-021 LWW, no
 * etag/version): a second delete against an already-deleted id throws
 * `MealNotFoundError` (404), never a no-op 204.
 */
export function deleteEntry(id: string): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM meal_entries WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new MealNotFoundError(`Meal entry not found: ${id}`);
  }
}

// ── Recipe dependents + informed-cascade delete (FR-003/004, AC-06) ──────

/** Split dependent counts for a recipe (advisory pre-delete, AC-06):
 * `recurringCount` (referencing recurring entries) / `oneOffCount`
 * (referencing one-off entries). Unknown recipe id -> `MealNotFoundError`.
 */
export function getRecipeDependents(recipeId: string): RecipeDependentCounts {
  const db = getDb();
  const recipe = db.prepare("SELECT id FROM recipes WHERE id = ?").get(recipeId);
  if (!recipe) {
    throw new MealNotFoundError(`Recipe not found: ${recipeId}`);
  }

  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN meal_plan_id IS NOT NULL THEN 1 ELSE 0 END) AS recurring_count,
         SUM(CASE WHEN entry_date IS NOT NULL THEN 1 ELSE 0 END) AS one_off_count
       FROM meal_entries WHERE recipe_id = ?`
    )
    .get(recipeId) as { recurring_count: number | null; one_off_count: number | null };

  return {
    recurringCount: row.recurring_count ?? 0,
    oneOffCount: row.one_off_count ?? 0,
  };
}

/** Informed-cascade recipe delete (FR-003/FR-004, `INV-08`): removes the
 * recipe and every referencing entry (recurring + one-off) atomically. The
 * `recipe_id -> recipes ON DELETE CASCADE` FK (`PRAGMA foreign_keys = ON`)
 * removes referencing `meal_entries` rows as part of the same statement;
 * `meal_plan` rows are never touched (deactivate-only retirement, Clarifications).
 * Unknown/deleted recipe id -> `MealNotFoundError` (FR-005 strict-by-id,
 * never recreates).
 */
export function deleteRecipe(id: string): void {
  const db = getDb();
  const changes = db.transaction(() => {
    const result = db.prepare("DELETE FROM recipes WHERE id = ?").run(id);
    return result.changes;
  })();
  if (changes === 0) {
    throw new MealNotFoundError(`Recipe not found: ${id}`);
  }
}

// ── Derived menu (recurring union of active plans + one-off, D2 total order) ─

type MenuRow = {
  entry_id: string;
  slot: string;
  recipe_id: string | null;
  note: string | null;
  recipe_name: string | null;
  meal_plan_id: string | null;
};

// Both branches of the UNION ALL project the same column shape (including an
// explicit `kind_rank` column — SQLite's compound-SELECT ORDER BY only
// accepts bare output-column names/ordinals, not arbitrary expressions like
// a CASE) so a single ORDER BY can apply the full D2 total order across the
// combined result: kind rank (recurring before one-off) -> plan name ASC ->
// meal_plan_id ASC (duplicate-plan-name tiebreak) -> created_at ASC ->
// entry_id ASC (terminal tiebreak). The entry id column is
// aliased `entry_id` (not the bare `id`) because the joined `meal_plans`/
// `recipes` tables also have an `id` column — SQLite's compound-SELECT
// ORDER BY resolution treats a bare `id` as ambiguous against every joined
// table's same-named column even though the SELECT list explicitly
// qualifies it (`me.id`), and fails with "does not match any column in the
// result set" rather than sorting correctly. Only entries of an ACTIVE plan
// matching the date's weekday contribute to the recurring branch
// (deactivation drops the contribution without deleting the row).
const MENU_UNION_SQL = `
  SELECT me.id AS entry_id, me.slot, me.recipe_id, me.note, r.name AS recipe_name,
         me.meal_plan_id AS meal_plan_id, mp.name AS plan_name, me.created_at AS created_at,
         0 AS kind_rank
  FROM meal_entries me
  JOIN meal_plans mp ON mp.id = me.meal_plan_id AND mp.active = 1
  LEFT JOIN recipes r ON r.id = me.recipe_id
  WHERE me.weekday = ?
  UNION ALL
  SELECT me.id AS entry_id, me.slot, me.recipe_id, me.note, r.name AS recipe_name,
         NULL AS meal_plan_id, NULL AS plan_name, me.created_at AS created_at,
         1 AS kind_rank
  FROM meal_entries me
  LEFT JOIN recipes r ON r.id = me.recipe_id
  WHERE me.entry_date = ?
  ORDER BY
    kind_rank,
    plan_name ASC,
    meal_plan_id ASC,
    created_at ASC,
    entry_id ASC
`;

const MENU_UNION_SLOT_SQL = `
  SELECT me.id AS entry_id, me.slot, me.recipe_id, me.note, r.name AS recipe_name,
         me.meal_plan_id AS meal_plan_id, mp.name AS plan_name, me.created_at AS created_at,
         0 AS kind_rank
  FROM meal_entries me
  JOIN meal_plans mp ON mp.id = me.meal_plan_id AND mp.active = 1
  LEFT JOIN recipes r ON r.id = me.recipe_id
  WHERE me.weekday = ? AND me.slot = ?
  UNION ALL
  SELECT me.id AS entry_id, me.slot, me.recipe_id, me.note, r.name AS recipe_name,
         NULL AS meal_plan_id, NULL AS plan_name, me.created_at AS created_at,
         1 AS kind_rank
  FROM meal_entries me
  LEFT JOIN recipes r ON r.id = me.recipe_id
  WHERE me.entry_date = ? AND me.slot = ?
  ORDER BY
    kind_rank,
    plan_name ASC,
    meal_plan_id ASC,
    created_at ASC,
    entry_id ASC
`;

function rowToMenuItem(row: MenuRow): MenuItem {
  const isTombstone = row.recipe_id !== null && row.recipe_name === null;
  const label =
    row.recipe_id !== null ? (row.recipe_name ?? "Deleted recipe") : (row.note as string);
  return {
    entryId: row.entry_id,
    slot: row.slot as Slot,
    label,
    isTombstone,
    source: row.meal_plan_id !== null ? "recurring" : "oneoff",
    recipeId: row.recipe_id,
    note: row.note,
  };
}

/** Derived day menu for `date` (+ optional `slot` filter): the union of (a)
 * recurring entries of every ACTIVE `meal_plan` whose `weekday` matches
 * `weekdayOf(date, householdTz)` and (b) one-off entries for that exact date
 * (`INV-03`: no materialized rows, computed fresh every call), in the full
 * D2 total order. A `recipe_id` whose recipe row is missing (the
 * write/delete TOCTOU, FR-028) renders as a tombstone item
 * (`isTombstone: true`, `INV-09`) rather than a read error or a silent drop.
 */
export function getMenu(date: unknown, slot: unknown): MenuItem[] {
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new MealValidationError(`Invalid date "${String(date)}"`);
  }
  if (slot !== undefined && (typeof slot !== "string" || !VALID_SLOTS.has(slot))) {
    throw new MealValidationError(`Invalid slot "${String(slot)}"`);
  }

  const tz = readHouseholdTimezone();
  const weekday = weekdayOf(date, tz);

  const db = getDb();
  const rows = (
    slot
      ? db.prepare(MENU_UNION_SLOT_SQL).all(weekday, slot, date, slot)
      : db.prepare(MENU_UNION_SQL).all(weekday, date)
  ) as MenuRow[];

  return rows.map(rowToMenuItem);
}

// ── Week view (FR-019 — a view over 7 local dates, no stored window) ────────

const WEEKDAY_NUMBER: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function menuBySlot(items: MenuItem[]): Record<Slot, MenuItem[]> {
  const bySlot: Record<Slot, MenuItem[]> = { breakfast: [], lunch: [], snack: [], dinner: [] };
  for (const item of items) {
    bySlot[item.slot].push(item);
  }
  return bySlot;
}

/** Derived week grid: the 7 local dates of the week containing `date`,
 * starting at the `weekStartDay` app-setting, each mapped to its derived day
 * menu grouped by slot (`date -> slot -> MenuItem[]`, an empty slot is `[]`
 * — matches `docs/api/meals/openapi.yaml` `WeekMenu`). A pure
 * view — no stored week window (FR-019).
 */
export function getWeekMenu(date: unknown): Record<string, Record<Slot, MenuItem[]>> {
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new MealValidationError(`Invalid date "${String(date)}"`);
  }

  const tz = readHouseholdTimezone();
  const weekStartDay = readWeekStartDay();
  const refWeekdayNumber = WEEKDAY_NUMBER[weekdayOf(date, tz)];
  const offset = (refWeekdayNumber - weekStartDay + 7) % 7;
  const weekStart = addDaysToDate(date, -offset);

  const week: Record<string, Record<Slot, MenuItem[]>> = {};
  for (let i = 0; i < 7; i++) {
    const d = addDaysToDate(weekStart, i);
    week[d] = menuBySlot(getMenu(d, undefined));
  }
  return week;
}
