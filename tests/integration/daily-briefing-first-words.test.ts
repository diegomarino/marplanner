// firstWords: an early-reader block. A phonics-sequenced English word list (CVC words, then
// consonant digraphs, then vowel digraphs, then tricky words), printed as large as the paper
// allows with "sound buttons" under each grapheme — a dot under a single-letter grapheme, a dash
// under a multi-letter one, and no marks at all on tricky words.
import { describe, expect, it } from "vitest";
import { firstWordsCorpus } from "../../src/server/modules/daily-briefing/corpora";
import {
  FIRST_WORDS_DEFAULT_COUNT,
  FIRST_WORDS_MAX_COUNT,
  generateFirstWords,
} from "../../src/server/modules/daily-briefing/blocks/first-words";
import {
  AdapterError,
  adaptBlockData,
} from "../../src/server/modules/daily-briefing/render/adapter";
import {
  FIRST_WORDS_GLYPH_ADVANCE_EM,
  FIRST_WORDS_MAX_FONT_PX,
  layoutFirstWords,
} from "../../src/server/modules/daily-briefing/render/blocks/first-words";
import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/bridge";

const DATE = "2026-09-08";
const LEVELS = ["L1", "L2", "L3", "L4"] as const;
const CONSONANT_DIGRAPHS = new Set([
  "sh",
  "ch",
  "th",
  "ng",
  "ck",
  "ll",
  "ss",
  "ff",
  "zz",
  "qu",
  "wh",
]);
const VOWEL_GRAPHEMES = new Set([
  "ai",
  "ee",
  "igh",
  "oa",
  "oo",
  "ar",
  "or",
  "ur",
  "ow",
  "oi",
  "ear",
  "air",
  "er",
  "ay",
  "ou",
]);

describe("firstWords corpus", () => {
  it("holds roughly 100 unique lowercase words", () => {
    expect(firstWordsCorpus.length).toBeGreaterThanOrEqual(90);
    expect(firstWordsCorpus.length).toBeLessThanOrEqual(130);
    const words = firstWordsCorpus.map((entry) => entry.word);
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(word).toMatch(/^[a-z]+$/);
  });

  it("keeps words short: at least 90% have 5 letters or fewer", () => {
    const short = firstWordsCorpus.filter((entry) => entry.word.length <= 5).length;
    expect(short / firstWordsCorpus.length).toBeGreaterThanOrEqual(0.9);
  });

  it("segments every word into graphemes that spell it exactly", () => {
    for (const entry of firstWordsCorpus) {
      expect(entry.graphemes.join(""), entry.word).toBe(entry.word);
      for (const g of entry.graphemes) expect(g.length, entry.word).toBeGreaterThan(0);
    }
  });

  it("fills all four levels with at least 20 words each", () => {
    for (const level of LEVELS) {
      expect(
        firstWordsCorpus.filter((entry) => entry.level === level).length
      ).toBeGreaterThanOrEqual(20);
    }
    expect(firstWordsCorpus.every((entry) => LEVELS.includes(entry.level))).toBe(true);
  });

  it("L1 words use only single-letter graphemes", () => {
    for (const entry of firstWordsCorpus.filter((e) => e.level === "L1")) {
      expect(
        entry.graphemes.every((g) => g.length === 1),
        entry.word
      ).toBe(true);
    }
  });

  it("L2 words each carry a consonant digraph and no vowel digraph", () => {
    for (const entry of firstWordsCorpus.filter((e) => e.level === "L2")) {
      expect(
        entry.graphemes.some((g) => CONSONANT_DIGRAPHS.has(g)),
        entry.word
      ).toBe(true);
      expect(
        entry.graphemes.some((g) => VOWEL_GRAPHEMES.has(g)),
        entry.word
      ).toBe(false);
    }
  });

  it("L3 words each carry a vowel digraph or trigraph", () => {
    for (const entry of firstWordsCorpus.filter((e) => e.level === "L3")) {
      expect(
        entry.graphemes.some((g) => VOWEL_GRAPHEMES.has(g)),
        entry.word
      ).toBe(true);
    }
  });

  it("marks exactly the L4 words as tricky", () => {
    for (const entry of firstWordsCorpus) {
      expect(entry.tricky, entry.word).toBe(entry.level === "L4");
    }
  });
});

describe("generateFirstWords", () => {
  it("defaults to level L1 and the default count", () => {
    const data = generateFirstWords({ date: DATE, memberId: "m1" });
    expect(data.level).toBe("L1");
    expect(data.words).toHaveLength(FIRST_WORDS_DEFAULT_COUNT);
    const pool = new Set(firstWordsCorpus.filter((e) => e.level === "L1").map((e) => e.word));
    for (const w of data.words) expect(pool.has(w.word)).toBe(true);
  });

  it("is deterministic per date+level and the same for every member", () => {
    const a = generateFirstWords({ date: DATE, memberId: "m1", params: { level: "L3" } });
    const b = generateFirstWords({ date: DATE, memberId: "m2", params: { level: "L3" } });
    expect(a).toEqual(b);
  });

  it("varies across dates", () => {
    const picks = new Set<string>();
    for (let day = 1; day <= 10; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      picks.add(
        generateFirstWords({ date, memberId: "m1" })
          .words.map((w) => w.word)
          .join(",")
      );
    }
    expect(picks.size).toBeGreaterThan(5);
  });

  it("returns `count` distinct words from the chosen level, a larger count extending a smaller one", () => {
    const four = generateFirstWords({
      date: DATE,
      memberId: "m1",
      params: { level: "L2", count: 4 },
    });
    const two = generateFirstWords({
      date: DATE,
      memberId: "m1",
      params: { level: "L2", count: 2 },
    });
    expect(four.words).toHaveLength(4);
    expect(new Set(four.words.map((w) => w.word)).size).toBe(4);
    expect(
      four.words.every((w) => firstWordsCorpus.some((e) => e.word === w.word && e.level === "L2"))
    ).toBe(true);
    expect(two.words).toEqual(four.words.slice(0, 2));
  });

  it("carries graphemes and the tricky flag through to the block data", () => {
    const data = generateFirstWords({
      date: DATE,
      memberId: "m1",
      params: { level: "L4", count: 2 },
    });
    for (const w of data.words) {
      expect(w.tricky).toBe(true);
      expect(w.graphemes.join("")).toBe(w.word);
    }
  });

  it("throws on an invalid level, an out-of-range count, or an unavailable language", () => {
    expect(() =>
      generateFirstWords({ date: DATE, memberId: "m1", params: { level: "L9" } })
    ).toThrow(/level/);
    expect(() => generateFirstWords({ date: DATE, memberId: "m1", params: { count: 0 } })).toThrow(
      /count/
    );
    expect(() =>
      generateFirstWords({
        date: DATE,
        memberId: "m1",
        params: { count: FIRST_WORDS_MAX_COUNT + 1 },
      })
    ).toThrow(/count/);
    expect(() =>
      generateFirstWords({ date: DATE, memberId: "m1", params: { language: "es" } })
    ).toThrow();
  });
});

const SAMPLE = {
  level: "L2",
  words: [
    { word: "ship", graphemes: ["sh", "i", "p"], tricky: false },
    { word: "duck", graphemes: ["d", "u", "ck"], tricky: false },
  ],
};

describe("firstWords render adapter", () => {
  it("passes valid words through", () => {
    expect(adaptBlockData("firstWords", SAMPLE)).toEqual({ words: SAMPLE.words });
  });

  it("rejects graphemes that do not spell the word", () => {
    const bad = { words: [{ word: "ship", graphemes: ["s", "i", "p"], tricky: false }] };
    expect(() => adaptBlockData("firstWords", bad)).toThrow(AdapterError);
  });

  it("rejects a missing tricky flag", () => {
    const bad = { words: [{ word: "cat", graphemes: ["c", "a", "t"] }] };
    expect(() => adaptBlockData("firstWords", bad)).toThrow(AdapterError);
  });
});

describe("layoutFirstWords", () => {
  it("picks the largest font whose longest word still fits the content width", () => {
    const words = [
      { word: "chair", graphemes: ["ch", "air"], tricky: false },
      { word: "cat", graphemes: ["c", "a", "t"], tricky: false },
    ];
    const layout = layoutFirstWords(words, 528);
    const width = (px: number) => px * FIRST_WORDS_GLYPH_ADVANCE_EM * 5;
    expect(width(layout.fontSize)).toBeLessThanOrEqual(528);
    expect(width(layout.fontSize + 1)).toBeGreaterThan(528);
  });

  it("caps the font for very short words", () => {
    const layout = layoutFirstWords([{ word: "go", graphemes: ["g", "o"], tricky: true }], 528);
    expect(layout.fontSize).toBe(FIRST_WORDS_MAX_FONT_PX);
  });

  it("puts a dot under single letters and a dash under digraphs, spanning their cells", () => {
    const layout = layoutFirstWords(
      [{ word: "ship", graphemes: ["sh", "i", "p"], tricky: false }],
      528
    );
    const [marks] = layout.words.map((w) => w.marks);
    expect(marks.map((m) => m.kind)).toEqual(["dash", "dot", "dot"]);
    expect(layout.words[0].cells).toEqual([2, 1, 1]);
    expect(marks[0].width).toBeGreaterThan(marks[1].width);
  });

  it("prints tricky words without marks", () => {
    const layout = layoutFirstWords(
      [{ word: "said", graphemes: ["s", "ai", "d"], tricky: true }],
      528
    );
    expect(layout.words[0].marks).toEqual([]);
  });
});

describe("firstWords through the real render bridge", () => {
  it("renders without failed or unrendered blocks", async () => {
    const rendered = await renderBriefingBitmap({
      memberId: "m1",
      memberName: "Ada",
      date: DATE,
      blocks: [{ type: "firstWords", title: "01 FIRST WORDS", data: SAMPLE }],
    });
    expect(rendered.bitmapPng).not.toBeNull();
    expect(rendered.failedRenderBlocks).toEqual([]);
    expect(rendered.unrenderedBlocks).toEqual([]);
  });
});
