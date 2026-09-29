// PORTED from v1 `apps/api/src/blocks/quote-of-day.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ text: string; author: string }> = z.object({
  text: z.string(),
  author: z.string(),
});
export type QuoteOfDayData = z.infer<typeof schema>;

export const quoteOfDayBlock: BlockDefinition<QuoteOfDayData> = defineBlock({
  type: "quoteOfDay",
  schema,
  render: ({ data }) =>
    createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 4 } },
      createElement("div", null, `"${data.text}"`),
      createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row",
            justifyContent: "flex-end",
            width: "100%",
          },
        },
        `— ${data.author}`
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
