import { describe, expect, it } from "vitest";
import type { RenderContext } from "pressedslip";
import type { WeatherConditionKey } from "../../src/shared";
import { WEATHER_ICON_PATHS, type WeatherIconName } from "../../src/shared/weather-icons/paths";
import { weatherBlock } from "../../src/server/modules/daily-briefing/render/blocks/weather";
import { prepareDailyBriefingTheme } from "../../src/server/modules/daily-briefing/render/theme";
import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/index";

/** The printed weather block draws Weather Icons (the set the home weather pill uses): one icon
 * per condition key, always the day variant (a `ForecastDay` is a whole day), filled black for
 * the monochrome thermal print, plus `wi-raindrop` beside the rain probability. */

const DATE = "2026-11-09";

/** Written out by hand, not derived from the shared mapping, so a wrong entry there fails here. */
const EXPECTED_ICONS: Record<WeatherConditionKey, WeatherIconName> = {
  clear: "wi-day-sunny",
  mostlyClear: "wi-day-sunny-overcast",
  partlyCloudy: "wi-day-cloudy",
  overcast: "wi-cloudy",
  fog: "wi-fog",
  drizzle: "wi-sprinkle",
  freezingDrizzle: "wi-rain-mix",
  rain: "wi-rain",
  freezingRain: "wi-sleet",
  snow: "wi-snow",
  snowGrains: "wi-snowflake-cold",
  rainShowers: "wi-day-showers",
  snowShowers: "wi-snow-wind",
  thunderstorm: "wi-thunderstorm",
  thunderstormHail: "wi-hail",
  unknown: "wi-na",
};

const CONDITION_KEYS = Object.keys(EXPECTED_ICONS) as WeatherConditionKey[];

function forecast(conditionKey: WeatherConditionKey, rainPct: number) {
  return { date: DATE, conditionKey, tempMinC: 9, tempMaxC: 17, rainPct };
}

function makeCtx(data: unknown): RenderContext {
  const theme = prepareDailyBriefingTheme();
  return {
    block: { type: "weather", id: "weather-0", data },
    composition: {
      id: "weather-icons-probe",
      version: 1,
      date: DATE,
      status: "ready",
      slots: [],
      failedBlocks: [],
      providerOutcomes: {},
      timing: { totalMs: 0, fetchPhaseMs: 0, renderPhaseMs: 0 },
      meta: { language: "es" },
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    theme: theme.shell,
    fontRoles: theme.fontRoles,
    contentWidth: 528,
    dpi: 203,
  };
}

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

/** Every `<svg>` in the rendered tree, in document order, with the `d` and fill of its paths. */
function svgs(
  node: unknown,
  out: { props: Record<string, unknown>; paths: Node["props"][] }[] = []
) {
  if (Array.isArray(node)) {
    for (const child of node) svgs(child, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const element = node as Required<Node>;
  if (element.type === "svg") {
    const children = [element.props.children].flat() as Node[];
    out.push({
      props: element.props,
      paths: children.filter((child) => child?.type === "path").map((child) => child.props),
    });
    return out;
  }
  svgs(element.props.children, out);
  return out;
}

function iconNameOf(d: unknown): string | undefined {
  return (Object.keys(WEATHER_ICON_PATHS) as WeatherIconName[]).find(
    (name) => WEATHER_ICON_PATHS[name] === d
  );
}

function render(conditionKey: WeatherConditionKey, rainPct: number) {
  const data = forecast(conditionKey, rainPct);
  return svgs(weatherBlock.render({ data, ctx: makeCtx(data) }));
}

describe("daily-briefing weather block — Weather Icons", () => {
  it.each(CONDITION_KEYS)("draws %s with its own day icon, a single black path", (key) => {
    const [condition] = render(key, 0);
    expect(condition).toBeDefined();
    expect(condition!.props).toMatchObject({ width: 72, height: 72 });
    // The 30×30 box is kept (no scaling), only shifted vertically to centre the glyph.
    expect(condition!.props.viewBox).toMatch(/^0 -?[\d.]+ 30 30$/);
    expect(condition!.paths).toHaveLength(1);
    expect(iconNameOf(condition!.paths[0]!.d)).toBe(EXPECTED_ICONS[key]);
    expect(condition!.paths[0]!.fill).toBe("black");
  });

  it("gives thunderstorm, fog, hail and partly cloudy their own icons, unknown reads n/a", () => {
    const names = (
      ["thunderstorm", "fog", "thunderstormHail", "partlyCloudy", "unknown"] as const
    ).map((key) => iconNameOf(render(key, 0)[0]!.paths[0]!.d));
    expect(names).toEqual(["wi-thunderstorm", "wi-fog", "wi-hail", "wi-day-cloudy", "wi-na"]);
  });

  it("draws wi-raindrop beside a rain probability and drops the rain column at 0%", () => {
    const rainy = render("rain", 60);
    expect(rainy.map((svg) => iconNameOf(svg.paths[0]!.d))).toEqual(["wi-rain", "wi-raindrop"]);
    expect(rainy[1]!.paths[0]!.fill).toBe("black");

    const dry = render("rain", 0);
    expect(dry.map((svg) => iconNameOf(svg.paths[0]!.d))).toEqual(["wi-rain"]);
  });

  it("renders every condition through the real pipeline without failures", async () => {
    for (const key of CONDITION_KEYS) {
      const result = await renderBriefingBitmap({
        memberId: "member-1",
        memberName: "Lucía",
        date: DATE,
        language: "es",
        blocks: [{ type: "weather", title: "01 TIEMPO", data: forecast(key, 40) }],
      });
      expect(result.failedRenderBlocks, key).toEqual([]);
      expect(result.unrenderedBlocks, key).toEqual([]);
      expect(result.bitmapPng, key).not.toBeNull();
    }
  });
});
