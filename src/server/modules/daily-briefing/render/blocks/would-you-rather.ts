// PORTED from v1 `apps/api/src/blocks/would-you-rather.tsx` — createElement
// form (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ optionA: string; optionB: string }> = z.object({
  optionA: z.string(),
  optionB: z.string(),
});
export type WouldYouRatherData = z.infer<typeof schema>;

export const wouldYouRatherBlock: BlockDefinition<WouldYouRatherData> = defineBlock({
  type: "wouldYouRather",
  schema,
  render: ({ data }) =>
    createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
      createElement(
        "div",
        { style: { display: "flex", gap: 6 } },
        createElement("div", { style: { fontWeight: 700 } }, "A:"),
        createElement("div", null, data.optionA)
      ),
      createElement(
        "div",
        { style: { display: "flex", gap: 6 } },
        createElement("div", { style: { fontWeight: 700 } }, "B:"),
        createElement("div", null, data.optionB)
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
