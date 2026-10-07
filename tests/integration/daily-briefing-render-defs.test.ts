// docs/features/daily-briefing.md (coverage-gap task, added at batch E):
// per-type render proof for the 20 pressedslip render-defs added this module (render/blocks/*.ts,
// registered in render/registry.ts) — only "message" shipped with. Every test drives the REAL
// bridge (`renderBriefingBitmap`: adapter -> registry -> theme -> pressedslip `render`), never a
// mock — this IS the render layer under test. Envelope dates are fixed literals (no wall-clock
// read anywhere in the defs under test — streak.ts derives its day labels from `envelope.date`,
// not `Date.now`), so no fake-timer setup is needed for determinism.
import { describe, expect, it, vi } from "vitest";
import type { RenderContext } from "pressedslip";
import { wordSearchBlock as pressedslipWordSearchBlock } from "pressedslip";
import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/bridge";
import { prepareDailyBriefingTheme } from "../../src/server/modules/daily-briefing/render/theme";
import { riddleBlock } from "../../src/server/modules/daily-briefing/render/blocks/riddle";
import { wordSearchBlock } from "../../src/server/modules/daily-briefing/render/blocks/word-search";
import { mealsBlock } from "../../src/server/modules/daily-briefing/render/blocks/meals";
import { onThisDayBlock } from "../../src/server/modules/daily-briefing/render/blocks/on-this-day";
import { birthdayBlock } from "../../src/server/modules/daily-briefing/render/blocks/birthday";
import { weatherTextBlock } from "../../src/server/modules/daily-briefing/render/blocks/weather-text";
import { weatherBlock } from "../../src/server/modules/daily-briefing/render/blocks/weather";
import { streakBlock } from "../../src/server/modules/daily-briefing/render/blocks/streak";
import type {
  RenderBlockInput,
  RenderEnvelope,
} from "../../src/server/modules/daily-briefing/render/types";

const DATE = "2026-09-08"; // frozen fixture date — never Date.now
const MEMBER_ID = "render-defs-member";
const MEMBER_NAME = "Render Defs Member";

/** One valid `data` fixture per block type, matching EXACTLY what render/adapter.ts's
 * corresponding case accepts (the adapter is the contract every def consumes). */
const TYPE_FIXTURES: Record<string, unknown> = {
  message: { text: "Have a wonderful day!" },
  quoteOfDay: {
    text: "The only way to do great work is to love what you do.",
    author: "Steve Jobs",
  },
  dadJoke: { text: "Why did the chicken cross the road? To get to the other side." },
  wordOfDay: {
    word: "Serendipity",
    type: "noun",
    definition: "The occurrence of events by chance in a happy way.",
    example: "Finding this book was pure serendipity.",
    pronunciation: "ˌser.ənˈdɪp.ɪ.ti",
  },
  wouldYouRather: { optionA: "Fly", optionB: "Be invisible" },
  riddle: { question: "What has keys but can't open locks?", answer: "A piano" },
  animalFact: { text: "Octopuses have three hearts.", animal: "Octopus" },
  numberFact: { number: 7, fact: "7 is the number of continents on Earth.", kind: "trivia" },
  trivia: {
    question: "What is the capital of France?",
    options: ["London", "Paris", "Berlin", "Madrid"],
    category: "Geography",
    difficulty: "easy",
  },
  onThisDay: {
    events: ["1969: Moon landing"],
    births: ["1879: Albert Einstein"],
    deaths: ["1616: William Shakespeare"],
  },
  drawingPrompt: { prompt: "Draw your favorite animal", requiresDrawingSpace: true },
  birthday: {
    daysUntilOwn: 3,
    ownLabel: "Your birthday is in 3 days!",
    family: [{ name: "Mom", daysUntil: 10 }],
  },
  today: { bullets: ["Soccer practice at 4pm", "Bring water bottle"] },
  reminders: {
    groups: [
      {
        title: "Morning",
        items: [{ id: "7:00", value: "Wake up" }, { value: "Brush teeth" }],
      },
    ],
  },
  meals: { lunch: "Pizza", snack: "Apple", dinner: "Pasta" },
  streak: { days: 5, label: "5 day streak!", last7: [true, false, true, true, false, true, true] },
  streakText: {
    days: 5,
    label: "5 day streak!",
    last7: [true, false, true, true, false, true, true],
  },
  // matches the REAL generator/adapter shape (`ForecastDay` —
  // `date`/`conditionKey`/`tempMinC`/`tempMaxC`/`rainPct`), not v1's never-produced shape.
  weather: { date: DATE, conditionKey: "rain", tempMinC: 14, tempMaxC: 20, rainPct: 60 },
  weatherText: { date: DATE, conditionKey: "clear", tempMinC: 15, tempMaxC: 25, rainPct: 0 },
  shotgun: { ranking: ["Alice", "Bob", "Carol"] },
  wordSearch: {
    difficulty: "easy",
    cols: 6,
    rows: 6,
    grid: [
      ["C", "A", "T", "X", "Y", "Z"],
      ["D", "O", "G", "X", "Y", "Z"],
      ["X", "X", "X", "X", "X", "X"],
      ["Y", "Y", "Y", "Y", "Y", "Y"],
      ["Z", "Z", "Z", "Z", "Z", "Z"],
      ["W", "W", "W", "W", "W", "W"],
    ],
    words: ["CAT", "DOG"],
  },
};

/** Every type the render registry ships as of (message + the 20 ported this module). */
const ALL_TYPES = Object.keys(TYPE_FIXTURES);

function envelopeFor(types: string[]): RenderEnvelope {
  const blocks: RenderBlockInput[] = types.map((type) => ({
    type,
    title: type.toUpperCase(),
    data: TYPE_FIXTURES[type],
  }));
  return { memberId: MEMBER_ID, memberName: MEMBER_NAME, date: DATE, blocks };
}

/** Minimal real RenderContext for a direct (bridge-bypassing) unit-call on a single def's
 * `.render` — the same shape pressedslip's own `render` injects, built from the REAL prepared
 * theme (render/theme.ts), not a hand-waved stub. `language` (P1 fold) mirrors what
 * `render/bridge.ts#buildComposition` stamps into `composition.meta.language` in production. */
function makeCtx(blockType: string, data: unknown, language?: string): RenderContext {
  const theme = prepareDailyBriefingTheme();
  return {
    block: { type: blockType, id: `${blockType}-0`, data },
    composition: {
      id: `${blockType}-probe`,
      version: 1,
      date: DATE,
      status: "ready",
      slots: [],
      failedBlocks: [],
      providerOutcomes: {},
      timing: { totalMs: 0, fetchPhaseMs: 0, renderPhaseMs: 0 },
      meta: { language },
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

/** Recursively collect every string leaf from a createElement tree (P1 fold's label
 * tests) — the same "inspect the returned React element tree" technique the riddle-rotation test
 * above already established, generalized to text content instead of a style prop. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    collectText((node as { props: { children?: unknown } }).props.children, out);
  }
  return out;
}

/** Measured single-block heights (px) from a real render, at fixed content — message 255,
 * drawingPrompt 565, wordSearch 480, wordOfDay 467 — floored ~10% to absorb font-hinting jitter
 * across environments without weakening the proof into a vacuous "> 0" check. */
const HEIGHT_FLOORS: Record<string, number> = {
  message: 229, // 255 * 0.9
  drawingPrompt: 508, // 565 * 0.9
  wordSearch: 432, // 480 * 0.9
  wordOfDay: 420, // 467 * 0.9
};

describe("daily-briefing render-defs — per-type render through the real bridge", () => {
  it.each(ALL_TYPES)(
    'type "%s" renders: raster produced, absent from unrendered AND failed lists',
    async (type) => {
      const rendered = await renderBriefingBitmap(envelopeFor([type]));
      expect(rendered.bitmapPng).not.toBeNull();
      expect(rendered.bitmapHeight).toBeGreaterThan(0);
      expect(rendered.failedRenderBlocks).toEqual([]);
      expect(rendered.unrenderedBlocks).not.toContain(type);
      expect(rendered.unrenderedBlocks).toEqual([]);
    }
  );

  it("word-search renders its grid: the subclass is registered under the wordSearch type key", async () => {
    const rendered = await renderBriefingBitmap(envelopeFor(["wordSearch"]));
    expect(rendered.bitmapPng).not.toBeNull();
    expect(rendered.bitmapHeight).toBeGreaterThan(0);
    expect(rendered.failedRenderBlocks).toEqual([]);
    expect(rendered.unrenderedBlocks).toEqual([]);
  });

  describe("word-search wrapper (render/blocks/word-search.ts subclasses pressedslip's builtin)", () => {
    it("overrides wordSearchBorderColor AND separatorColor to #000000 on the ctx it forwards to the builtin's render", () => {
      // Without this spy, the wrapper degrading into a no-op passthrough (dropping its own
      // override and just delegating straight to the builtin unchanged) would still render
      // successfully with zero failures — every OTHER test in this file would stay green. Spying
      // on the actual builtin's `.render` (the same object instance render/blocks/word-search.ts
      // imports — ESM module caching guarantees identity) and inspecting the `ctx` it was called
      // with is the direct proof the override still fires.
      const renderSpy = vi.spyOn(pressedslipWordSearchBlock, "render");
      try {
        const { grid, words } = TYPE_FIXTURES.wordSearch as {
          grid: string[][];
          words: string[];
        };
        const baseCtx = makeCtx("wordSearch", { grid, words });
        // Start from a ctx carrying the theme's REAL (non-black) colors, so a passthrough
        // wrapper would forward THOSE unchanged and this assertion would catch it.
        const ctx: RenderContext = {
          ...baseCtx,
          theme: { ...baseCtx.theme, separatorColor: "#b8b0a0", wordSearchBorderColor: "#b8b0a0" },
        };

        wordSearchBlock.render({ data: { grid, words }, ctx });

        expect(renderSpy).toHaveBeenCalledTimes(1);
        const receivedCtx = renderSpy.mock.calls[0][0].ctx;
        expect(receivedCtx.theme.wordSearchBorderColor).toBe("#000000");
        expect(receivedCtx.theme.separatorColor).toBe("#000000");
      } finally {
        renderSpy.mockRestore();
      }
    });
  });

  describe("riddle answer rotation (render/theme.ts's `answer` text style, rotate: 180)", () => {
    it("renders without failure through the real bridge", async () => {
      const rendered = await renderBriefingBitmap(envelopeFor(["riddle"]));
      expect(rendered.bitmapPng).not.toBeNull();
      expect(rendered.failedRenderBlocks).toEqual([]);
      expect(rendered.unrenderedBlocks).toEqual([]);
    });

    it("the def's element tree carries the rotate(180deg) structural marker on the answer line", () => {
      // Direct unit-call on riddleBlock.render (not through the bridge): pressedslip's `render`
      // rasterizes the element tree via satori/resvg, so the rotation is not independently
      // pixel-assertable from the PNG output without a full image-diff harness. Inspecting the
      // returned React element tree — the same structural marker pressedslip's own renderer
      // consumes — is the practical proof `applyTextStyle(ctx.theme.textStyles.answer,...)`
      // actually produced `transform: rotate(180deg)` on the answer div (render/blocks/riddle.ts).
      const ctx = makeCtx("riddle", TYPE_FIXTURES.riddle);
      const element = riddleBlock.render({
        data: TYPE_FIXTURES.riddle as { question: string; answer: string },
        ctx,
      });
      expect(element).not.toBeNull();
      // createElement("div", {...}, questionDiv, answerDiv) — two children, answer is index 1.
      const children = (element as { props: { children: unknown[] } }).props.children;
      expect(Array.isArray(children)).toBe(true);
      const answerDiv = children[1] as { props: { style?: { transform?: string } } };
      expect(answerDiv.props.style?.transform).toBe("rotate(180deg)");
    });
  });

  describe("single-block height floors (measured baseline, ~10% margin for font-hinting jitter)", () => {
    it.each(Object.entries(HEIGHT_FLOORS))(
      'type "%s" renders at least its measured height floor (%dpx)',
      async (type, floor) => {
        const rendered = await renderBriefingBitmap(envelopeFor([type]));
        expect(rendered.bitmapHeight).not.toBeNull();
        expect(rendered.bitmapHeight as number).toBeGreaterThanOrEqual(floor);
      }
    );
  });

  describe("structural labels — household language (DAILY-BRIEFING-INV-06, Codex #709 P1 fold)", () => {
    it("meals renders Lunch/Snack/Dinner in en, Comida/Merienda/Cena in es", () => {
      const data = TYPE_FIXTURES.meals as { lunch: string; snack: string; dinner: string };
      const en = collectText(mealsBlock.render({ data, ctx: makeCtx("meals", data, "en") }));
      expect(en).toContain("Lunch:");
      expect(en).toContain("Snack:");
      expect(en).toContain("Dinner:");
      const es = collectText(mealsBlock.render({ data, ctx: makeCtx("meals", data, "es") }));
      expect(es).toContain("Comida:");
      expect(es).toContain("Merienda:");
      expect(es).toContain("Cena:");
    });

    it("onThisDay renders Events/Births/Deaths in en, Sucesos/Nacimientos/Fallecimientos in es", () => {
      const data = TYPE_FIXTURES.onThisDay as {
        events?: string[];
        births?: string[];
        deaths?: string[];
      };
      const en = collectText(
        onThisDayBlock.render({ data, ctx: makeCtx("onThisDay", data, "en") })
      );
      expect(en).toContain("Events");
      expect(en).toContain("Births");
      expect(en).toContain("Deaths");
      const es = collectText(
        onThisDayBlock.render({ data, ctx: makeCtx("onThisDay", data, "es") })
      );
      expect(es).toContain("Sucesos");
      expect(es).toContain("Nacimientos");
      expect(es).toContain("Fallecimientos");
    });

    it("birthday's empty-payload fallback renders in household language", () => {
      const empty = { family: [] };
      const en = collectText(
        birthdayBlock.render({ data: empty, ctx: makeCtx("birthday", empty, "en") })
      );
      expect(en).toContain("No upcoming birthdays");
      const es = collectText(
        birthdayBlock.render({ data: empty, ctx: makeCtx("birthday", empty, "es") })
      );
      expect(es).toContain("No hay cumpleaños próximos");
    });

    it("weatherText renders Min/Max/Rain in en, Mín/Máx/Lluvia in es", () => {
      const data = TYPE_FIXTURES.weatherText as {
        date: string;
        conditionKey: "clear";
        tempMinC: number;
        tempMaxC: number;
        rainPct: number;
      };
      const en = collectText(
        weatherTextBlock.render({ data, ctx: makeCtx("weatherText", data, "en") })
      ).join(" ");
      expect(en).toContain("Min 15");
      expect(en).toContain("Max 25");
      expect(en).toContain("Rain 0%");
      const es = collectText(
        weatherTextBlock.render({ data, ctx: makeCtx("weatherText", data, "es") })
      ).join(" ");
      expect(es).toContain("Mín 15");
      expect(es).toContain("Máx 25");
      expect(es).toContain("Lluvia 0%");
    });

    it("weather renders the condition label in household language (RAIN / LLUVIA)", () => {
      const data = TYPE_FIXTURES.weather as {
        date: string;
        conditionKey: "rain";
        tempMinC: number;
        tempMaxC: number;
        rainPct: number;
      };
      const en = collectText(weatherBlock.render({ data, ctx: makeCtx("weather", data, "en") }));
      expect(en).toContain("RAIN");
      const es = collectText(weatherBlock.render({ data, ctx: makeCtx("weather", data, "es") }));
      expect(es).toContain("LLUVIA");
      expect(es).not.toContain("RAIN");
    });

    it("streak's day-of-week strip renders in household language (W for Wednesday vs X for miércoles)", () => {
      const data = TYPE_FIXTURES.streak as { days: number; label: string; last7: boolean[] };
      // DATE's 7-day lookback window always spans exactly one Wednesday, so "W" (en) / "X" (es,
      // miércoles) is guaranteed present regardless of which week DATE falls in.
      const en = collectText(streakBlock.render({ data, ctx: makeCtx("streak", data, "en") }));
      expect(en).toContain("W");
      expect(en).not.toContain("X");
      const es = collectText(streakBlock.render({ data, ctx: makeCtx("streak", data, "es") }));
      expect(es).toContain("X");
      expect(es).not.toContain("W");
    });

    it("an es envelope threads through the real bridge into a label-consuming def's ctx.composition.meta.language", async () => {
      // Mirrors the word-search wrapper's spy pattern above: proves the FULL path
      // (RenderEnvelope.language -> bridge.ts#buildComposition -> composition.meta.language ->
      // ctx) actually delivers, not just that `labelsFromCtx` behaves correctly in isolation.
      const renderSpy = vi.spyOn(mealsBlock, "render");
      try {
        const envelope: RenderEnvelope = { ...envelopeFor(["meals"]), language: "es" };
        const rendered = await renderBriefingBitmap(envelope);
        expect(rendered.bitmapPng).not.toBeNull();
        expect(rendered.failedRenderBlocks).toEqual([]);
        expect(renderSpy).toHaveBeenCalledTimes(1);
        const receivedCtx = renderSpy.mock.calls[0][0].ctx;
        const meta = receivedCtx.composition.meta as { language?: string } | undefined;
        expect(meta?.language).toBe("es");
      } finally {
        renderSpy.mockRestore();
      }
    });
  });

  describe("DoD: a full generation across all registered types drains unrendered_blocks to []", () => {
    it("all 21 types in one envelope render with zero unrendered and zero failed, raster at least as tall as its tallest constituent", async () => {
      const full = await renderBriefingBitmap(envelopeFor(ALL_TYPES));
      expect(full.bitmapPng).not.toBeNull();
      expect(full.failedRenderBlocks).toEqual([]);
      expect(full.unrenderedBlocks).toEqual([]);
      expect(full.bitmapHeight).not.toBeNull();
      // Stacking all 21 blocks must be at least as tall as the tallest SINGLE constituent
      // (drawingPrompt's floor, the largest in HEIGHT_FLOORS) — an absolute floor tied to a real
      // ported component actually being included and rendered at real size, replacing a prior
      // near-vacuous "full > one small block" relative comparison that any positive height
      // difference would trivially satisfy.
      const tallestFloor = Math.max(...Object.values(HEIGHT_FLOORS));
      expect(full.bitmapHeight as number).toBeGreaterThanOrEqual(tallestFloor);
    });
  });
});
