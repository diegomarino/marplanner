// PORTED from v1 `apps/api/src/blocks/streak-text.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
// Text-only streak variant: shares the schema with `streak` (render/blocks/
// streak.ts, same adapter case) but renders the last7 dots as ASCII
// `[x]`/`[ ]` tiles instead of the SVG dot strip.
import { createElement } from "react";
import { applyTextStyle, defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ days: number; last7: boolean[]; label: string }> = z.object({
  days: z.number(),
  last7: z.array(z.boolean()),
  label: z.string(),
});
export type StreakTextData = z.infer<typeof schema>;

export const streakTextBlock: BlockDefinition<StreakTextData> = defineBlock({
  type: "streakText",
  schema,
  render: ({ data, ctx }) => {
    const labelText = data.label.replace(/^\s*\d+\s*/, "");
    const dotsText = data.last7.map((on) => (on ? "[x]" : "[ ]")).join("");
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 4 } },
      createElement(
        "div",
        { style: applyTextStyle(ctx.theme.textStyles.display, ctx.fontRoles) },
        String(data.days)
      ),
      createElement(
        "div",
        { style: applyTextStyle(ctx.theme.textStyles.body, ctx.fontRoles) },
        dotsText
      ),
      createElement(
        "div",
        { style: applyTextStyle(ctx.theme.textStyles.body, ctx.fontRoles) },
        labelText
      )
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
