import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect, useRef } from "react";
import { authFetch } from "@/lib/credential";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import {
  Recipe,
  RecipeInput,
  RecipeEditInput,
  RecipeDependentCounts,
  MealPlan,
  MealPlanInput,
  MealPlanEditInput,
  MealEntry,
  MealEntryInput,
  MealEntryEditInput,
  MenuItem,
  Slot,
  Weekday,
} from "../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CheckboxField } from "@/components/CheckboxField";
import { RadioField } from "@/components/RadioField";
import { StatusToggle } from "@/components/StatusToggle";
import { Field } from "@/components/Field";
import { WeekdayPicker, weekdayDisplayOrder, type WeekdayLabels } from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_INLINE_CLASSES, NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { addCalendarDays, buildWeekDays } from "@/calendar/calendar-presentation";
import { MealEntryDialog, type MealEntryTarget } from "@/meals/MealEntryDialog";
import { MealPlanGrid } from "@/meals/MealPlanGrid";
import { MEALS_CHANGED_EVENT } from "@/meals/useMealsWorkspace";
import { useMealOrigins } from "@/meals/meal-origins";

/** Manage the week menu (the family meal grid, editable here), meal plans with their recurring
 * entries, and recipes, as three local-state tabs: Preview (default), Meal plans and Recipes.
 * All three panels stay mounted and the inactive ones are `hidden`, so an open edit survives a
 * tab switch (spec D8); the tabs are never URL sub-routes (admin sub-paths relock the admin).
 * Recipe deletion confirms dependent counts; inactive plans remain editable but leave the derived
 * menu. */

type MealsTab = "preview" | "plans" | "recipes";
const MEALS_TABS: readonly MealsTab[] = ["preview", "plans", "recipes"];
const TAB_LABEL_KEYS: Record<MealsTab, MessageKey> = {
  preview: "meals.tabs.preview",
  plans: "meals.tabs.plans",
  recipes: "meals.tabs.recipes",
};

const SLOTS: Slot[] = ["breakfast", "lunch", "snack", "dinner"];

/** SC-009: this file used to declare its own seven-day `WEEKDAYS` literal — the fifth of the five
 * call sites names. Replaced below by `WeekdayPicker`'s single canonical order,
 * consumed through the shared component rather than re-declared here. */

const SLOT_LABEL_KEYS: Record<Slot, MessageKey> = {
  breakfast: "meals.slot.breakfast",
  lunch: "meals.slot.lunch",
  snack: "meals.slot.snack",
  dinner: "meals.slot.dinner",
};

const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "meals.plan.weekday.mon",
  tue: "meals.plan.weekday.tue",
  wed: "meals.plan.weekday.wed",
  thu: "meals.plan.weekday.thu",
  fri: "meals.plan.weekday.fri",
  sat: "meals.plan.weekday.sat",
  sun: "meals.plan.weekday.sun",
};

/** A `MealEntry.weekday` is `Weekday | null` at the type level (an `oneoff` entry has none), but
 * every entry `PlanEntryRow` renders is `kind: "recurring"` (fetched from
 * `/api/meal-plans/:id/entries`) and therefore always carries one — this narrows on the null
 * check rather than indexing `WEEKDAY_LABEL_KEYS` directly, which TypeScript correctly rejects
 * (`entry.weekday` typed as nullable) without a `MessageKey` cast. */
function weekdayLabel(t: (key: MessageKey) => string, weekday: Weekday | null): string {
  return weekday ? t(WEEKDAY_LABEL_KEYS[weekday]) : "";
}

/** Builds `WeekdayPicker`'s localized label map from this surface's own translation namespace
 * (`meals.plan.weekday.*`) — call-site-owned, per the component's own doc comment. */
function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
  return {
    mon: t(WEEKDAY_LABEL_KEYS.mon),
    tue: t(WEEKDAY_LABEL_KEYS.tue),
    wed: t(WEEKDAY_LABEL_KEYS.wed),
    thu: t(WEEKDAY_LABEL_KEYS.thu),
    fri: t(WEEKDAY_LABEL_KEYS.fri),
    sat: t(WEEKDAY_LABEL_KEYS.sat),
    sun: t(WEEKDAY_LABEL_KEYS.sun),
  };
}

/** Native selects retain their native interaction model. Caption/control pairs use shared
 * recipes; sibling textarea labels use explicit htmlFor/id associations. RecipeCard edits
 * use Field. Inline captions remain text-xs in both densities and may wrap in kiosk mode.
 */

/** FR-002: a recipe with absent/empty `slots` is offered in every slot picker. */
function isRecipeAvailableForSlot(recipe: Recipe, slot: Slot): boolean {
  return !recipe.slots || recipe.slots.length === 0 || recipe.slots.includes(slot);
}

interface SettingsResponse {
  locale: { timezone: string };
}

export function MealsManagement() {
  const { t } = useTranslation();
  const { weekStartDay } = useHouseholdSettings();

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [recipesLoadFailed, setRecipesLoadFailed] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRetryToken, setSettingsRetryToken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [plans, setPlans] = useState<MealPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [plansLoadFailed, setPlansLoadFailed] = useState(false);
  // Bumped after any entry write so every plan card refetches its recurring entries instead of
  // showing a list that predates the write (a recurring meal added from the week grid included).
  const [planEntriesRefreshToken, setPlanEntriesRefreshToken] = useState(0);

  const [todayDate, setTodayDate] = useState("");
  const [weekAnchorDate, setWeekAnchorDate] = useState("");
  const [weekMenu, setWeekMenu] = useState<Record<string, Record<Slot, MenuItem[]>>>({});
  const [weekLoading, setWeekLoading] = useState(true);
  const [weekError, setWeekError] = useState<string | null>(null);
  // Only the newest week request may write the grid: a slow earlier week must not overwrite it.
  const weekGeneration = useRef(0);
  // The week on screen, for refreshes started by a write that finishes after the user has
  // navigated: they must re-read the current week, not the one their render closed over.
  const weekAnchorRef = useRef("");
  const [entryTarget, setEntryTarget] = useState<MealEntryTarget | null>(null);
  const [tab, setTab] = useState<MealsTab>("preview");
  const origins = useMealOrigins(plans);
  // Captured when the add starts, so the dialog keeps its plan even if the pills change meanwhile.
  const [entryInitialPlanId, setEntryInitialPlanId] = useState<string | undefined>(undefined);

  useEffect(() => {
    void loadRecipes("");
  }, []);

  useEffect(() => {
    void loadHouseholdDate();
  }, [settingsRetryToken]);

  useEffect(() => {
    void loadPlans();
  }, []);

  useEffect(() => {
    weekAnchorRef.current = weekAnchorDate;
    void loadWeekMenu();
  }, [weekAnchorDate]);

  async function loadRecipes(search: string) {
    setLoading(true);
    setError(null);
    setRecipesLoadFailed(false);
    try {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      const res = await authFetch(`/api/recipes${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load recipes");
      setRecipes((await res.json()) as Recipe[]);
    } catch {
      setError(t("meals.management.error"));
      setRecipesLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadPlans() {
    setPlansLoading(true);
    setPlansError(null);
    setPlansLoadFailed(false);
    try {
      const res = await authFetch("/api/meal-plans", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load meal plans");
      setPlans((await res.json()) as MealPlan[]);
    } catch {
      setPlansError(t("meals.plan.error"));
      setPlansLoadFailed(true);
    } finally {
      setPlansLoading(false);
    }
  }

  async function loadWeekMenu(anchor = weekAnchorRef.current) {
    if (!anchor) return;
    const generation = ++weekGeneration.current;
    setWeekLoading(true);
    setWeekError(null);
    try {
      const res = await authFetch(`/api/menu/week?date=${encodeURIComponent(anchor)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load week menu");
      const next = (await res.json()) as Record<string, Record<Slot, MenuItem[]>>;
      if (generation === weekGeneration.current) setWeekMenu(next);
    } catch {
      if (generation === weekGeneration.current) setWeekError(t("meals.week.error"));
    } finally {
      if (generation === weekGeneration.current) setWeekLoading(false);
    }
  }

  async function loadHouseholdDate() {
    setSettingsError(null);
    try {
      const response = await authFetch("/api/settings", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load settings");
      const settings = (await response.json()) as SettingsResponse;
      const today = todayInHouseholdTimezone(settings.locale.timezone);
      setTodayDate(today);
      setWeekAnchorDate(today);
      setSettingsReady(true);
    } catch {
      setSettingsError(t("meals.management.error"));
    }
  }

  /** After any write that can change the derived menu: re-read the week and tell the family
   * widgets (today's meals) to refresh too. */
  async function refreshMenus() {
    await loadWeekMenu();
    window.dispatchEvent(new Event(MEALS_CHANGED_EVENT));
  }

  async function createRecipe(input: RecipeInput): Promise<boolean> {
    try {
      const res = await authFetch("/api/recipes", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to create recipe");
      await loadRecipes(searchInput);
      return true;
    } catch {
      setError(t("meals.management.error"));
      return false;
    }
  }

  async function editRecipe(id: string, updates: RecipeEditInput): Promise<boolean> {
    try {
      const res = await authFetch(`/api/recipes/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update recipe");
      await loadRecipes(searchInput);
      // A rename changes the label any entry referencing this recipe shows in the week grid.
      await refreshMenus();
      return true;
    } catch {
      setError(t("meals.management.error"));
      return false;
    }
  }

  /** Phase 1 of the delete flow — fetches dependent counts and composes the confirmation
   * message shown by the themed `ConfirmDialog` (replacing this surface's former
   * `window.confirm`, /FR-005 — a confirmation is one of the listed shared
   * components). Returns `null` (having already set the surface error) if the fetch fails. */
  async function prepareRecipeDeletion(recipe: Recipe): Promise<string | null> {
    try {
      const depRes = await authFetch(`/api/recipes/${recipe.id}/dependents`, {
        credentials: "include",
      });
      if (!depRes.ok) throw new Error("Failed to load dependents");
      const counts = (await depRes.json()) as RecipeDependentCounts;

      return counts.recurringCount === 0 && counts.oneOffCount === 0
        ? t("meals.recipes.deleteConfirmSimple")
        : `${t("meals.recipes.deleteConfirmPrefix")} ${counts.recurringCount} ${t(
            "meals.recipes.deleteConfirmRecurringLabel"
          )}, ${counts.oneOffCount} ${t("meals.recipes.deleteConfirmOneOffLabel")}. ${t(
            "meals.recipes.deleteConfirmSuffix"
          )}`;
    } catch {
      setError(t("meals.management.error"));
      return null;
    }
  }

  /** Phase 2 — the actual delete, run only once the `ConfirmDialog` opened by phase 1 is
   * confirmed. Same requests, same order, as the pre-migration single-function flow. */
  async function confirmRecipeDeletion(recipe: Recipe) {
    try {
      const res = await authFetch(`/api/recipes/${recipe.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete recipe");
      await loadRecipes(searchInput);
      // A cascade-deleted recipe also removes every entry referencing it — from the week grid
      // and from the plan cards, which would otherwise keep a phantom entry (edit/delete -> 404).
      await refreshMenus();
      setPlanEntriesRefreshToken((n) => n + 1);
    } catch {
      setError(t("meals.management.error"));
    }
  }

  /** Week-grid writes (the shared `MealEntryDialog`): the dialog shows its own error when this
   * returns false, so the page error stays untouched. */
  async function mutateEntry(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown
  ): Promise<boolean> {
    try {
      const res = await authFetch(url, {
        method,
        credentials: "include",
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`${method} ${url}: ${res.status}`);
      await refreshMenus();
      setPlanEntriesRefreshToken((n) => n + 1);
      return true;
    } catch {
      return false;
    }
  }

  async function createPlan(input: MealPlanInput): Promise<boolean> {
    try {
      const res = await authFetch("/api/meal-plans", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to create meal plan");
      await loadPlans();
      return true;
    } catch {
      setPlansError(t("meals.plan.error"));
      return false;
    }
  }

  async function updatePlan(id: string, updates: MealPlanEditInput): Promise<boolean> {
    try {
      const res = await authFetch(`/api/meal-plans/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update meal plan");
      await loadPlans();
      // Activating or deactivating a plan adds or removes its meals from the week grid.
      await refreshMenus();
      return true;
    } catch {
      setPlansError(t("meals.plan.error"));
      return false;
    }
  }

  async function renamePlan(id: string, name: string): Promise<boolean> {
    return updatePlan(id, { name });
  }

  async function togglePlanActive(id: string): Promise<boolean> {
    const plan = plans.find((p) => p.id === id);
    if (!plan) return false;
    return updatePlan(id, { active: !plan.active });
  }

  async function createRecurringEntry(input: MealEntryInput): Promise<boolean> {
    try {
      const res = await authFetch("/api/meal-entries", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to add recurring entry");
      await refreshMenus();
      setPlanEntriesRefreshToken((n) => n + 1);
      return true;
    } catch {
      // The in-card form shows the failure next to itself.
      return false;
    }
  }

  if (!settingsReady) {
    return (
      <div className="p-4">
        {settingsError ? (
          <>
            <ErrorNotice message={settingsError} />
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              onClick={() => setSettingsRetryToken((token) => token + 1)}
            >
              {t("meals.management.retry")}
            </Button>
          </>
        ) : (
          <h2>{t("meals.management.loading")}</h2>
        )}
      </div>
    );
  }

  const menuDates = Object.keys(weekMenu);
  const weekDates =
    menuDates.length > 0 || !weekAnchorDate
      ? menuDates
      : buildWeekDays(weekAnchorDate, weekStartDay === 0 ? 0 : 1);

  return (
    <AdminPanel title={t("admin.sidebar.meals")} description={t("meals.management.description")}>
      <ErrorNotice message={error} />
      {recipesLoadFailed && (
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          data-testid="meals-recipes-retry"
          onClick={() => void loadRecipes(searchInput)}
        >
          {t("meals.management.retry")}
        </Button>
      )}

      <div
        role="tablist"
        aria-label={t("meals.tabs.label")}
        className="bg-muted mt-4 flex w-fit max-w-full flex-wrap gap-1 rounded-lg border p-1"
      >
        {MEALS_TABS.map((id) => (
          <Button
            key={id}
            id={`meals-tab-${id}`}
            type="button"
            role="tab"
            variant={tab === id ? "default" : "ghost"}
            aria-selected={tab === id}
            aria-controls={`meals-tabpanel-${id}`}
            data-testid={`meals-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL_KEYS[id])}
          </Button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="meals-tabpanel-preview"
        aria-labelledby="meals-tab-preview"
        hidden={tab !== "preview"}
        className="mt-6"
      >
        <p className="text-muted-foreground text-sm mb-4">{t("meals.week.editHint")}</p>
        {weekError && (
          <div className="mb-4">
            <ErrorNotice message={weekError} />
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              data-testid="meals-week-retry"
              onClick={() => void loadWeekMenu()}
            >
              {t("meals.week.retry")}
            </Button>
          </div>
        )}
        <MealPlanGrid
          titleAs="h3"
          weekDates={weekDates}
          weekMenu={weekMenu}
          todayDate={todayDate || null}
          pending={weekLoading}
          onPrevious={() => setWeekAnchorDate((date) => addCalendarDays(date, -7))}
          onCurrent={() => setWeekAnchorDate(todayDate)}
          onNext={() => setWeekAnchorDate((date) => addCalendarDays(date, 7))}
          origin={{
            pills: origins.pills,
            tones: origins.tones,
            selected: origins.selected,
            onSelectedChange: origins.setSelected,
          }}
          onAdd={(date, slot) => {
            setEntryInitialPlanId(origins.preselectPlanId);
            setEntryTarget({ date, slot });
          }}
          onSelect={(date, item) => {
            setEntryInitialPlanId(undefined);
            setEntryTarget({ date, slot: item.slot, item });
          }}
        />
        {entryTarget && (
          <MealEntryDialog
            open
            target={entryTarget}
            recipes={recipes}
            plans={plans}
            initialPlanId={entryInitialPlanId}
            onClose={() => setEntryTarget(null)}
            onCreate={(input) => mutateEntry("/api/meal-entries", "POST", input)}
            onEdit={(id, input) =>
              mutateEntry(`/api/meal-entries/${encodeURIComponent(id)}`, "PATCH", input)
            }
            onDelete={(id) => mutateEntry(`/api/meal-entries/${encodeURIComponent(id)}`, "DELETE")}
          />
        )}
      </div>

      <div
        role="tabpanel"
        id="meals-tabpanel-plans"
        aria-labelledby="meals-tab-plans"
        hidden={tab !== "plans"}
        className="mt-6"
      >
        <MealPlanManagement
          t={t}
          plans={plans}
          loading={plansLoading}
          error={plansError}
          loadFailed={plansLoadFailed}
          onRetry={() => void loadPlans()}
          recipes={recipes}
          onCreate={createPlan}
          onRename={renamePlan}
          onToggleActive={togglePlanActive}
          onCreateRecurring={createRecurringEntry}
          onEntriesChanged={refreshMenus}
          entriesRefreshToken={planEntriesRefreshToken}
        />
      </div>

      <div
        role="tabpanel"
        id="meals-tabpanel-recipes"
        aria-labelledby="meals-tab-recipes"
        hidden={tab !== "recipes"}
        className="mt-6"
      >
        <form
          className="flex gap-2 items-center mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void loadRecipes(searchInput);
          }}
        >
          <Input
            type="text"
            aria-label={t("meals.recipes.searchPlaceholder")}
            placeholder={t("meals.recipes.searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            {t("meals.recipes.searchPlaceholder")}
          </Button>
        </form>

        <RecipeCreateForm t={t} onCreate={createRecipe} />

        {loading ? (
          <p>{t("meals.management.loading")}</p>
        ) : recipes.length === 0 ? (
          <p className="text-muted-foreground">{t("meals.recipes.noRecipes")}</p>
        ) : (
          <div className="space-y-4">
            {recipes.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                t={t}
                onSave={(updates) => editRecipe(recipe.id, updates)}
                onPrepareDelete={() => prepareRecipeDeletion(recipe)}
                onConfirmDelete={() => void confirmRecipeDeletion(recipe)}
              />
            ))}
          </div>
        )}
      </div>
    </AdminPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components */
/* ------------------------------------------------------------------ */

interface RecipeCreateFormProps {
  t: (key: MessageKey) => string;
  onCreate: (input: RecipeInput) => Promise<boolean>;
}

function RecipeCreateForm({ t, onCreate }: RecipeCreateFormProps) {
  const [name, setName] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [instructions, setInstructions] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);

  const toggleSlot = (slot: Slot) => {
    setSlots((prev) => (prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot]));
  };

  const reset = () => {
    setName("");
    setIngredients("");
    setInstructions("");
    setSlots([]);
  };

  const canSubmit = !!name.trim();

  return (
    <div className="bg-card p-4 rounded-lg shadow mb-6">
      <h4 className="text-md font-semibold mb-2">{t("meals.recipes.createTitle")}</h4>
      <div className="flex flex-col gap-2">
        <Input
          type="text"
          aria-label={t("meals.recipes.namePlaceholder")}
          placeholder={t("meals.recipes.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="meals-recipe-create-ingredients" className="text-muted-foreground text-xs">
          {t("meals.recipes.ingredientsLabel")}
        </label>
        <Textarea
          id="meals-recipe-create-ingredients"
          value={ingredients}
          onChange={(e) => setIngredients(e.target.value)}
          rows={3}
        />
        <label htmlFor="meals-recipe-create-instructions" className="text-muted-foreground text-xs">
          {t("meals.recipes.instructionsLabel")}
        </label>
        <Textarea
          id="meals-recipe-create-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={3}
        />
        <span className="text-muted-foreground text-xs">{t("meals.recipes.slotsLabel")}</span>
        <div
          role="group"
          aria-label={t("meals.recipes.slotsLabel")}
          className="flex gap-2 items-center flex-wrap"
        >
          {SLOTS.map((slot) => (
            <CheckboxField
              key={slot}
              checked={slots.includes(slot)}
              onChange={() => toggleSlot(slot)}
              label={t(SLOT_LABEL_KEYS[slot])}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-xs">{t("meals.recipes.slotsHint")}</p>

        <Button
          onClick={() => {
            if (!canSubmit) return;
            void (async () => {
              const succeeded = await onCreate({
                name: name.trim(),
                ingredients: ingredients
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
                instructions: instructions.trim() || undefined,
                slots: slots.length > 0 ? slots : undefined,
              });
              if (succeeded) reset();
            })();
          }}
          disabled={!canSubmit}
          className="self-start"
        >
          {t("meals.action.create")}
        </Button>
      </div>
    </div>
  );
}

interface RecipeCardProps {
  recipe: Recipe;
  t: (key: MessageKey) => string;
  onSave: (updates: RecipeEditInput) => Promise<boolean>;
  /** Fetches dependent counts and returns the confirmation message, or `null` on failure
   * (the surface error is already set by the caller). */
  onPrepareDelete: () => Promise<string | null>;
  /** Performs the actual delete — invoked by the `ConfirmDialog`'s confirm button. */
  onConfirmDelete: () => void;
}

function RecipeCard({ recipe, t, onSave, onPrepareDelete, onConfirmDelete }: RecipeCardProps) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(recipe.name);
  const [ingredientsDraft, setIngredientsDraft] = useState((recipe.ingredients ?? []).join("\n"));
  const [instructionsDraft, setInstructionsDraft] = useState(recipe.instructions ?? "");
  const [slotsDraft, setSlotsDraft] = useState<Slot[]>(recipe.slots ?? []);
  const [deleteConfirmMessage, setDeleteConfirmMessage] = useState<string | null>(null);

  const toggleSlot = (slot: Slot) => {
    setSlotsDraft((prev) =>
      prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot]
    );
  };

  const startEdit = () => {
    setNameDraft(recipe.name);
    setIngredientsDraft((recipe.ingredients ?? []).join("\n"));
    setInstructionsDraft(recipe.instructions ?? "");
    setSlotsDraft(recipe.slots ?? []);
    setEditing(true);
  };

  return (
    <div className="border rounded-lg p-4 mb-4">
      {editing ? (
        <div className="flex flex-col gap-2">
          {/*: RecipeCard's edit-mode trio had NO visible label at all (an absence, not a
           * mis-association) — worse than the read view's own captions, since a sighted user
           * editing a recipe could not tell the three boxes apart by size alone. `Field`
           * gives each one a real, programmatically-associated, VISIBLE label — this surface's
           * first adoption of it (see the D3 doc comment above). */}
          <Field label={t("meals.recipes.nameLabel")}>
            <Input
              type="text"
              data-testid="meals-recipe-edit-name"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
          </Field>
          <Field label={t("meals.recipes.ingredientsLabel")}>
            <Textarea
              data-testid="meals-recipe-edit-ingredients"
              value={ingredientsDraft}
              onChange={(e) => setIngredientsDraft(e.target.value)}
              rows={3}
            />
          </Field>
          <Field label={t("meals.recipes.instructionsLabel")}>
            <Textarea
              data-testid="meals-recipe-edit-instructions"
              value={instructionsDraft}
              onChange={(e) => setInstructionsDraft(e.target.value)}
              rows={3}
            />
          </Field>
          <div
            role="group"
            aria-label={t("meals.recipes.slotsLabel")}
            className="flex gap-2 flex-wrap"
          >
            {SLOTS.map((slot) => (
              <CheckboxField
                key={slot}
                checked={slotsDraft.includes(slot)}
                onChange={() => toggleSlot(slot)}
                label={t(SLOT_LABEL_KEYS[slot])}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="link"
              onClick={() => {
                if (!nameDraft.trim()) return;
                void (async () => {
                  const succeeded = await onSave({
                    name: nameDraft.trim(),
                    ingredients: ingredientsDraft
                      .split("\n")
                      .map((line) => line.trim())
                      .filter((line) => line.length > 0),
                    instructions: instructionsDraft.trim(),
                    slots: slotsDraft,
                  });
                  if (succeeded) setEditing(false);
                })();
              }}
              disabled={!nameDraft.trim()}
            >
              {t("meals.action.save")}
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(false)}
            >
              {t("meals.action.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between items-start">
          <div>
            <h4 className="text-md font-semibold">{recipe.name}</h4>
            {recipe.ingredients && recipe.ingredients.length > 0 && (
              <p className="text-muted-foreground text-sm">{recipe.ingredients.join(", ")}</p>
            )}
            {recipe.instructions && (
              <p className="text-muted-foreground text-sm">{recipe.instructions}</p>
            )}
            <p className="text-muted-foreground text-xs">
              {recipe.slots && recipe.slots.length > 0
                ? recipe.slots.map((slot) => t(SLOT_LABEL_KEYS[slot])).join(", ")
                : SLOTS.map((slot) => t(SLOT_LABEL_KEYS[slot])).join(", ")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="link" onClick={startEdit}>
              {t("meals.action.edit")}
            </Button>
            <Button
              variant="link"
              className="text-destructive hover:text-destructive/80"
              onClick={() => {
                void (async () => {
                  const message = await onPrepareDelete();
                  if (message) setDeleteConfirmMessage(message);
                })();
              }}
            >
              {t("meals.action.delete")}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={deleteConfirmMessage !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmMessage(null);
        }}
        title={t("meals.action.delete")}
        description={deleteConfirmMessage ?? undefined}
        confirmLabel={t("meals.action.delete")}
        cancelLabel={t("meals.action.cancel")}
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* meal_plan management — create/rename/activate/deactivate; */
/* no delete control (FR-017/FR-025). Each plan card always lists its */
/* recurring entries from GET /api/meal-plans/:id/entries — not the */
/* derived menu, which excludes inactive plans — so a deactivated */
/* plan's entries stay visible, editable and deletable. */
/* ------------------------------------------------------------------ */

interface MealPlanManagementProps {
  t: (key: MessageKey) => string;
  plans: MealPlan[];
  loading: boolean;
  error: string | null;
  /** The plan list itself failed to load (as opposed to a create/update failure). */
  loadFailed: boolean;
  onRetry: () => void;
  recipes: Recipe[];
  onCreate: (input: MealPlanInput) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onToggleActive: (id: string) => Promise<boolean>;
  onCreateRecurring: (input: MealEntryInput) => Promise<boolean>;
  onEntriesChanged: () => Promise<void>;
  entriesRefreshToken: number;
}

function MealPlanManagement({
  t,
  plans,
  loading,
  error,
  loadFailed,
  onRetry,
  recipes,
  onCreate,
  onRename,
  onToggleActive,
  onCreateRecurring,
  onEntriesChanged,
  entriesRefreshToken,
}: MealPlanManagementProps) {
  const [name, setName] = useState("");

  return (
    <div>
      <div className="bg-card p-4 rounded-lg shadow mb-6">
        <h4 className="text-md font-semibold mb-2">{t("meals.plan.createTitle")}</h4>
        <div className="flex gap-2 items-center">
          <Input
            type="text"
            data-testid="meals-plan-name-input"
            aria-label={t("meals.plan.namePlaceholder")}
            placeholder={t("meals.plan.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            onClick={() => {
              if (!name.trim()) return;
              void (async () => {
                const succeeded = await onCreate({ name: name.trim() });
                if (succeeded) setName("");
              })();
            }}
            disabled={!name.trim()}
          >
            {t("meals.action.create")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNotice message={error} />
          {loadFailed && (
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              data-testid="meals-plans-retry"
              onClick={onRetry}
            >
              {t("meals.management.retry")}
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <p>{t("meals.plan.loading")}</p>
      ) : plans.length === 0 ? (
        <p className="text-muted-foreground">{t("meals.plan.noPlans")}</p>
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => (
            <MealPlanCard
              key={plan.id}
              t={t}
              plan={plan}
              recipes={recipes}
              onRename={(newName) => onRename(plan.id, newName)}
              onToggleActive={() => onToggleActive(plan.id)}
              onCreateRecurring={onCreateRecurring}
              onEntriesChanged={onEntriesChanged}
              entriesRefreshToken={entriesRefreshToken}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface MealPlanCardProps {
  t: (key: MessageKey) => string;
  plan: MealPlan;
  recipes: Recipe[];
  onRename: (name: string) => Promise<boolean>;
  onToggleActive: () => Promise<boolean>;
  onCreateRecurring: (input: MealEntryInput) => Promise<boolean>;
  onEntriesChanged: () => Promise<void>;
  entriesRefreshToken: number;
}

function MealPlanCard({
  t,
  plan,
  recipes,
  onRename,
  onToggleActive,
  onCreateRecurring,
  onEntriesChanged,
  entriesRefreshToken,
}: MealPlanCardProps) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(plan.name);
  const [adding, setAdding] = useState(false);

  const startEdit = () => {
    setNameDraft(plan.name);
    setEditing(true);
  };

  return (
    <div className="border rounded-lg p-4" data-testid="meals-plan-card">
      <div className="flex justify-between items-start gap-2">
        <div className="flex-1">
          {editing ? (
            <div className="flex gap-2 items-center flex-wrap">
              <Input
                type="text"
                data-testid="meals-plan-rename-input"
                aria-label={t("meals.plan.namePlaceholder")}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
              />
              <Button
                variant="link"
                onClick={() => {
                  if (!nameDraft.trim()) return;
                  void (async () => {
                    const succeeded = await onRename(nameDraft.trim());
                    if (succeeded) setEditing(false);
                  })();
                }}
                disabled={!nameDraft.trim()}
              >
                {t("meals.action.save")}
              </Button>
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(false)}
              >
                {t("meals.action.cancel")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-md font-semibold">{plan.name}</h4>
              <span
                className={cn(
                  "text-xs px-2 py-0.5 rounded",
                  plan.active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}
              >
                {plan.active ? t("meals.plan.statusActive") : t("meals.plan.statusInactive")}
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {!editing && (
            <Button variant="link" onClick={startEdit}>
              {t("meals.action.edit")}
            </Button>
          )}
          <StatusToggle
            pressed={plan.active}
            label={
              plan.active ? t("meals.plan.action.deactivate") : t("meals.plan.action.activate")
            }
            // (doctrine settled by the): `aria-pressed` already carries
            // the state, so appending it to the name (the MEDIUM-b shape this replaces)
            // announces it twice and re-announces the whole name on every toggle. `plan.name`
            // alone is ALREADY state-invariant — mirrors ChoresBoard's own `chore.name` call site
            // (StatusToggle.tsx's doc comment names both as the same pattern) — while the visible
            // `label` above stays action-shaped for sighted users; that combination is what
            // satisfies both the ARIA toggle-button pattern and WCAG 2.5.3 Label-in-Name.
            accessibleName={plan.name}
            onPress={() => void onToggleActive()}
          />
        </div>
      </div>
      {!plan.active && (
        <p className="text-muted-foreground text-sm mt-2">{t("meals.plan.inactiveHint")}</p>
      )}
      <div className="mt-3">
        <PlanEntriesPanel
          t={t}
          planId={plan.id}
          recipes={recipes}
          onChanged={onEntriesChanged}
          refreshToken={entriesRefreshToken}
        />
      </div>
      <div className="mt-3">
        <Button
          type="button"
          variant="outline"
          aria-expanded={adding}
          data-testid="meals-plan-add-recurring"
          onClick={() => setAdding((open) => !open)}
        >
          {t("meals.plan.addRecurring")}
        </Button>
        {adding && (
          <RecurringEntryAuthoringForm
            t={t}
            recipes={recipes}
            mealPlanId={plan.id}
            onCreate={onCreateRecurring}
            onDone={() => setAdding(false)}
          />
        )}
      </div>
    </div>
  );
}

interface PlanEntriesPanelProps {
  t: (key: MessageKey) => string;
  planId: string;
  recipes: Recipe[];
  onChanged: () => Promise<void>;
  /** Bumped after any entry write elsewhere on the page (the week grid, another card's form)
   * so this card refetches. */
  refreshToken: number;
}

/** A plan's retained entries, fetched from GET /api/meal-plans/:id/entries —
 * NOT the derived menu, which excludes inactive plans (this is the key UX
 * requirement: a deactivated plan's entries stay editable/deletable here
 * without reactivating the plan). Grouped by weekday in the household week-start
 * order, then by slot, then by creation time.
 */
function PlanEntriesPanel({ t, planId, recipes, onChanged, refreshToken }: PlanEntriesPanelProps) {
  const { weekStartDay } = useHouseholdSettings();
  const [entries, setEntries] = useState<MealEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // After the first successful load, refetches keep the rows mounted so an open row edit (in
  // this card, while another card or the week grid writes) keeps its draft.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [planId, refreshToken]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await authFetch(`/api/meal-plans/${planId}/entries`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load plan entries");
      setEntries((await res.json()) as MealEntry[]);
      setLoaded(true);
    } catch {
      setLoadError(t("meals.plan.entriesError"));
    } finally {
      setLoading(false);
    }
  }

  async function saveEntry(id: string, updates: MealEntryEditInput): Promise<boolean> {
    setWriteError(null);
    try {
      const res = await authFetch(`/api/meal-entries/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update entry");
      await load();
      await onChanged();
      return true;
    } catch {
      setWriteError(t("meals.plan.entriesError"));
      return false;
    }
  }

  async function removeEntry(id: string) {
    setWriteError(null);
    try {
      const res = await authFetch(`/api/meal-entries/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete entry");
      await load();
      await onChanged();
    } catch {
      setWriteError(t("meals.plan.entriesError"));
    }
  }

  if (loading && !loaded) return <p>{t("meals.plan.loading")}</p>;

  if (loadError) {
    return (
      <div>
        <ErrorNotice message={loadError} />
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          data-testid="meals-plan-entries-retry"
          onClick={() => void load()}
        >
          {t("meals.management.retry")}
        </Button>
      </div>
    );
  }

  const order = weekdayDisplayOrder(weekStartDay);
  const sorted = [...entries].sort(
    (a, b) =>
      order.indexOf(a.weekday!) - order.indexOf(b.weekday!) ||
      SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) ||
      a.createdAt - b.createdAt
  );
  const groups = order
    .map((day) => ({ day, items: sorted.filter((entry) => entry.weekday === day) }))
    .filter((group) => group.items.length > 0);

  return (
    <div data-testid={`meals-plan-entries-${planId}`}>
      <h5 className="text-sm font-semibold mb-2">{t("meals.plan.entriesTitle")}</h5>
      <ErrorNotice message={writeError} className="mb-2" />
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("meals.plan.entriesEmpty")}</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.day}>
              <h6 className="text-muted-foreground text-xs font-semibold uppercase mb-1">
                {weekdayLabel(t, group.day)}
              </h6>
              <ul className="space-y-2">
                {group.items.map((entry) => (
                  <PlanEntryRow
                    key={entry.id}
                    t={t}
                    entry={entry}
                    recipes={recipes}
                    onSave={(updates) => saveEntry(entry.id, updates)}
                    onDelete={() => void removeEntry(entry.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PlanEntryRowProps {
  t: (key: MessageKey) => string;
  entry: MealEntry;
  recipes: Recipe[];
  onSave: (updates: MealEntryEditInput) => Promise<boolean>;
  onDelete: () => void;
}

/** A single recurring entry — content-only edit (recipeId xor note); slot/weekday are fixed. */
function PlanEntryRow({ t, entry, recipes, onSave, onDelete }: PlanEntryRowProps) {
  const [editing, setEditing] = useState(false);
  const [contentMode, setContentMode] = useState<"recipe" | "note">(
    entry.recipeId ? "recipe" : "note"
  );
  const [recipeId, setRecipeId] = useState(entry.recipeId ?? "");
  const [note, setNote] = useState(entry.note ?? "");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const availableRecipes = recipes.filter((recipe) => isRecipeAvailableForSlot(recipe, entry.slot));
  const recipeName = entry.recipeId
    ? (recipes.find((recipe) => recipe.id === entry.recipeId)?.name ?? entry.recipeId)
    : null;

  const startEdit = () => {
    setContentMode(entry.recipeId ? "recipe" : "note");
    setRecipeId(entry.recipeId ?? "");
    setNote(entry.note ?? "");
    setEditing(true);
  };

  const canSave = contentMode === "recipe" ? !!recipeId : !!note.trim();
  const contentModeName = `meals-plan-entry-content-mode-${entry.id}`;

  return (
    <li className="border rounded p-2" data-testid="meals-plan-entry-row">
      {editing ? (
        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground flex gap-2 items-center flex-wrap text-xs">
            <span>{weekdayLabel(t, entry.weekday)}</span>
            <span>{t(SLOT_LABEL_KEYS[entry.slot])}</span>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <RadioField
              name={contentModeName}
              value="recipe"
              checked={contentMode === "recipe"}
              onChange={() => setContentMode("recipe")}
              label={t("meals.entries.contentModeRecipe")}
            />
            <RadioField
              name={contentModeName}
              value="note"
              checked={contentMode === "note"}
              onChange={() => setContentMode("note")}
              label={t("meals.entries.contentModeNote")}
            />
          </div>
          {contentMode === "recipe" ? (
            <select
              data-testid="meals-plan-entry-recipe-select"
              aria-label={t("meals.entries.recipeSelectLabel")}
              value={recipeId}
              onChange={(e) => setRecipeId(e.target.value)}
              className={NATIVE_SELECT_CLASSES}
            >
              <option value="">{t("meals.entries.recipeSelectPlaceholder")}</option>
              {availableRecipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type="text"
              data-testid="meals-plan-entry-note-input"
              aria-label={t("meals.entries.notePlaceholder")}
              placeholder={t("meals.entries.notePlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <div className="flex gap-2">
            <Button
              variant="link"
              onClick={() => {
                if (!canSave) return;
                void (async () => {
                  const updates: MealEntryEditInput =
                    contentMode === "recipe" ? { recipeId } : { note: note.trim() };
                  const succeeded = await onSave(updates);
                  if (succeeded) setEditing(false);
                })();
              }}
              disabled={!canSave}
            >
              {t("meals.action.save")}
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(false)}
            >
              {t("meals.action.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between items-center gap-2">
          <div className="text-sm">
            {/* The weekday is the group heading above the row. */}
            <span className="font-semibold">{t(SLOT_LABEL_KEYS[entry.slot])}:</span>{" "}
            <span>{recipeName ?? entry.note}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="link" onClick={startEdit}>
              {t("meals.action.edit")}
            </Button>
            <Button
              variant="link"
              className="text-destructive hover:text-destructive/80"
              onClick={() => setConfirmDeleteOpen(true)}
            >
              {t("meals.action.delete")}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t("meals.action.delete")}
        description={t("meals.plan.entryDeleteConfirm")}
        confirmLabel={t("meals.action.delete")}
        cancelLabel={t("meals.action.cancel")}
        onConfirm={onDelete}
      />
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Recurring-entry authoring inside a plan card — kind:"recurring" in */
/* that plan, one weekday; content recipeId xor note (FR-025). */
/* ------------------------------------------------------------------ */

interface RecurringEntryAuthoringFormProps {
  t: (key: MessageKey) => string;
  recipes: Recipe[];
  mealPlanId: string;
  onCreate: (input: MealEntryInput) => Promise<boolean>;
  /** Called after a successful add (the card collapses the form). */
  onDone: () => void;
}

function RecurringEntryAuthoringForm({
  t,
  recipes,
  mealPlanId,
  onCreate,
  onDone,
}: RecurringEntryAuthoringFormProps) {
  const [weekday, setWeekday] = useState<Weekday>("mon");
  const [slot, setSlot] = useState<Slot>("breakfast");
  const [contentMode, setContentMode] = useState<"recipe" | "note">("recipe");
  const [recipeId, setRecipeId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const availableRecipes = recipes.filter((recipe) => isRecipeAvailableForSlot(recipe, slot));
  const canSubmit = contentMode === "recipe" ? !!recipeId : !!note.trim();
  // Unique per card: several plan cards can have their form open at once.
  const contentModeName = `meals-recurring-content-mode-${mealPlanId}`;

  return (
    <div className="mt-3 rounded-md border p-3">
      <div className="flex flex-col gap-2">
        <div className="flex gap-2 items-center flex-wrap">
          <span className="text-muted-foreground text-xs">{t("meals.plan.weekdayLabel")}</span>
          <WeekdayPicker
            mode="single"
            renderAs="radio"
            value={weekday}
            onChange={setWeekday}
            labels={weekdayLabels(t)}
            groupLabel={t("meals.plan.weekdayLabel")}
            testIdPrefix="meals-recurring-weekday"
          />
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <label className={LABEL_INLINE_CLASSES}>
            {t("meals.entries.slotLabel")}
            <select
              data-testid="meals-recurring-slot-select"
              value={slot}
              onChange={(e) => {
                setSlot(e.target.value as Slot);
                setRecipeId("");
              }}
              className={NATIVE_SELECT_CLASSES}
            >
              {SLOTS.map((s) => (
                <option key={s} value={s}>
                  {t(SLOT_LABEL_KEYS[s])}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <RadioField
            name={contentModeName}
            value="recipe"
            checked={contentMode === "recipe"}
            onChange={() => setContentMode("recipe")}
            label={t("meals.entries.contentModeRecipe")}
          />
          <RadioField
            name={contentModeName}
            value="note"
            checked={contentMode === "note"}
            onChange={() => setContentMode("note")}
            label={t("meals.entries.contentModeNote")}
          />
        </div>

        {contentMode === "recipe" ? (
          availableRecipes.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("meals.entries.noRecipesForSlot")}</p>
          ) : (
            <select
              data-testid="meals-recurring-recipe-select"
              aria-label={t("meals.entries.recipeSelectLabel")}
              value={recipeId}
              onChange={(e) => setRecipeId(e.target.value)}
              className={NATIVE_SELECT_CLASSES}
            >
              <option value="">{t("meals.entries.recipeSelectPlaceholder")}</option>
              {availableRecipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.name}
                </option>
              ))}
            </select>
          )
        ) : (
          <Input
            type="text"
            data-testid="meals-recurring-note-input"
            aria-label={t("meals.entries.notePlaceholder")}
            placeholder={t("meals.entries.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}

        <ErrorNotice message={error} />
        <Button
          onClick={() => {
            if (!canSubmit) return;
            void (async () => {
              const input: MealEntryInput =
                contentMode === "recipe"
                  ? { kind: "recurring", mealPlanId, weekday, slot, recipeId }
                  : { kind: "recurring", mealPlanId, weekday, slot, note: note.trim() };
              setError(null);
              const succeeded = await onCreate(input);
              if (succeeded) onDone();
              else setError(t("meals.entries.error"));
            })();
          }}
          disabled={!canSubmit}
          className="self-start"
        >
          {t("meals.plan.recurringEntryAction")}
        </Button>
      </div>
    </div>
  );
}
