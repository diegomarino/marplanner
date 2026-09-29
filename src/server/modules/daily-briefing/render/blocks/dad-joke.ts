// PORTED from v1 `apps/api/src/blocks/dad-joke.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ text: string }> = z.object({ text: z.string() });
export type DadJokeData = z.infer<typeof schema>;

export const dadJokeBlock: BlockDefinition<DadJokeData> = defineBlock({
  type: "dadJoke",
  schema,
  render: ({ data }) => createElement("div", { style: { width: "100%", padding: 8 } }, data.text),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
