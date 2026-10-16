import { useId } from "react";

import { PillToggle } from "@/components/PillToggle";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { MEAL_ORIGIN_TONE_CLASS, type MealOriginPill } from "./meal-origins";

/** Origin pills above the week grid. They highlight, never filter: the caller dims the meals of
 * unselected origins in place (spec O4). */
export interface MealOriginPillsProps {
  pills: readonly MealOriginPill[];
  selected: readonly string[];
  onChange(next: string[]): void;
}

export function MealOriginPills({ pills, selected, onChange }: MealOriginPillsProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(pills.filter((pill) => next.has(pill.id)).map((pill) => pill.id));
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
      <span id={labelId} className="text-muted-foreground text-sm font-medium">
        {t("meals.origin.groupLabel")}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        data-testid="meal-origin-pills"
        className="flex flex-wrap gap-2"
      >
        {pills.map((pill) => (
          <PillToggle
            key={pill.id}
            label={pill.label}
            checked={selected.includes(pill.id)}
            onChange={(checked) => toggle(pill.id, checked)}
            colorClassName={cn("meal-origin-pill", MEAL_ORIGIN_TONE_CLASS[pill.tone])}
            data-testid={`meal-origin-pill-${pill.id}`}
          />
        ))}
      </div>
    </div>
  );
}
