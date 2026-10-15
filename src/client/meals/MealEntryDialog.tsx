import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useEffect, useMemo, useState } from "react";

import { ChoicePills } from "@/components/ChoicePills";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { RadioField } from "@/components/RadioField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";
import type {
  MealEntryEditInput,
  MealEntryInput,
  MealPlan,
  MenuItem,
  Recipe,
  Slot,
} from "../../shared";
import { weekdayOf } from "../../shared/householdTime";

export interface MealEntryTarget {
  date: string;
  slot: Slot;
  item?: MenuItem;
}

interface MealEntryDialogProps {
  open: boolean;
  target: MealEntryTarget;
  recipes: Recipe[];
  /** Admin only: when set, creating offers "Repeat every <weekday>" in one of the active plans.
   * The family board omits it and only ever creates one-offs. */
  plans?: MealPlan[];
  onClose(): void;
  onCreate(input: MealEntryInput): Promise<boolean>;
  onEdit(id: string, input: MealEntryEditInput): Promise<boolean>;
  onDelete(id: string): Promise<boolean>;
}

function recipeAllowed(recipe: Recipe, slot: Slot): boolean {
  return recipe.slots === null || recipe.slots.length === 0 || recipe.slots.includes(slot);
}

export function MealEntryDialog({
  open,
  target,
  recipes,
  plans,
  onClose,
  onCreate,
  onEdit,
  onDelete,
}: MealEntryDialogProps) {
  const { t, language } = useTranslation();
  const editing = target.item !== undefined;
  const item = target.item;
  const offerRepeat = !editing && plans !== undefined;
  const activePlans = useMemo(() => (plans ?? []).filter((plan) => plan.active), [plans]);
  const [repeat, setRepeat] = useState<"once" | "weekly">("once");
  const [planId, setPlanId] = useState("");
  // The weekday of a calendar date does not depend on the timezone (FR-017).
  const weekday = weekdayOf(target.date, "UTC");
  const weekdayName = new Intl.DateTimeFormat(language, {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(`${target.date}T12:00:00Z`));
  const [mode, setMode] = useState<"recipe" | "note">(
    item ? (item.note !== null ? "note" : "recipe") : "recipe"
  );
  const [recipeId, setRecipeId] = useState(item?.recipeId ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setMode(item ? (item.note !== null ? "note" : "recipe") : "recipe");
    setRecipeId(item?.recipeId ?? "");
    setNote(item?.note ?? "");
    setError(null);
    setRepeat("once");
    setPlanId(activePlans.length === 1 ? activePlans[0].id : "");
  }, [item, target.date, target.slot, activePlans]);

  const availableRecipes = useMemo(
    () => recipes.filter((recipe) => recipeAllowed(recipe, target.slot)),
    [recipes, target.slot]
  );
  const hasContent = mode === "recipe" ? recipeId.length > 0 : note.trim().length > 0;

  async function submit() {
    setSaving(true);
    setError(null);
    const content = mode === "recipe" ? { recipeId } : { note };
    const success = editing
      ? await onEdit(item!.entryId, content)
      : await onCreate(
          repeat === "weekly"
            ? { kind: "recurring", mealPlanId: planId, weekday, slot: target.slot, ...content }
            : { kind: "oneoff", date: target.date, slot: target.slot, ...content }
        );
    setSaving(false);
    if (success) onClose();
    else setError(editing ? t("meals.entries.error") : t("meals.entries.error"));
  }

  async function remove() {
    if (!item) return;
    setSaving(true);
    const success = await onDelete(item.entryId);
    setSaving(false);
    if (success) onClose();
    else setError(t("meals.entries.deleteError"));
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !saving) onClose();
        }}
      >
        <DialogContent closeLabel={t("meals.recipes.detailClose")}>
          <DialogHeader>
            <DialogTitle>
              {editing ? t("meals.entries.editTitle") : t("meals.entries.title")}
            </DialogTitle>
            <DialogDescription>
              {target.date} ·{" "}
              {t(
                `meals.slot.${target.slot}` as
                  | "meals.slot.breakfast"
                  | "meals.slot.lunch"
                  | "meals.slot.snack"
                  | "meals.slot.dinner"
              )}
            </DialogDescription>
          </DialogHeader>
          {item?.isTombstone ? (
            <ErrorNotice message={t("meals.menu.tombstoneLabel")} />
          ) : (
            <div className="flex flex-col gap-4">
              {item?.source === "recurring" && (
                <p role="note" className="text-muted-foreground">
                  {t("meals.entries.recurringWarning")}
                </p>
              )}
              {offerRepeat && (
                <div className="flex flex-col gap-2">
                  <ChoicePills
                    groupLabel={t("meals.entries.repeatLabel")}
                    value={repeat}
                    onChange={setRepeat}
                    options={[
                      { value: "once", label: t("meals.entries.repeatOnce") },
                      {
                        value: "weekly",
                        label: `${t("meals.entries.repeatWeeklyPrefix")} ${weekdayName}`,
                        disabled: activePlans.length === 0,
                      },
                    ]}
                  />
                  {activePlans.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      {t("meals.entries.repeatNoActivePlan")}
                    </p>
                  )}
                  {repeat === "weekly" && (
                    <Field label={t("meals.plan.selectLabel")}>
                      <select
                        value={planId}
                        onChange={(event) => setPlanId(event.target.value)}
                        aria-label={t("meals.plan.selectLabel")}
                        className={NATIVE_SELECT_CLASSES}
                      >
                        <option value="">{t("meals.plan.selectPlaceholder")}</option>
                        {activePlans.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              )}
              <div className="flex gap-4">
                <RadioField
                  name="meal-content"
                  value="recipe"
                  checked={mode === "recipe"}
                  onChange={() => setMode("recipe")}
                  label={t("meals.entries.contentModeRecipe")}
                />
                <RadioField
                  name="meal-content"
                  value="note"
                  checked={mode === "note"}
                  onChange={() => setMode("note")}
                  label={t("meals.entries.contentModeNote")}
                />
              </div>
              {mode === "recipe" ? (
                <Field label={t("meals.entries.recipeSelectLabel")}>
                  <select
                    value={recipeId}
                    onChange={(event) => setRecipeId(event.target.value)}
                    aria-label={t("meals.entries.recipeSelectLabel")}
                    className={NATIVE_SELECT_CLASSES}
                  >
                    <option value="">{t("meals.entries.recipeSelectPlaceholder")}</option>
                    {availableRecipes.map((recipe) => (
                      <option key={recipe.id} value={recipe.id}>
                        {recipe.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field label={t("meals.entries.contentModeNote")}>
                  <Input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    aria-label={t("meals.entries.noteInputLabel")}
                  />
                </Field>
              )}
              <ErrorNotice message={error} />
              {/* The line stays reserved once there is content, so the dialog keeps its height. */}
              <p className="text-muted-foreground min-h-5 text-sm">
                {!hasContent && t("meals.entries.contentRequired")}
              </p>
            </div>
          )}
          <DialogFooter>
            {editing && !item?.isTombstone && (
              <Button
                type="button"
                variant="destructive"
                disabled={saving}
                onClick={() => setConfirmDelete(true)}
              >
                {t("meals.action.delete")}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {t("meals.action.cancel")}
            </Button>
            {!item?.isTombstone && (
              <Button
                type="button"
                disabled={saving || !hasContent || (repeat === "weekly" && !planId)}
                onClick={() => void submit()}
              >
                {editing ? t("meals.action.save") : t("meals.entries.action.add")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("meals.entries.deleteConfirm")}
        description={item?.source === "recurring" ? t("meals.entries.recurringWarning") : undefined}
        confirmLabel={t("meals.action.delete")}
        cancelLabel={t("meals.action.cancel")}
        onConfirm={() => void remove()}
      />
    </>
  );
}
