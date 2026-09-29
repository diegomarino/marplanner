// PORTED from v1 `apps/api/src/blocks/shotgun.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ ranking: string[] }> = z.object({ ranking: z.array(z.string()) });
export type ShotgunData = z.infer<typeof schema>;

export const shotgunBlock: BlockDefinition<ShotgunData> = defineBlock({
  type: "shotgun",
  schema,
  render: ({ data }) =>
    createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 4 } },
      data.ranking.map((name, i) =>
        createElement(
          "div",
          { key: i, style: { display: "flex", gap: 6 } },
          createElement("div", { style: { fontWeight: 700 } }, `#${i + 1}`),
          createElement("div", null, name)
        )
      )
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
