import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Apple, ChefHat, Coffee, Edit2, Plus, Search, Utensils } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Recipe, RecipeEditInput, RecipeInput, Slot } from "../../shared";
import { RecipeDetailDialog } from "./RecipeDetailDialog";
import { RecipeDialog } from "./RecipeDialog";

const SLOTS: Slot[] = ["breakfast", "lunch", "snack", "dinner"];

const SLOT_BADGES: Record<Slot, { Icon: LucideIcon; className: string }> = {
  breakfast: { Icon: Coffee, className: "bg-accent/20 text-accent-foreground" },
  lunch: { Icon: Utensils, className: "bg-primary/10 text-primary" },
  snack: { Icon: Apple, className: "bg-destructive/10 text-destructive" },
  dinner: { Icon: ChefHat, className: "bg-secondary text-secondary-foreground" },
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
  const [selected, setSelected] = useState<Recipe | null>(null);
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
                  <Button
                    type="button"
                    variant="link"
                    wrap
                    className="justify-start p-0 text-left font-semibold"
                    onClick={() => setSelected(recipe)}
                  >
                    {recipe.name}
                  </Button>
                  <div className="mt-2 flex flex-wrap gap-1 text-xs">
                    {(recipe.slots?.length ? recipe.slots : SLOTS).map((slot) => {
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
                          {recipe.slots?.length
                            ? t(
                                `meals.slot.${slot}` as
                                  | "meals.slot.breakfast"
                                  | "meals.slot.lunch"
                                  | "meals.slot.snack"
                                  | "meals.slot.dinner"
                              )
                            : t("meals.recipes.allSlots")}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  title={t("meals.action.edit")}
                  aria-label={t("meals.action.edit")}
                  onClick={() => setEditing(recipe)}
                >
                  <Edit2 aria-hidden="true" />
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
      <RecipeDetailDialog
        recipe={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
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
