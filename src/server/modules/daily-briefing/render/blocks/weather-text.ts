// PORTED from v1 `apps/api/src/blocks/weather-text.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// "Min/Max/Rain" labels render in the household language via `../labels.ts`
// (DAILY-BRIEFING-INV-06, P1 fold). Text-only weather variant:
// schema mirrors `weather.ts` field-for-field (same adapter case).
//
// rewritten to consume the REAL generator shape (`ForecastDay` —
// `conditionKey`/`tempMinC`/`tempMaxC`/`rainPct`), same as `weather.ts` — see that file's own
// doc comment for the full story. v1's headline line read `${currentTemperature}° · ${condition}`,
// but `ForecastDay` is a single DAY's forecast with no "current" reading at all — the headline
// becomes the localized condition label alone (`labelsFromCtx(ctx).weather.conditions`, the SAME
// map `weather.ts` reads), and the Min/Max/Rain lines below carry the temperature/precipitation
// data instead.
import { createElement } from "react";
import { applyTextStyle, defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";
import { labelsFromCtx } from "../labels";
import type { WeatherConditionKey } from "../../../../../shared";

const conditionEnum = z.union([
  z.literal("clear"),
  z.literal("mostlyClear"),
  z.literal("partlyCloudy"),
  z.literal("overcast"),
  z.literal("fog"),
  z.literal("drizzle"),
  z.literal("freezingDrizzle"),
  z.literal("rain"),
  z.literal("freezingRain"),
  z.literal("snow"),
  z.literal("snowGrains"),
  z.literal("rainShowers"),
  z.literal("snowShowers"),
  z.literal("thunderstorm"),
  z.literal("thunderstormHail"),
  z.literal("unknown"),
]);

const schema: ZodType<{
  conditionKey: WeatherConditionKey;
  tempMinC: number;
  tempMaxC: number;
  rainPct: number;
}> = z.object({
  conditionKey: conditionEnum,
  tempMinC: z.number(),
  tempMaxC: z.number(),
  rainPct: z.number(),
});
export type WeatherTextData = z.infer<typeof schema>;

export const weatherTextBlock: BlockDefinition<WeatherTextData> = defineBlock({
  type: "weatherText",
  schema,
  render: ({ data, ctx }) => {
    const body = applyTextStyle(ctx.theme.textStyles.body, ctx.fontRoles);
    const label = applyTextStyle(ctx.theme.textStyles.label, ctx.fontRoles);
    const labels = labelsFromCtx(ctx).weatherText;
    const conditionLabel = labelsFromCtx(ctx).weather.conditions[data.conditionKey];
    return createElement(
      "div",
      { style: { width: "100%", padding: 8, display: "flex", flexDirection: "column", gap: 4 } },
      createElement("div", { style: body }, conditionLabel),
      createElement(
        "div",
        { style: label },
        `${labels.min} ${data.tempMinC}° / ${labels.max} ${data.tempMaxC}°`
      ),
      createElement("div", { style: label }, `${labels.rain} ${data.rainPct}%`)
    );
  },
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
