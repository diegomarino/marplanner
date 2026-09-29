// PORTED from v1 `apps/api/src/blocks/streak.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// 528px strip-centering math is v1's own layout constant (the block's
// content width on the 80mm thermal theme minus its shell padding) — ported
// verbatim, not recomputed against `ctx.contentWidth`, to stay pixel-exact
// with v1's SVG dot strip. The day-of-week strip renders in the household
// language via `../labels.ts` (DAILY-BRIEFING-INV-06, P1 fold);
// `data.label` itself is a GENERATOR-emitted snapshot string
// (../../blocks/streak.ts, same fold) — already in the household language
// by the time it reaches this def.
import { createElement } from "react";
import { applyTextStyle, defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";
import { labelsFromCtx } from "../labels";

const schema: ZodType<{ days: number; label: string; last7: boolean[] }> = z.object({
  days: z.number(),
  label: z.string(),
  last7: z.array(z.boolean()),
});
export type StreakData = z.infer<typeof schema>;

const DOT_DIAMETER = 24;
const DOT_RADIUS = 12;
const DOT_STRIDE = 64;
const STRIP_WIDTH = (7 - 1) * DOT_STRIDE + DOT_DIAMETER;

function dayLabels(date: string, dayLetters: readonly string[]): string[] {
  const today = new Date(`${date}T00:00:00.000Z`);
  const out: string[] = [];
  for (let i = 7; i >= 1; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dayLetters[d.getUTCDay()]);
  }
  return out;
}

export const streakBlock: BlockDefinition<StreakData> = defineBlock({
  type: "streak",
  schema,
  render: ({ data, ctx }) => {
    const labelText = data.label.replace(/^\s*\d+\s*/, "");
    const dayLetters = labelsFromCtx(ctx).streak.dayLetters;
    const labels = dayLabels(ctx.composition.date, dayLetters);
    const stripLeftMargin = (528 - STRIP_WIDTH) / 2;
    return createElement(
      "div",
      { style: { width: "100%", display: "flex", flexDirection: "column" } },
      createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            width: "100%",
            gap: 12,
          },
        },
        createElement(
          "div",
          { style: { display: "flex", flexDirection: "row", alignItems: "baseline", gap: 12 } },
          createElement(
            "div",
            { style: applyTextStyle(ctx.theme.textStyles.display, ctx.fontRoles) },
            String(data.days)
          ),
          createElement(
            "div",
            { style: { display: "flex", fontSize: 22, fontWeight: 500, color: "black" } },
            labelText
          )
        )
      ),
      createElement(
        "div",
        { style: { display: "flex", width: "100%", height: DOT_DIAMETER + 4, marginTop: 4 } },
        createElement(
          "svg",
          {
            width: STRIP_WIDTH,
            height: DOT_DIAMETER,
            viewBox: `0 0 ${STRIP_WIDTH} ${DOT_DIAMETER}`,
            style: { marginLeft: stripLeftMargin },
            role: "img",
            "aria-label": "Last 7 days completion strip",
          },
          data.last7.map((completed, i) => {
            const cx = i * DOT_STRIDE + DOT_RADIUS;
            return completed
              ? createElement("circle", {
                  key: `d-cx${cx}`,
                  cx,
                  cy: DOT_RADIUS,
                  r: DOT_RADIUS,
                  fill: "black",
                })
              : createElement("circle", {
                  key: `d-cx${cx}`,
                  cx,
                  cy: DOT_RADIUS,
                  r: DOT_RADIUS - 1,
                  fill: "white",
                  stroke: "black",
                  strokeWidth: 2,
                });
          })
        )
      ),
      createElement(
        "div",
        { style: { display: "flex", width: "100%", marginTop: 4, marginLeft: stripLeftMargin } },
        labels.map((letter, i) => {
          const cx = i * DOT_STRIDE + DOT_RADIUS;
          return createElement(
            "div",
            {
              key: `l-cx${cx}`,
              style: {
                display: "flex",
                justifyContent: "center",
                width: DOT_STRIDE,
                fontSize: 14,
                fontWeight: 500,
                color: "black",
              },
            },
            letter
          );
        })
      )
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
