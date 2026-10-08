// PORTED from v1 `apps/api/src/blocks/meals.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// "Lunch"/"Snack"/"Dinner" labels render in the household language via
// `../labels.ts` (DAILY-BRIEFING-INV-06, P1 fold).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { z } from "zod";
import { labelsFromCtx } from "../labels";

const slotSchema = z.union([
  z.string(),
  z.array(z.object({ kind: z.enum(["recipe", "note"]), label: z.string() })),
]);
const schema = z.object({
  lunch: slotSchema.optional(),
  snack: slotSchema.optional(),
  dinner: slotSchema.optional(),
});
export type MealsData = z.infer<typeof schema>;

export const mealsBlock: BlockDefinition<MealsData> = defineBlock({
  type: "meals",
  schema,
  render: ({ data, ctx }) => {
    const labels = labelsFromCtx(ctx).meals;
    const items: { id: string; value: string }[] = [];
    for (const slot of ["lunch", "snack", "dinner"] as const) {
      const entries = data[slot];
      if (entries === undefined) continue;
      const value =
        typeof entries === "string" ? entries : entries.map((item) => item.label).join(", ");
      if (value) items.push({ id: labels[slot], value });
    }
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
