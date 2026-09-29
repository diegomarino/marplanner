// PORTED from v1 `apps/api/src/blocks/today.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
import { createElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";

const schema: ZodType<{ bullets: string[] }> = z.object({ bullets: z.array(z.string()) });
export type TodayData = z.infer<typeof schema>;

export const todayBlock: BlockDefinition<TodayData> = defineBlock({
  type: "today",
  schema,
  render: ({ data, ctx }) => {
    const bullet = ctx.theme.listItemBullet;
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 4 } },
      data.bullets.map((b, i) => createElement("div", { key: i }, `${bullet} ${b}`))
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
