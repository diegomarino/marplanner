import { getMenu } from "../../../host-api";
import type { BriefingMealItem } from "../../../../shared";

const TYPE = "meals";

export interface MealsBlockContext {
  date: string;
}

export interface MealsBlockData {
  lunch?: BriefingMealItem[];
  snack?: BriefingMealItem[];
  dinner?: BriefingMealItem[];
}

export const mealsBlock = {
  type: TYPE,
  scope: "shared" as const,
  source: "src/server/modules/meals getMenu (host-api-barrel-exported, 010 precedent)",
  generate(ctx: MealsBlockContext): MealsBlockData | null {
    const items = getMenu(ctx.date, undefined);
    const data: MealsBlockData = {};
    // Breakfast coverage remains a separate product decision (ADR-045).
    for (const slot of ["lunch", "snack", "dinner"] as const) {
      const entries = items
        .filter((item) => item.slot === slot)
        .map((item): BriefingMealItem => ({
          kind: item.recipeId !== null ? "recipe" : "note",
          label: item.label,
        }));
      if (entries.length > 0) data[slot] = entries;
    }
    return Object.keys(data).length > 0 ? data : null;
  },
};
