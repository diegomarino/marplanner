// PORTED from v1 `apps/api/src/blocks/riddle.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// answer line uses the theme's `answer` text style (render/theme.ts,
// `rotate: 180`) via `applyTextStyle`, producing the printed
// upside-down-answer convention (`transform: rotate(180deg)`).
import { createElement } from "react";
import { applyTextStyle, defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ question: string; answer: string }> = z.object({
  question: z.string(),
  answer: z.string(),
});
export type RiddleData = z.infer<typeof schema>;

export const riddleBlock: BlockDefinition<RiddleData> = defineBlock({
  type: "riddle",
  schema,
  render: ({ data, ctx }) =>
    createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
      createElement("div", null, data.question),
      createElement(
        "div",
        { style: applyTextStyle(ctx.theme.textStyles.answer, ctx.fontRoles) },
        data.answer
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
