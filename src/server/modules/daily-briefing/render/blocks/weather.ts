// PORTED from v1 `apps/api/src/blocks/weather.tsx` — createElement form
// (tsconfig has no jsx; see message.ts for the general porting note). The
// condition labels ("CLEAR", "PARTLY CLOUDY",...) render in the household
// language via `../labels.ts` (DAILY-BRIEFING-INV-06, P1 fold).
//
// this def originally consumed v1's `WeatherData` shape
// (`condition`/`tempMin`/`tempMax`/`rainProbability`/`hourly`), which the REAL generator
// (`../../blocks/weather.ts#generateWeatherBlock`) never emits — it produces a `ForecastDay`
// (`src/shared/weather.ts`: `conditionKey`/`tempMinC`/`tempMaxC`/`rainPct`, no `hourly`, no
// "current" reading). `render/adapter.ts`'s "weather"/"weatherText" case now passes that real
// shape through unchanged, so this def is rewritten to consume it directly instead of the
// never-produced v1 fields. The icons are Weather Icons from `src/shared/weather-icons/`, one per
// condition key, the same glyphs the home weather pill and the on-screen briefing draw.
import { createElement, type ReactElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
import { type ZodType, z } from "zod";
import { labelsFromCtx } from "../labels";
import type { WeatherConditionKey } from "../../../../../shared";
import { weatherConditionIconName } from "../../../../../shared/weather-icons/conditionIcons";
import {
  WEATHER_ICON_PATHS,
  type WeatherIconName,
} from "../../../../../shared/weather-icons/paths";

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
export type WeatherData = z.infer<typeof schema>;

/** Vertical centre of each printed glyph inside its 30×30 box, measured from the path's bounding
 * box (horizontally they are all centred at 15). Weather Icons sit the rain, snow and storm clouds
 * low and the sun-and-cloud icons high, up to 3.6 units (~9px at 72px) off centre, which shows
 * next to the text column; the view box shifts by the difference so every icon sits centred. */
const CENTER_Y: Partial<Record<WeatherIconName, number>> = {
  "wi-day-sunny-overcast": 12.19,
  "wi-day-cloudy": 11.38,
  "wi-fog": 16.19,
  "wi-sprinkle": 15.78,
  "wi-rain-mix": 17.7,
  "wi-rain": 17.47,
  "wi-sleet": 17.73,
  "wi-snow": 17.44,
  "wi-snowflake-cold": 14.39,
  "wi-day-showers": 14.29,
  "wi-snow-wind": 17.44,
  "wi-thunderstorm": 17.64,
  "wi-hail": 17.57,
};

/** A Weather Icons glyph (`src/shared/weather-icons/`, the set the home weather pill draws): one
 * path on a 30×30 view box, re-centred vertically, filled black for the monochrome thermal print. */
function weatherGlyph(name: WeatherIconName, size: number, label: string): ReactElement {
  const top = (CENTER_Y[name] ?? 15) - 15;
  return createElement(
    "svg",
    { width: size, height: size, viewBox: `0 ${top} 30 30`, role: "img", "aria-label": label },
    createElement("path", { d: WEATHER_ICON_PATHS[name], fill: "black" })
  );
}

/** `wi-raindrop` fills only 10×13 of its 30×30 box; an 18-unit box around it keeps the drop the
 * size the v1 hand-drawn one printed at, in the same 36px slot. */
function raindropGlyph(): ReactElement {
  return createElement(
    "svg",
    {
      width: 36,
      height: 36,
      viewBox: "6 4.7 18 18",
      role: "img",
      "aria-label": "Rain probability",
    },
    createElement("path", { d: WEATHER_ICON_PATHS["wi-raindrop"], fill: "black" })
  );
}

export const weatherBlock: BlockDefinition<WeatherData> = defineBlock({
  type: "weather",
  schema,
  render: ({ data, ctx }) =>
    createElement(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          width: "100%",
          gap: 16,
        },
      },
      createElement(
        "div",
        { style: { display: "flex", width: 72, height: 72 } },
        // A `ForecastDay` covers a whole day and carries no `isDay`: always the day icon.
        weatherGlyph(
          weatherConditionIconName(data.conditionKey),
          72,
          labelsFromCtx(ctx).weather.conditions[data.conditionKey]
        )
      ),
      createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", flexGrow: 1 } },
        createElement(
          "div",
          { style: { display: "flex", fontSize: 22, fontWeight: 500, color: "black" } },
          labelsFromCtx(ctx).weather.conditions[data.conditionKey]
        ),
        createElement(
          "div",
          { style: { display: "flex", fontSize: 28, fontWeight: 700, color: "black" } },
          `${data.tempMinC}° — ${data.tempMaxC}°`
        )
      ),
      data.rainPct > 0
        ? createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                width: 100,
                flexShrink: 0,
                gap: 4,
              },
            },
            raindropGlyph(),
            createElement(
              "div",
              { style: { display: "flex", fontSize: 22, fontWeight: 700, color: "black" } },
              `${data.rainPct}%`
            )
          )
        : createElement("div", { style: { display: "flex", width: 100, flexShrink: 0 } })
    ),
  shell: { showTitle: true, separator: "thin", padding: "normal" },
});
