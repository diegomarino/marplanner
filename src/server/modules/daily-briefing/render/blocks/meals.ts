// PORTED from v1 `apps/api/src/blocks/meals.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// "Lunch"/"Snack"/"Dinner" labels render in the household language via
// `../labels.ts` (DAILY-BRIEFING-INV-06, P1 fold).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";
import { labelsFromCtx } from "../labels";

const schema: ZodType<{ lunch?: string; snack?: string; dinner?: string }> = z.object({
  lunch: z.string().optional(),
  snack: z.string().optional(),
  dinner: z.string().optional(),
});
export type MealsData = z.infer<typeof schema>;

export const mealsBlock: BlockDefinition<MealsData> = defineBlock({
  type: "meals",
  schema,
  render: ({ data, ctx }) => {
    const labels = labelsFromCtx(ctx).meals;
    const items: { id: string; value: string }[] = [];
    if (data.lunch) items.push({ id: labels.lunch, value: data.lunch });
    if (data.snack) items.push({ id: labels.snack, value: data.snack });
    if (data.dinner) items.push({ id: labels.dinner, value: data.dinner });
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 4 } },
      items.map((it, i) =>
        createElement(
          "div",
          { key: i, style: { width: "100%", display: "flex", gap: 6, alignItems: "flex-start" } },
          createElement("div", { style: { fontWeight: 700, flexShrink: 0 } }, `${it.id}:`),
          createElement(
            "div",
            { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, width: "100%" } },
            it.value
          )
        )
      )
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
