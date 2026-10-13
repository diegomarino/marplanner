import { Textarea } from "@/components/ui/textarea";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { PillToggle } from "@/components/PillToggle";
import { Field } from "@/components/Field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useTranslation } from "@/i18n";
import type { Recipe, RecipeEditInput, RecipeInput, Slot } from "../../shared";

const SLOTS: Slot[] = ["breakfast", "lunch", "snack", "dinner"];

/** A textarea that starts at its usual size and grows with its text, so a long ingredient list
 * or method is read in full. The caller caps the height; past the cap the field scrolls inside
 * itself, which keeps the dialog's own buttons on screen.
 */
function GrowingTextarea({ value, ...props }: ComponentProps<typeof Textarea>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Collapse first: scrollHeight never reports less than the current height.
    element.style.height = "auto";
    if (element.scrollHeight > 0) element.style.height = `${element.scrollHeight + 2}px`;
  }, [value]);
  return <Textarea ref={ref} value={value} {...props} />;
}

interface RecipeDialogProps {
  open: boolean;
  mode: "create" | "edit";
  recipe: Recipe | null;
  onClose(): void;
  onSave(input: RecipeInput | RecipeEditInput): Promise<boolean>;
}

export function RecipeDialog({ open, mode, recipe, onClose, onSave }: RecipeDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [instructions, setInstructions] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(recipe?.name ?? "");
    setIngredients(recipe?.ingredients?.join("\n") ?? "");
    setInstructions(recipe?.instructions ?? "");
    setSlots(recipe?.slots ?? []);
    setError(null);
  }, [recipe, open]);

  async function save() {
    setSaving(true);
    setError(null);
    const normalizedIngredients = ingredients
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const payload = {
      name: name.trim(),
      slots: slots.length ? slots : mode === "edit" ? [] : undefined,
      ingredients: normalizedIngredients,
      instructions,
    };
    const success = await onSave(payload);
    setSaving(false);
    if (success) onClose();
    else setError(t("meals.management.error"));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent
        closeLabel={t("meals.recipes.detailClose")}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? t("meals.recipes.createTitle") : t("meals.action.edit")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label={t("meals.recipes.nameLabel")}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t("meals.recipes.ingredientsLabel")}>
            <GrowingTextarea
              aria-label={t("meals.recipes.ingredientsInputLabel")}
              value={ingredients}
              onChange={(event) => setIngredients(event.target.value)}
              className="max-h-[25dvh] min-h-24 resize-none overflow-y-auto"
            />
          </Field>
          <Field label={t("meals.recipes.instructionsLabel")}>
            <GrowingTextarea
              aria-label={t("meals.recipes.instructionsInputLabel")}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              className="max-h-[25dvh] min-h-24 resize-none overflow-y-auto"
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t("meals.recipes.slotsLabel")}</legend>
            <div className="flex flex-wrap gap-2">
              {SLOTS.map((slot) => (
                <PillToggle
                  key={slot}
                  label={t(
                    `meals.slot.${slot}` as
                      | "meals.slot.breakfast"
                      | "meals.slot.lunch"
                      | "meals.slot.snack"
                      | "meals.slot.dinner"
                  )}
                  checked={slots.includes(slot)}
                  onChange={(checked) =>
                    setSlots((current) =>
                      checked ? [...current, slot] : current.filter((value) => value !== slot)
                    )
                  }
                />
              ))}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{t("meals.recipes.slotsHint")}</p>
          </fieldset>
          <ErrorNotice message={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            {t("meals.action.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {t("meals.action.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
