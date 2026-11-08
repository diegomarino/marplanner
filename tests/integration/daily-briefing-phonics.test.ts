// phonics: an early-reader block. A phonics-sequenced English word list (CVC words, then
// consonant digraphs, then vowel digraphs, then tricky words), printed as large as the paper
// allows with "sound buttons" under each grapheme — a dot under a single-letter grapheme, a dash
// under a multi-letter one, and no marks at all on tricky words.
import { describe, expect, it } from "vitest";
import { phonicsCorpus } from "../../src/server/modules/daily-briefing/corpora";
import {
  PHONICS_DEFAULT_COUNT,
  PHONICS_MAX_COUNT,
  generatePhonics,
} from "../../src/server/modules/daily-briefing/blocks/phonics";
import {
  AdapterError,
  adaptBlockData,
} from "../../src/server/modules/daily-briefing/render/adapter";
import {
  PHONICS_GLYPH_ADVANCE_EM,
  PHONICS_MAX_FONT_PX,
  layoutPhonics,
} from "../../src/server/modules/daily-briefing/render/blocks/phonics";
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

describe("phonics corpus", () => {
  it("holds 300-400 unique lowercase words", () => {
    expect(phonicsCorpus.length).toBeGreaterThanOrEqual(300);
    expect(phonicsCorpus.length).toBeLessThanOrEqual(400);
    const words = phonicsCorpus.map((entry) => entry.word);
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(word).toMatch(/^[a-z]+$/);
  });

  it("keeps words short: at least 90% have 5 letters or fewer", () => {
    const short = phonicsCorpus.filter((entry) => entry.word.length <= 5).length;
    expect(short / phonicsCorpus.length).toBeGreaterThanOrEqual(0.9);
  });

  it("segments every word into graphemes that spell it exactly", () => {
    for (const entry of phonicsCorpus) {
      expect(entry.graphemes.join(""), entry.word).toBe(entry.word);
      for (const g of entry.graphemes) expect(g.length, entry.word).toBeGreaterThan(0);
    }
  });

  it("fills L1-L3 with at least 75 words each and L4 with at least 40 tricky words", () => {
    for (const level of LEVELS) {
      expect(phonicsCorpus.filter((entry) => entry.level === level).length).toBeGreaterThanOrEqual(
        level === "L4" ? 40 : 75
      );
    }
    expect(phonicsCorpus.every((entry) => LEVELS.includes(entry.level))).toBe(true);
  });

  it("L1 words use only single-letter graphemes", () => {
    for (const entry of phonicsCorpus.filter((e) => e.level === "L1")) {
      expect(
        entry.graphemes.every((g) => g.length === 1),
        entry.word
      ).toBe(true);
    }
  });

  it("L2 words each carry a consonant digraph and no vowel digraph", () => {
    for (const entry of phonicsCorpus.filter((e) => e.level === "L2")) {
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
    for (const entry of phonicsCorpus.filter((e) => e.level === "L3")) {
      expect(
        entry.graphemes.some((g) => VOWEL_GRAPHEMES.has(g)),
        entry.word
      ).toBe(true);
    }
  });

  it("uses only known graphemes in decodable words: single letters, consonant digraphs, vowel graphemes", () => {
    for (const entry of phonicsCorpus.filter((e) => !e.tricky)) {
      for (const g of entry.graphemes) {
        const known = g.length === 1 || CONSONANT_DIGRAPHS.has(g) || VOWEL_GRAPHEMES.has(g);
        expect(known, `${entry.word}: "${g}"`).toBe(true);
      }
    }
  });

  it("keeps split digraphs (cake, bike, home) out of the decodable levels", () => {
    // A final lone "e" after consonant + single vowel would get a dot of its own, which is wrong
    // for a split digraph (a_e, i_e, o_e, u_e): those words are not taught until later.
    const vowels = new Set(["a", "e", "i", "o", "u"]);
    for (const entry of phonicsCorpus.filter((e) => !e.tricky)) {
      const g = entry.graphemes;
      const n = g.length;
      const split = n >= 3 && g[n - 1] === "e" && !vowels.has(g[n - 2]) && vowels.has(g[n - 3]);
      expect(split, entry.word).toBe(false);
    }
  });

  it("marks exactly the L4 words as tricky", () => {
    for (const entry of phonicsCorpus) {
      expect(entry.tricky, entry.word).toBe(entry.level === "L4");
    }
  });
});

describe("generatePhonics", () => {
  it("defaults to level L1 and the default count", () => {
    const data = generatePhonics({ date: DATE, memberId: "m1" });
    expect(data.level).toBe("L1");
    expect(data.words).toHaveLength(PHONICS_DEFAULT_COUNT);
    const pool = new Set(phonicsCorpus.filter((e) => e.level === "L1").map((e) => e.word));
    for (const w of data.words) expect(pool.has(w.word)).toBe(true);
  });

  it("is deterministic per date+level and the same for every member", () => {
    const a = generatePhonics({ date: DATE, memberId: "m1", params: { level: "L3" } });
    const b = generatePhonics({ date: DATE, memberId: "m2", params: { level: "L3" } });
    expect(a).toEqual(b);
  });

  it("varies across dates", () => {
    const picks = new Set<string>();
    for (let day = 1; day <= 10; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      picks.add(
        generatePhonics({ date, memberId: "m1" })
          .words.map((w) => w.word)
          .join(",")
      );
    }
    expect(picks.size).toBeGreaterThan(5);
  });

  it("returns `count` distinct words from the chosen level", () => {
    const four = generatePhonics({
      date: DATE,
      memberId: "m1",
      params: { level: "L2", count: 4 },
    });
    expect(four.words).toHaveLength(4);
    expect(new Set(four.words.map((w) => w.word)).size).toBe(4);
    expect(
      four.words.every((w) => phonicsCorpus.some((e) => e.word === w.word && e.level === "L2"))
    ).toBe(true);
  });

  it("walks the whole level before repeating a word", () => {
    // Day d takes positions d*count .. d*count+count-1 of a sequence made of one shuffle of the
    // level after another. Start on a day aligned with a pass boundary and read one full pass.
    const count = 3;
    const pool = phonicsCorpus.filter((e) => e.level === "L1").length;
    const dayMs = 86_400_000;
    const firstDay = Math.ceil((20 * pool) / count); // the 21st pass starts on or before this day
    const lastDay = Math.floor((21 * pool) / count) - 1; // last day fully inside that pass
    const seen: string[] = [];
    for (let day = firstDay; day <= lastDay; day += 1) {
      const date = new Date(day * dayMs).toISOString().slice(0, 10);
      const data = generatePhonics({ date, memberId: "m1", params: { level: "L1", count } });
      seen.push(...data.words.map((w) => w.word));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(pool - 2 * count);
  });

  it("carries graphemes and the tricky flag through to the block data", () => {
    const data = generatePhonics({
      date: DATE,
      memberId: "m1",
      params: { level: "L4", count: 2 },
    });
    for (const w of data.words) {
      expect(w.tricky).toBe(true);
      expect(w.graphemes.join("")).toBe(w.word);
    }
  });

  it("handles dates before 1970 (negative day numbers)", () => {
    for (const date of ["1969-12-31", "1950-06-15"]) {
      const data = generatePhonics({ date, memberId: "m1", params: { level: "L2", count: 4 } });
      expect(data.words).toHaveLength(4);
      for (const w of data.words) expect(w.graphemes.join("")).toBe(w.word);
    }
  });

  it("throws on a date that is not YYYY-MM-DD", () => {
    expect(() => generatePhonics({ date: "not-a-date", memberId: "m1" })).toThrow(/date/);
  });

  it("throws on an invalid level, an out-of-range count, or an unavailable language", () => {
    expect(() => generatePhonics({ date: DATE, memberId: "m1", params: { level: "L9" } })).toThrow(
      /level/
    );
    expect(() => generatePhonics({ date: DATE, memberId: "m1", params: { count: 0 } })).toThrow(
      /count/
    );
    expect(() =>
      generatePhonics({
        date: DATE,
        memberId: "m1",
        params: { count: PHONICS_MAX_COUNT + 1 },
      })
    ).toThrow(/count/);
    expect(() =>
      generatePhonics({ date: DATE, memberId: "m1", params: { language: "es" } })
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

describe("phonics render adapter", () => {
  it("passes valid words through", () => {
    expect(adaptBlockData("phonics", SAMPLE)).toEqual({ words: SAMPLE.words });
  });

  it("rejects graphemes that do not spell the word", () => {
    const bad = { words: [{ word: "ship", graphemes: ["s", "i", "p"], tricky: false }] };
    expect(() => adaptBlockData("phonics", bad)).toThrow(AdapterError);
  });

  it("rejects a missing tricky flag", () => {
    const bad = { words: [{ word: "cat", graphemes: ["c", "a", "t"] }] };
    expect(() => adaptBlockData("phonics", bad)).toThrow(AdapterError);
  });
});

describe("layoutPhonics", () => {
  it("picks the largest font whose longest word still fits the content width", () => {
    const words = [
      { word: "chair", graphemes: ["ch", "air"], tricky: false },
      { word: "cat", graphemes: ["c", "a", "t"], tricky: false },
    ];
    const layout = layoutPhonics(words, 528);
    const width = (px: number) => px * PHONICS_GLYPH_ADVANCE_EM * 5;
    expect(width(layout.fontSize)).toBeLessThanOrEqual(528);
    expect(width(layout.fontSize + 1)).toBeGreaterThan(528);
  });

  it("caps the font for very short words", () => {
    const layout = layoutPhonics([{ word: "go", graphemes: ["g", "o"], tricky: true }], 528);
    expect(layout.fontSize).toBe(PHONICS_MAX_FONT_PX);
  });

  it("puts a dot under single letters and a dash under digraphs, spanning their cells", () => {
    const layout = layoutPhonics(
      [{ word: "ship", graphemes: ["sh", "i", "p"], tricky: false }],
      528
    );
    const [marks] = layout.words.map((w) => w.marks);
    expect(marks.map((m) => m.kind)).toEqual(["dash", "dot", "dot"]);
    expect(layout.words[0].cells).toEqual([2, 1, 1]);
    expect(marks[0].width).toBeGreaterThan(marks[1].width);
  });

  it("prints tricky words without marks", () => {
    const layout = layoutPhonics(
      [{ word: "said", graphemes: ["s", "ai", "d"], tricky: true }],
      528
    );
    expect(layout.words[0].marks).toEqual([]);
  });
});

describe("phonics through the real render bridge", () => {
  it("renders without failed or unrendered blocks", async () => {
    const rendered = await renderBriefingBitmap({
      memberId: "m1",
      memberName: "Ada",
      date: DATE,
      blocks: [{ type: "phonics", title: "01 PHONICS", data: SAMPLE }],
    });
    expect(rendered.bitmapPng).not.toBeNull();
    expect(rendered.failedRenderBlocks).toEqual([]);
    expect(rendered.unrenderedBlocks).toEqual([]);
  });
});
