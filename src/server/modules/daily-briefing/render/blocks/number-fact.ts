// PORTED from v1 `apps/api/src/blocks/number-fact.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ number: number; fact: string; kind: "math" | "trivia" }> = z.object({
  number: z.number(),
  fact: z.string(),
  kind: z.union([z.literal("math"), z.literal("trivia")]),
});
export type NumberFactData = z.infer<typeof schema>;

export const numberFactBlock: BlockDefinition<NumberFactData> = defineBlock({
  type: "numberFact",
  schema,
  render: ({ data }) =>
    createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", width: "100%" } },
      createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row",
            width: "100%",
            justifyContent: "space-between",
            alignItems: "flex-start",
          },
        },
        createElement(
          "div",
          {
            style: {
              display: "flex",
              fontSize: 48,
              fontWeight: 700,
              lineHeight: 1.1,
              color: "black",
              marginLeft: "auto",
            },
          },
          String(data.number)
        )
      ),
      createElement("div", { style: { display: "flex", height: 8, width: "100%" } }),
      createElement(
        "div",
        {
          style: {
            display: "flex",
            width: "100%",
            fontSize: 22,
            fontWeight: 500,
            lineHeight: 1.4,
            color: "black",
          },
        },
        data.fact
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
