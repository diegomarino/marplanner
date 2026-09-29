// PORTED from v1 `apps/api/src/blocks/on-this-day.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). Group
// titles ("Events"/"Births"/"Deaths") render in the household language via
// `../labels.ts` (DAILY-BRIEFING-INV-06, P1 fold).
import { createElement, type ReactElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";
import { labelsFromCtx } from "../labels";

const schema: ZodType<{
  events?: string[];
  births?: string[];
  deaths?: string[];
}> = z.object({
  events: z.array(z.string()).optional(),
  births: z.array(z.string()).optional(),
  deaths: z.array(z.string()).optional(),
});
export type OnThisDayData = z.infer<typeof schema>;

/** Bold the leading 3-4 digit year of a corpus line (e.g. "1969: Moon landing"). */
function onThisDayLine(bullet: string, line: string, key: number): ReactElement {
  const match = /^(\d{3,4})(:.*)$/.exec(line);
  if (!match) return createElement("div", { key }, `${bullet} ${line}`);

  return createElement(
    "div",
    { key, style: { display: "flex" } },
    createElement(
      "span",
      null,
      `${bullet} `,
      createElement("span", { style: { fontWeight: 700 } }, match[1]),
      createElement("span", null, match[2])
    )
  );
}

export const onThisDayBlock: BlockDefinition<OnThisDayData> = defineBlock({
  type: "onThisDay",
  schema,
  render: ({ data, ctx }) => {
    const bullet = ctx.theme.listItemBullet;
    const labels = labelsFromCtx(ctx).onThisDay;
    const groups: { title: string; items: string[] }[] = [];
    if (data.events?.length) groups.push({ title: labels.events, items: data.events });
    if (data.births?.length) groups.push({ title: labels.births, items: data.births });
    if (data.deaths?.length) groups.push({ title: labels.deaths, items: data.deaths });
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 8 } },
      groups.map((g, gi) =>
        createElement(
          "div",
          { key: gi, style: { display: "flex", flexDirection: "column", gap: 4 } },
          createElement("div", { style: { fontWeight: 700 } }, g.title),
          g.items.map((it, ii) => onThisDayLine(bullet, it, ii))
        )
      )
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
