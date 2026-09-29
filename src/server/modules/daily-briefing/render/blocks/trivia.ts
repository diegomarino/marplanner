// PORTED from v1 `apps/api/src/blocks/trivia.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). Per
// DAILY-BRIEFING contract note (v1 comment, preserved): the answer is NEVER
// carried in this block's payload — `data` only has question/options/
// category/difficulty (FR-020, the adapter enforces the same shape).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{
  question: string;
  options: string[];
  category: string;
  difficulty: "easy" | "medium" | "hard";
}> = z.object({
  question: z.string(),
  options: z.array(z.string()),
  category: z.string(),
  difficulty: z.union([z.literal("easy"), z.literal("medium"), z.literal("hard")]),
});
export type TriviaData = z.infer<typeof schema>;

export const triviaBlock: BlockDefinition<TriviaData> = defineBlock({
  type: "trivia",
  schema,
  render: ({ data }) =>
    createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
      createElement("div", { style: { fontWeight: 700 } }, data.question),
      data.options.map((o, i) =>
        createElement(
          "div",
          { key: i, style: { display: "flex", gap: 6 } },
          createElement("div", { style: { fontWeight: 700 } }, `${String.fromCharCode(65 + i)}.`),
          createElement("div", null, o)
        )
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
