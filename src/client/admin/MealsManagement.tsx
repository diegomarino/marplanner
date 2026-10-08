import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect } from "react";
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
import { WeekdayPicker, type WeekdayLabels } from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_INLINE_CLASSES, NATIVE_SELECT_CLASSES } from "@/lib/recipes";

/** Manage recipes, one-off meals, recurring entries and retained meal plans.
 * Recipe deletion confirms dependent counts; inactive plans remain editable but leave the derived menu. */

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

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRetryToken, setSettingsRetryToken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [viewDate, setViewDate] = useState("");
  const [slotFilter, setSlotFilter] = useState<Slot | "">("");
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState<string | null>(null);

  const [plans, setPlans] = useState<MealPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  // Bumped after any recurring-entry write so an already-expanded PlanEntriesPanel
  // refetches instead of showing a cached list that predates the write.
  const [planEntriesRefreshToken, setPlanEntriesRefreshToken] = useState(0);

  const [weekAnchorDate, setWeekAnchorDate] = useState("");
  const [weekMenu, setWeekMenu] = useState<Record<string, Record<Slot, MenuItem[]>>>({});
  const [weekLoading, setWeekLoading] = useState(true);
  const [weekError, setWeekError] = useState<string | null>(null);

  useEffect(() => {
    void loadRecipes("");
  }, []);

  useEffect(() => {
    void loadHouseholdDate();
  }, [settingsRetryToken]);

  useEffect(() => {
    void loadMenu();
  }, [viewDate, slotFilter]);

  useEffect(() => {
    void loadPlans();
  }, []);

  useEffect(() => {
    void loadWeekMenu();
  }, [weekAnchorDate]);

  async function loadRecipes(search: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      const res = await authFetch(`/api/recipes${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load recipes");
      setRecipes((await res.json()) as Recipe[]);
    } catch {
      setError(t("meals.management.error"));
    } finally {
      setLoading(false);
    }
  }

  async function loadMenu() {
    if (!viewDate) return;
    setMenuLoading(true);
    setMenuError(null);
    try {
      const qs = slotFilter ? `?date=${viewDate}&slot=${slotFilter}` : `?date=${viewDate}`;
      const res = await authFetch(`/api/menu${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load menu");
      setMenuItems((await res.json()) as MenuItem[]);
    } catch {
      setMenuError(t("meals.menu.error"));
    } finally {
      setMenuLoading(false);
    }
  }

  async function loadPlans() {
    setPlansLoading(true);
    setPlansError(null);
    try {
      const res = await authFetch("/api/meal-plans", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load meal plans");
      setPlans((await res.json()) as MealPlan[]);
    } catch {
      setPlansError(t("meals.plan.error"));
    } finally {
      setPlansLoading(false);
    }
  }

  async function loadWeekMenu() {
    if (!weekAnchorDate) return;
    setWeekLoading(true);
    setWeekError(null);
    try {
      const res = await authFetch(`/api/menu/week?date=${weekAnchorDate}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load week menu");
      setWeekMenu((await res.json()) as Record<string, Record<Slot, MenuItem[]>>);
    } catch {
      setWeekError(t("meals.week.error"));
    } finally {
      setWeekLoading(false);
    }
  }

  async function loadHouseholdDate() {
    setSettingsError(null);
    try {
      const response = await authFetch("/api/settings", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load settings");
      const settings = (await response.json()) as SettingsResponse;
      const today = todayInHouseholdTimezone(settings.locale.timezone);
      setViewDate(today);
      setWeekAnchorDate(today);
      setSettingsReady(true);
    } catch {
      setSettingsError(t("meals.management.error"));
    }
  }

  /** Refresh both derived-menu views after any write that can change what they show. */
  async function refreshMenus() {
    await Promise.all([loadMenu(), loadWeekMenu()]);
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
      await refreshMenus();
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
      // A rename changes the label any entry referencing this recipe shows in
      // the day/week menus — both must be re-read, not just the recipe list.
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
      // A cascade-deleted recipe also removes every entry referencing it —
      // both the day AND week menus can change, not just the day.
      await refreshMenus();
      // The cascade also deletes any recurring entry referencing this recipe
      // server-side — an already-expanded plan panel must refetch or it keeps
      // showing the now-deleted entry as a phantom (edit/delete -> 404).
      setPlanEntriesRefreshToken((n) => n + 1);
    } catch {
      setError(t("meals.management.error"));
    }
  }

  async function createEntry(input: MealEntryInput): Promise<boolean> {
    try {
      const res = await authFetch("/api/meal-entries", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to add entry");
      // The new entry's date may fall inside the displayed week regardless of
      // whether it matches the day view's `viewDate` — refresh both.
      await refreshMenus();
      return true;
    } catch {
      setError(t("meals.entries.error"));
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
      setError(t("meals.entries.error"));
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

  return (
    <AdminPanel title={t("meals.management.title")} description={t("meals.management.description")}>
      <ErrorNotice message={error} />

      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-2">{t("meals.recipes.title")}</h3>
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

      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-2">{t("meals.entries.title")}</h3>
        <EntryAuthoringForm t={t} recipes={recipes} defaultDate={viewDate} onCreate={createEntry} />
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-2">{t("meals.menu.title")}</h3>
        <DayMenuView
          t={t}
          viewDate={viewDate}
          onViewDateChange={setViewDate}
          slotFilter={slotFilter}
          onSlotFilterChange={setSlotFilter}
          items={menuItems}
          loading={menuLoading}
          error={menuError}
        />
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-2">{t("meals.plan.title")}</h3>
        <MealPlanManagement
          t={t}
          plans={plans}
          loading={plansLoading}
          error={plansError}
          recipes={recipes}
          expandedPlanId={expandedPlanId}
          onToggleExpanded={(id) => setExpandedPlanId((prev) => (prev === id ? null : id))}
          onCreate={createPlan}
          onRename={renamePlan}
          onToggleActive={togglePlanActive}
          onEntriesChanged={refreshMenus}
          entriesRefreshToken={planEntriesRefreshToken}
        />
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-2">{t("meals.plan.recurringEntryTitle")}</h3>
        <RecurringEntryAuthoringForm
          t={t}
          recipes={recipes}
          plans={plans}
          onCreate={createRecurringEntry}
        />
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-2">{t("meals.week.title")}</h3>
        <WeekMenuView
          t={t}
          anchorDate={weekAnchorDate}
          onAnchorDateChange={setWeekAnchorDate}
          week={weekMenu}
          loading={weekLoading}
          error={weekError}
        />
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

interface EntryAuthoringFormProps {
  t: (key: MessageKey) => string;
  recipes: Recipe[];
  defaultDate: string;
  onCreate: (input: MealEntryInput) => Promise<boolean>;
}

function EntryAuthoringForm({ t, recipes, defaultDate, onCreate }: EntryAuthoringFormProps) {
  const [date, setDate] = useState(defaultDate);
  const [slot, setSlot] = useState<Slot>("breakfast");
  const [contentMode, setContentMode] = useState<"recipe" | "note">("recipe");
  const [recipeId, setRecipeId] = useState("");
  const [note, setNote] = useState("");

  const availableRecipes = recipes.filter((recipe) => isRecipeAvailableForSlot(recipe, slot));

  const canSubmit = !!date.trim() && (contentMode === "recipe" ? !!recipeId : !!note.trim());

  const reset = () => {
    setRecipeId("");
    setNote("");
  };

  return (
    <div className="bg-card p-4 rounded-lg shadow mb-6">
      <div className="flex flex-col gap-2">
        <div className="flex gap-2 items-center flex-wrap">
          <label className={LABEL_INLINE_CLASSES}>
            {t("meals.entries.dateLabel")}
            <Input
              type="date"
              data-testid="meals-entry-date-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className={LABEL_INLINE_CLASSES}>
            {t("meals.entries.slotLabel")}
            <select
              data-testid="meals-entry-slot-select"
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
            name="meals-entry-content-mode"
            value="recipe"
            checked={contentMode === "recipe"}
            onChange={() => setContentMode("recipe")}
            label={t("meals.entries.contentModeRecipe")}
          />
          <RadioField
            name="meals-entry-content-mode"
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
              data-testid="meals-entry-recipe-select"
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
            aria-label={t("meals.entries.notePlaceholder")}
            placeholder={t("meals.entries.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}

        <Button
          onClick={() => {
            if (!canSubmit) return;
            void (async () => {
              const input: MealEntryInput =
                contentMode === "recipe"
                  ? { kind: "oneoff", date, slot, recipeId }
                  : { kind: "oneoff", date, slot, note: note.trim() };
              const succeeded = await onCreate(input);
              if (succeeded) reset();
            })();
          }}
          disabled={!canSubmit}
          className="self-start"
        >
          {t("meals.entries.action.add")}
        </Button>
      </div>
    </div>
  );
}

interface DayMenuViewProps {
  t: (key: MessageKey) => string;
  viewDate: string;
  onViewDateChange: (date: string) => void;
  slotFilter: Slot | "";
  onSlotFilterChange: (slot: Slot | "") => void;
  items: MenuItem[];
  loading: boolean;
  error: string | null;
}

function DayMenuView({
  t,
  viewDate,
  onViewDateChange,
  slotFilter,
  onSlotFilterChange,
  items,
  loading,
  error,
}: DayMenuViewProps) {
  return (
    <div className="bg-card p-4 rounded-lg shadow">
      <div className="flex gap-2 items-center flex-wrap mb-4">
        <label className={LABEL_INLINE_CLASSES}>
          {t("meals.menu.dateLabel")}
          <Input
            type="date"
            data-testid="meals-menu-date-input"
            value={viewDate}
            onChange={(e) => onViewDateChange(e.target.value)}
          />
        </label>
        <label className={LABEL_INLINE_CLASSES}>
          {t("meals.menu.slotFilterLabel")}
          <select
            data-testid="meals-menu-slot-filter-select"
            value={slotFilter}
            onChange={(e) => onSlotFilterChange(e.target.value as Slot | "")}
            className={NATIVE_SELECT_CLASSES}
          >
            <option value="">{t("meals.menu.slotFilterAll")}</option>
            {SLOTS.map((s) => (
              <option key={s} value={s}>
                {t(SLOT_LABEL_KEYS[s])}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorNotice message={error} className="mb-2" />

      {loading ? (
        <p>{t("meals.menu.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">{t("meals.menu.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.entryId} className="text-sm flex gap-2">
              <span className="font-semibold">{t(SLOT_LABEL_KEYS[item.slot])}:</span>
              <span>{item.isTombstone ? t("meals.menu.tombstoneLabel") : item.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* meal_plan management — create/rename/activate/deactivate; */
/* no delete control (FR-017/FR-025). A deactivated plan's entries */
/* stay reachable (and editable/deletable) via its expandable panel, */
/* which reads GET /api/meal-plans/:id/entries — not the derived menu, */
/* which excludes inactive plans. */
/* ------------------------------------------------------------------ */

interface MealPlanManagementProps {
  t: (key: MessageKey) => string;
  plans: MealPlan[];
  loading: boolean;
  error: string | null;
  recipes: Recipe[];
  expandedPlanId: string | null;
  onToggleExpanded: (id: string) => void;
  onCreate: (input: MealPlanInput) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onToggleActive: (id: string) => Promise<boolean>;
  onEntriesChanged: () => Promise<void>;
  entriesRefreshToken: number;
}

function MealPlanManagement({
  t,
  plans,
  loading,
  error,
  recipes,
  expandedPlanId,
  onToggleExpanded,
  onCreate,
  onRename,
  onToggleActive,
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

      <ErrorNotice message={error} className="mb-4" />

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
              expanded={expandedPlanId === plan.id}
              onToggleExpanded={() => onToggleExpanded(plan.id)}
              onRename={(newName) => onRename(plan.id, newName)}
              onToggleActive={() => onToggleActive(plan.id)}
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
  expanded: boolean;
  onToggleExpanded: () => void;
  onRename: (name: string) => Promise<boolean>;
  onToggleActive: () => Promise<boolean>;
  onEntriesChanged: () => Promise<void>;
  entriesRefreshToken: number;
}

function MealPlanCard({
  t,
  plan,
  recipes,
  expanded,
  onToggleExpanded,
  onRename,
  onToggleActive,
  onEntriesChanged,
  entriesRefreshToken,
}: MealPlanCardProps) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(plan.name);

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
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            data-testid="meals-plan-toggle-entries"
            onClick={onToggleExpanded}
          >
            {expanded ? t("meals.plan.hideEntries") : t("meals.plan.showEntries")}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 pl-2 border-l-2">
          <PlanEntriesPanel
            t={t}
            planId={plan.id}
            recipes={recipes}
            onChanged={onEntriesChanged}
            refreshToken={entriesRefreshToken}
          />
        </div>
      )}
    </div>
  );
}

interface PlanEntriesPanelProps {
  t: (key: MessageKey) => string;
  planId: string;
  recipes: Recipe[];
  onChanged: () => Promise<void>;
  /** Bumped after any recurring-entry write elsewhere on the page (e.g. the
   * top-level authoring form) so this already-expanded panel refetches. */
  refreshToken: number;
}

/** A plan's retained entries, fetched from GET /api/meal-plans/:id/entries —
 * NOT the derived menu, which excludes inactive plans (this is the key UX
 * requirement: a deactivated plan's entries stay editable/deletable here
 * without reactivating the plan).
 */
function PlanEntriesPanel({ t, planId, recipes, onChanged, refreshToken }: PlanEntriesPanelProps) {
  const [entries, setEntries] = useState<MealEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [planId, refreshToken]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/meal-plans/${planId}/entries`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load plan entries");
      setEntries((await res.json()) as MealEntry[]);
    } catch {
      setError(t("meals.plan.entriesError"));
    } finally {
      setLoading(false);
    }
  }

  async function saveEntry(id: string, updates: MealEntryEditInput): Promise<boolean> {
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
      setError(t("meals.plan.entriesError"));
      return false;
    }
  }

  async function removeEntry(id: string) {
    try {
      const res = await authFetch(`/api/meal-entries/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete entry");
      await load();
      await onChanged();
    } catch {
      setError(t("meals.plan.entriesError"));
    }
  }

  if (loading) return <p>{t("meals.plan.loading")}</p>;

  return (
    <div>
      <ErrorNotice message={error} className="mb-2" />
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("meals.plan.entriesEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
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
            <span className="font-semibold">
              {weekdayLabel(t, entry.weekday)} · {t(SLOT_LABEL_KEYS[entry.slot])}:
            </span>{" "}
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
/* Recurring-entry authoring — kind:"recurring", mealPlanId + */
/* weekday; content recipeId xor note (FR-025). */
/* ------------------------------------------------------------------ */

interface RecurringEntryAuthoringFormProps {
  t: (key: MessageKey) => string;
  recipes: Recipe[];
  plans: MealPlan[];
  onCreate: (input: MealEntryInput) => Promise<boolean>;
}

function RecurringEntryAuthoringForm({
  t,
  recipes,
  plans,
  onCreate,
}: RecurringEntryAuthoringFormProps) {
  const [mealPlanId, setMealPlanId] = useState("");
  const [weekday, setWeekday] = useState<Weekday>("mon");
  const [slot, setSlot] = useState<Slot>("breakfast");
  const [contentMode, setContentMode] = useState<"recipe" | "note">("recipe");
  const [recipeId, setRecipeId] = useState("");
  const [note, setNote] = useState("");

  const availableRecipes = recipes.filter((recipe) => isRecipeAvailableForSlot(recipe, slot));
  const canSubmit = !!mealPlanId && (contentMode === "recipe" ? !!recipeId : !!note.trim());

  const reset = () => {
    setRecipeId("");
    setNote("");
  };

  return (
    <div className="bg-card p-4 rounded-lg shadow mb-6">
      {plans.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("meals.plan.noPlansForRecurring")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 items-center flex-wrap">
            <label className={LABEL_INLINE_CLASSES}>
              {t("meals.plan.selectLabel")}
              <select
                data-testid="meals-recurring-plan-select"
                value={mealPlanId}
                onChange={(e) => setMealPlanId(e.target.value)}
                className={NATIVE_SELECT_CLASSES}
              >
                <option value="">{t("meals.plan.selectPlaceholder")}</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                    {plan.active ? "" : ` (${t("meals.plan.statusInactive")})`}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">{t("meals.plan.weekdayLabel")}</span>
              <WeekdayPicker
                mode="single"
                value={weekday}
                onChange={setWeekday}
                labels={weekdayLabels(t)}
                groupLabel={t("meals.plan.weekdayLabel")}
                testIdPrefix="meals-recurring-weekday"
              />
            </div>
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
              name="meals-recurring-content-mode"
              value="recipe"
              checked={contentMode === "recipe"}
              onChange={() => setContentMode("recipe")}
              label={t("meals.entries.contentModeRecipe")}
            />
            <RadioField
              name="meals-recurring-content-mode"
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

          <Button
            onClick={() => {
              if (!canSubmit) return;
              void (async () => {
                const input: MealEntryInput =
                  contentMode === "recipe"
                    ? { kind: "recurring", mealPlanId, weekday, slot, recipeId }
                    : { kind: "recurring", mealPlanId, weekday, slot, note: note.trim() };
                const succeeded = await onCreate(input);
                if (succeeded) reset();
              })();
            }}
            disabled={!canSubmit}
            className="self-start"
          >
            {t("meals.plan.recurringEntryAction")}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Week view — GET /api/menu/week: date -> slot -> MenuItem[], */
/* rendered as a 7-day x slot grid. Total order preserved (no */
/* re-sorting of items within a cell); tombstone-localized. */
/* ------------------------------------------------------------------ */

interface WeekMenuViewProps {
  t: (key: MessageKey) => string;
  anchorDate: string;
  onAnchorDateChange: (date: string) => void;
  week: Record<string, Record<Slot, MenuItem[]>>;
  loading: boolean;
  error: string | null;
}

function WeekMenuView({
  t,
  anchorDate,
  onAnchorDateChange,
  week,
  loading,
  error,
}: WeekMenuViewProps) {
  const dates = Object.keys(week);

  return (
    <div className="bg-card p-4 rounded-lg shadow">
      <div className="flex gap-2 items-center flex-wrap mb-4">
        <label className={LABEL_INLINE_CLASSES}>
          {t("meals.week.dateLabel")}
          <Input
            type="date"
            data-testid="meals-week-date-input"
            value={anchorDate}
            onChange={(e) => onAnchorDateChange(e.target.value)}
          />
        </label>
      </div>

      <ErrorNotice message={error} className="mb-2" />

      {loading ? (
        <p>{t("meals.week.loading")}</p>
      ) : dates.length === 0 ? (
        <p className="text-muted-foreground">{t("meals.week.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="meals-week-grid">
            <thead>
              <tr>
                <th className="text-left p-2"></th>
                {dates.map((date) => (
                  <th key={date} className="text-left p-2 font-semibold">
                    {date}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SLOTS.map((slot) => (
                <tr key={slot}>
                  <td className="p-2 font-semibold align-top">{t(SLOT_LABEL_KEYS[slot])}</td>
                  {dates.map((date) => {
                    const items = week[date]?.[slot] ?? [];
                    return (
                      <td key={date} className="p-2 align-top">
                        {items.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {items.map((item) => (
                              <li key={item.entryId} className="text-xs">
                                {item.isTombstone ? t("meals.menu.tombstoneLabel") : item.label}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
