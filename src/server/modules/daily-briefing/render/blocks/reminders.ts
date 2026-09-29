// PORTED from v1 `apps/api/src/blocks/reminders.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note).
// Reminders shares its schema with pressedslip's built-in `listBlock` (same
// shape as the adapter's "reminders" case, render/adapter.ts) but implements
// its own render so it can prepend `ctx.theme.listItemBullet` to each item —
// pressedslip's own listBlock has no bullet-prefix option.
import { createElement } from "react";
import { defineBlock, listBlock, type BlockDefinition } from "pressedslip";
import type { ZodType } from "zod";

export type RemindersData = {
  groups: {
    title?: string | undefined;
    separator?: string | undefined;
    items: { id?: string | undefined; value: string }[];
  }[];
};

export const remindersBlock: BlockDefinition<RemindersData> = defineBlock({
  type: "reminders",
  schema: listBlock.schema as unknown as ZodType<RemindersData>,
  render: ({ data, ctx }) => {
    const bullet = ctx.theme.listItemBullet;
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 8 } },
      data.groups.map((g, gi) =>
        createElement(
          "div",
          { key: gi, style: { display: "flex", flexDirection: "column", gap: 4 } },
          g.title ? createElement("div", { style: { fontWeight: 700 } }, g.title) : null,
          g.items.map((item, ii) => createElement("div", { key: ii }, `${bullet} ${item.value}`))
        )
      )
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "compact" },
});
