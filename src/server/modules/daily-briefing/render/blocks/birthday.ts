// PORTED from v1 `apps/api/src/blocks/birthday.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// "No upcoming birthdays" fallback renders in the household language via
// `../labels.ts` (DAILY-BRIEFING-INV-06, P1 fold). `data.ownLabel`
// itself is a GENERATOR-emitted snapshot string (../../blocks/birthday.ts,
// same fold) — already in the household language by the time it reaches
// this def, so it renders verbatim here, unlike the fallback below.
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";
import { labelsFromCtx } from "../labels";

const schema: ZodType<{
  daysUntilOwn?: number;
  ownLabel?: string;
  family: { name: string; daysUntil: number }[];
}> = z.object({
  daysUntilOwn: z.number().optional(),
  ownLabel: z.string().optional(),
  family: z.array(z.object({ name: z.string(), daysUntil: z.number() })),
});
export type BirthdayData = z.infer<typeof schema>;

export const birthdayBlock: BlockDefinition<BirthdayData> = defineBlock({
  type: "birthday",
  schema,
  render: ({ data, ctx }) => {
    // Empty-payload guard: legacy birthdayBlock.generate returns null when
    // both own birthday is absent AND family list is empty (no rows to show),
    // so the orchestrator never produces an envelope with all-empty data. But
    // a future producer might, so we render a one-line fallback to keep the
    // block visually present (single line, no orphaned headers).
    const hasOwn = data.ownLabel !== undefined;
    const hasFamily = data.family.length > 0;
    if (!hasOwn && !hasFamily) {
      return createElement(
        "div",
        { style: { width: "100%", padding: 8, fontSize: 14, color: "#666" } },
        labelsFromCtx(ctx).birthday.noUpcoming
      );
    }
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 8 } },
      hasOwn ? createElement("div", { style: { fontWeight: 700 } }, data.ownLabel) : null,
      hasFamily
        ? createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 4 } },
            data.family.map((m, i) =>
              createElement(
                "div",
                {
                  key: i,
                  style: {
                    display: "flex",
                    flexDirection: "row",
                    width: "100%",
                    justifyContent: "space-between",
                  },
                },
                createElement("div", { style: { fontWeight: 700 } }, m.name),
                createElement("div", null, `${m.daysUntil} d`)
              )
            )
          )
        : null
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
