// PORTED from v1 `apps/api/src/blocks/animal-fact.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ text: string; animal: string }> = z.object({
  text: z.string(),
  animal: z.string(),
});
export type AnimalFactData = z.infer<typeof schema>;

export const animalFactBlock: BlockDefinition<AnimalFactData> = defineBlock({
  type: "animalFact",
  schema,
  render: ({ data }) =>
    createElement("div", { style: { width: "100%", padding: 8, display: "flex" } }, data.text),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
