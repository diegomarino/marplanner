import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Apple, ChefHat, ChevronRight, Coffee, Plus, Search, Utensils } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Recipe, RecipeEditInput, RecipeInput, Slot } from "../../shared";
import { RecipeDialog } from "./RecipeDialog";

const SLOT_BADGES: Record<Slot, { Icon: LucideIcon; className: string }> = {
  breakfast: { Icon: Coffee, className: "bg-meal-breakfast/15 text-meal-breakfast" },
  lunch: { Icon: Utensils, className: "bg-meal-lunch/15 text-meal-lunch" },
  snack: { Icon: Apple, className: "bg-meal-snack/15 text-meal-snack" },
  dinner: { Icon: ChefHat, className: "bg-meal-dinner/15 text-meal-dinner" },
};

interface RecipeCatalogueProps {
  recipes: Recipe[];
  onSearch(query: string): void;
  onCreate(input: RecipeInput): Promise<boolean>;
  onEdit(id: string, input: RecipeEditInput): Promise<boolean>;
  error?: string | null;
  onRetry?: () => void;
}

export function RecipeCatalogue({
  recipes,
  onSearch,
  onCreate,
  onEdit,
  error,
  onRetry,
}: RecipeCatalogueProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <aside data-testid="recipe-catalogue" className="w-full min-w-0 space-y-4 lg:border-l lg:pl-6">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="text-2xl font-bold tracking-tight">{t("meals.recipes.title")}</h2>
        <Button type="button" className="gap-2" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          {t("meals.recipes.new")}
        </Button>
      </div>
      <div className="relative">
        <Search
          aria-hidden="true"
          data-testid="recipe-search-icon"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          role="searchbox"
          className="pl-10"
          aria-label={t("meals.recipes.searchPlaceholder")}
          placeholder={t("meals.recipes.searchPlaceholder")}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      {error && (
        <div className="space-y-2">
          <ErrorNotice message={error} />
          <Button type="button" variant="outline" onClick={onRetry}>
            {t("meals.week.retry")}
          </Button>
        </div>
      )}
      <div className="max-h-[calc(100vh-16rem)] space-y-2 overflow-y-auto pr-1">
        {recipes.length === 0 ? (
          <p className="text-muted-foreground">{t("meals.recipes.noRecipes")}</p>
        ) : (
          recipes.map((recipe) => (
            <article
              key={recipe.id}
              data-testid={`recipe-card-${recipe.id}`}
              className="rounded-2xl border bg-card px-4 py-3 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-control font-semibold break-words">{recipe.name}</h3>
                  <div className="mt-1 flex flex-wrap gap-1 text-xs">
                    {recipe.slots?.length ? (
                      recipe.slots.map((slot) => {
                        const { Icon, className } = SLOT_BADGES[slot];
                        return (
                          <span
                            key={slot}
                            data-testid={`recipe-slot-badge-${slot}`}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border border-current/15 px-2 py-1",
                              className
                            )}
                          >
                            <Icon
                              aria-hidden="true"
                              data-testid="recipe-slot-icon"
                              className="size-3"
                            />
                            {t(
                              `meals.slot.${slot}` as
                                | "meals.slot.breakfast"
                                | "meals.slot.lunch"
                                | "meals.slot.snack"
                                | "meals.slot.dinner"
                            )}
                          </span>
                        );
                      })
                    ) : (
                      // No slots stored means the recipe suits every meal: say so once.
                      <span
                        data-testid="recipe-slot-badge-all"
                        className="bg-muted text-muted-foreground inline-flex items-center rounded-full border border-current/15 px-2 py-1"
                      >
                        {t("meals.recipes.allSlots")}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  title={t("meals.recipes.openDetail")}
                  aria-label={`${t("meals.recipes.openDetail")}: ${recipe.name}`}
                  onClick={() => setEditing(recipe)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
      <RecipeDialog
        open={creating}
        mode="create"
        recipe={null}
        onClose={() => setCreating(false)}
        onSave={onCreate}
      />
      <RecipeDialog
        open={editing !== null}
        mode="edit"
        recipe={editing}
        onClose={() => setEditing(null)}
        onSave={(input) => (editing ? onEdit(editing.id, input) : Promise.resolve(false))}
      />
    </aside>
  );
}
