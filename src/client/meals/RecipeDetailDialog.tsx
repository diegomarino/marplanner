import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Recipe } from "../../shared";
import { useTranslation } from "@/i18n";

export function RecipeDetailDialog({
  recipe,
  open,
  onClose,
}: {
  recipe: Recipe | null;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  if (!recipe) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent closeLabel={t("meals.recipes.detailClose")}>
        <DialogHeader>
          <DialogTitle>{recipe.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="font-semibold">{t("meals.recipes.detailIngredients")}</h3>
            <ul className="list-disc pl-5">
              {recipe.ingredients?.map((ingredient) => (
                <li key={ingredient}>{ingredient}</li>
              ))}
            </ul>
          </div>
          {recipe.instructions && <p>{recipe.instructions}</p>}
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("meals.recipes.detailClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
