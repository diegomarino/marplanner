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
// never-produced v1 fields.
import { createElement, type ReactElement } from "react";
import { defineBlock, type BlockDefinition } from "pressedslip";
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
export type WeatherData = z.infer<typeof schema>;

/** Icon bucketing for the 16-key `WeatherConditionKey` union onto the 4 hand-drawn icon families
 * v1 shipped (sun / rain cloud / snow cloud / plain cloud) — thunderstorm variants join the rain
 * bucket (no dedicated storm icon exists), everything else with no precipitation joins the plain
 * cloud bucket. */
function weatherIcon(conditionKey: WeatherConditionKey): ReactElement {
  if (conditionKey === "clear") {
    return createElement(
      "svg",
      { width: 72, height: 72, viewBox: "0 0 72 72", role: "img", "aria-label": "Clear" },
      createElement("circle", { cx: 36, cy: 36, r: 14, fill: "black" }),
      createElement(
        "g",
        { stroke: "black", strokeWidth: 5, strokeLinecap: "round" },
        createElement("line", { x1: 36, y1: 4, x2: 36, y2: 16 }),
        createElement("line", { x1: 36, y1: 56, x2: 36, y2: 68 }),
        createElement("line", { x1: 4, y1: 36, x2: 16, y2: 36 }),
        createElement("line", { x1: 56, y1: 36, x2: 68, y2: 36 }),
        createElement("line", { x1: 13, y1: 13, x2: 21, y2: 21 }),
        createElement("line", { x1: 51, y1: 51, x2: 59, y2: 59 }),
        createElement("line", { x1: 13, y1: 59, x2: 21, y2: 51 }),
        createElement("line", { x1: 51, y1: 21, x2: 59, y2: 13 })
      )
    );
  }

  if (
    conditionKey === "drizzle" ||
    conditionKey === "freezingDrizzle" ||
    conditionKey === "rain" ||
    conditionKey === "freezingRain" ||
    conditionKey === "rainShowers" ||
    conditionKey === "thunderstorm" ||
    conditionKey === "thunderstormHail"
  ) {
    return createElement(
      "svg",
      { width: 72, height: 72, viewBox: "0 0 72 72", role: "img", "aria-label": conditionKey },
      createElement("path", {
        d: "M20 40h32c7 0 12-5 12-12s-5-12-12-12c-3-8-10-12-18-12-11 0-20 8-21 19C6 25 2 30 2 36c0 7 6 12 18 12z",
        fill: "black",
      }),
      createElement(
        "g",
        { stroke: "black", strokeWidth: 5, strokeLinecap: "round" },
        createElement("line", { x1: 24, y1: 52, x2: 18, y2: 66 }),
        createElement("line", { x1: 40, y1: 52, x2: 34, y2: 66 }),
        createElement("line", { x1: 56, y1: 52, x2: 50, y2: 66 })
      )
    );
  }

  if (conditionKey === "snow" || conditionKey === "snowGrains" || conditionKey === "snowShowers") {
    return createElement(
      "svg",
      { width: 72, height: 72, viewBox: "0 0 72 72", role: "img", "aria-label": "Snowy" },
      createElement("path", {
        d: "M20 38h32c7 0 12-5 12-12s-5-12-12-12c-3-8-10-12-18-12-11 0-20 8-21 19C6 23 2 28 2 34c0 7 6 12 18 12z",
        fill: "black",
      }),
      createElement(
        "g",
        { fill: "black" },
        createElement("circle", { cx: 22, cy: 58, r: 4 }),
        createElement("circle", { cx: 38, cy: 58, r: 4 }),
        createElement("circle", { cx: 54, cy: 58, r: 4 })
      )
    );
  }

  return createElement(
    "svg",
    { width: 72, height: 72, viewBox: "0 0 72 72", role: "img", "aria-label": conditionKey },
    createElement("path", {
      d: "M20 46h32c7 0 12-5 12-12s-5-12-12-12c-3-8-10-12-18-12-11 0-20 8-21 19C6 31 2 36 2 42c0 7 6 12 18 12z",
      fill: "black",
    })
  );
}

function raindropIcon(): ReactElement {
  return createElement(
    "svg",
    { width: 32, height: 36, viewBox: "0 0 20 24", role: "img", "aria-label": "Rain probability" },
    createElement("path", {
      d: "M 10 2 Q 4 12 4 16 Q 4 22 10 22 Q 16 22 16 16 Q 16 12 10 2 Z",
      fill: "black",
    })
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
        weatherIcon(data.conditionKey)
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
            raindropIcon(),
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
