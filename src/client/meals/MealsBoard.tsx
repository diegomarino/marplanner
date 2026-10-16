import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import { useMealsWorkspace } from "./useMealsWorkspace";
import { MealPlanGrid } from "./MealPlanGrid";
import { MealEntryDialog, type MealEntryTarget } from "./MealEntryDialog";
import { RecipeCatalogue } from "./RecipeCatalogue";
import { useMealOrigins } from "./meal-origins";
import { useTranslation } from "@/i18n";

export const SLOT_LABEL_KEYS = {
  breakfast: "meals.slot.breakfast",
  lunch: "meals.slot.lunch",
  snack: "meals.slot.snack",
  dinner: "meals.slot.dinner",
} as const;

export function MealsBoard(): React.JSX.Element {
  const { timezone } = useHouseholdSettings();
  const { t } = useTranslation();
  const workspace = useMealsWorkspace();
  const origins = useMealOrigins(workspace.plans);
  const [target, setTarget] = useState<MealEntryTarget | null>(null);
  return (
    <div className="p-6">
      <ErrorNotice message={workspace.weekError} />
      {workspace.weekError && (
        <Button
          type="button"
          variant="outline"
          className="mb-4"
          onClick={() => void workspace.retryWeek()}
        >
          {t("meals.week.retry")}
        </Button>
      )}
      <ErrorNotice message={workspace.plansError} />
      {workspace.plansError && (
        <Button
          type="button"
          variant="outline"
          className="mb-4"
          data-testid="meals-board-plans-retry"
          onClick={() => void workspace.retryPlans()}
        >
          {t("meals.week.retry")}
        </Button>
      )}
      <div
        data-testid="meals-board"
        className="grid min-h-[calc(100vh-8rem)] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(14rem,0.55fr)]"
      >
        {workspace.weekMenu === null ? (
          <p className="text-muted-foreground">{t("meals.week.loading")}</p>
        ) : (
          <MealPlanGrid
            weekDates={workspace.weekDates}
            weekMenu={workspace.weekMenu}
            todayDate={timezone ? todayInHouseholdTimezone(timezone) : null}
            pending={workspace.pending}
            onPrevious={workspace.goPreviousWeek}
            onCurrent={workspace.goCurrentWeek}
            onNext={workspace.goNextWeek}
            onAdd={(date, slot) => setTarget({ date, slot })}
            onSelect={(date, item) => setTarget({ date, slot: item.slot, item })}
            origin={{
              pills: origins.pills,
              tones: origins.tones,
              selected: origins.selected,
              onSelectedChange: origins.setSelected,
            }}
          />
        )}
        {
          <RecipeCatalogue
            recipes={workspace.recipes ?? []}
            onSearch={(query) => void workspace.searchRecipes(query)}
            onCreate={workspace.createRecipe}
            onEdit={workspace.editRecipe}
            error={workspace.recipeError}
            onRetry={() => void workspace.searchRecipes("")}
          />
        }
      </div>
      {target && workspace.recipes !== null && (
        <MealEntryDialog
          open
          target={target}
          recipes={workspace.recipes}
          onClose={() => setTarget(null)}
          onCreate={workspace.createEntry}
          onEdit={workspace.editEntry}
          onDelete={workspace.deleteEntry}
        />
      )}
    </div>
  );
}
