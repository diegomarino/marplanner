import { describe, expect, it } from "vitest";
import {
  animalFactsCorpus,
  drawingPromptsCorpus,
  numberFactsCorpus,
  riddlesCorpus,
  wouldYouRathersCorpus,
} from "../../src/server/modules/daily-briefing/corpora/index";
import { CorpusBlockParamError } from "../../src/server/modules/daily-briefing/blocks/context";
import { generateDadJoke } from "../../src/server/modules/daily-briefing/blocks/dad-joke";
import { generateWordOfDay } from "../../src/server/modules/daily-briefing/blocks/word-of-day";
import { generateAnimalFact } from "../../src/server/modules/daily-briefing/blocks/animal-fact";
import {
  dayOfYear,
  generateNumberFact,
} from "../../src/server/modules/daily-briefing/blocks/number-fact";
import { generateTrivia } from "../../src/server/modules/daily-briefing/blocks/trivia";
import { generateRiddle } from "../../src/server/modules/daily-briefing/blocks/riddle";
import { generateWouldYouRather } from "../../src/server/modules/daily-briefing/blocks/would-you-rather";
import { generateWordSearch } from "../../src/server/modules/daily-briefing/blocks/word-search";
import { generateDrawingPrompt } from "../../src/server/modules/daily-briefing/blocks/drawing-prompt";
import { adaptBlockData } from "../../src/server/modules/daily-briefing/render/adapter";

/** docs/features/daily-briefing.md (trap-sweep row): the 9
 * corpus-backed block generators — per-block determinism, v1's exact seed recipes, the
 * trivia/riddle answer-exposure contrast, EN/ES language resolution (FR-009/INV-06), the
 * numberFact dayOfYear keying, and the wordSearch FR-020 serial-loop confinement fence.
 * v1 seed-recipe verification table (v1 study, cross-checked against
 * `<marplanner-v1>/apps/api/src/lib/daily-briefing/blocks/*.ts` at dispatch time):
 * | block | v1 seed recipe | member-scoped? |
 * | --------------- | -------------------------------------------------------- | -------------- |
 * | dadJoke | `${date}\|joke` | no |
 * | wordOfDay | `${date}\|wordOfDay\|${level}` | no |
 * | animalFact | `${date}\|animalFact` | no |
 * | numberFact | keyed by `dayOfYear(date)`, NOT a hash | no |
 * | trivia | `${date}\|trivia\|${memberId}` | yes |
 * | riddle | `${date}\|riddle` | no |
 * | wouldYouRather | `${date}\|wouldYouRather\|${memberId}` | yes |
 * | wordSearch | selection: `${date}\|${memberId}\|wordSearch\|${difficulty}`, placement: same + `\|placement` | yes |
 * | drawingPrompt | `${date}\|drawingPrompt` | no |
 * No deviation found between this port and the v1 recipes above.
 */
const DATE = "2026-09-08";

describe("daily-briefing corpus block generators", () => {
  describe("per-block determinism (same date/member/params -> identical output twice)", () => {
    it("dadJoke", () => {
      const a = generateDadJoke({ date: DATE, memberId: "m1" });
      const b = generateDadJoke({ date: DATE, memberId: "m1" });
      expect(a).toEqual(b);
    });

    it("wordOfDay", () => {
      const a = generateWordOfDay({ date: DATE, memberId: "m1", params: { level: "L3" } });
      const b = generateWordOfDay({ date: DATE, memberId: "m1", params: { level: "L3" } });
      expect(a).toEqual(b);
    });

    it("animalFact", () => {
      const a = generateAnimalFact({ date: DATE, memberId: "m1" });
      const b = generateAnimalFact({ date: DATE, memberId: "m1" });
      expect(a).toEqual(b);
    });

    it("numberFact", () => {
      const a = generateNumberFact({ date: DATE, memberId: "m1" });
      const b = generateNumberFact({ date: DATE, memberId: "m1" });
      expect(a).toEqual(b);
    });

    it("trivia", () => {
      const a = generateTrivia({ date: DATE, memberId: "m1", params: { difficulty: "medium" } });
      const b = generateTrivia({ date: DATE, memberId: "m1", params: { difficulty: "medium" } });
      expect(a).toEqual(b);
    });

    it("riddle", () => {
      const a = generateRiddle({ date: DATE, memberId: "m1" });
      const b = generateRiddle({ date: DATE, memberId: "m1" });
      expect(a).toEqual(b);
    });

    it("wouldYouRather", () => {
      const a = generateWouldYouRather({ date: DATE, memberId: "m1" });
      const b = generateWouldYouRather({ date: DATE, memberId: "m1" });
      expect(a).toEqual(b);
    });

    it("wordSearch", () => {
      const a = generateWordSearch({
        date: DATE,
        memberId: "m1",
        params: { difficulty: "medium" },
      });
      const b = generateWordSearch({
        date: DATE,
        memberId: "m1",
        params: { difficulty: "medium" },
      });
      expect(a).toEqual(b);
    });

    it("drawingPrompt", () => {
      const a = generateDrawingPrompt({ date: DATE, memberId: "m1" });
      const b = generateDrawingPrompt({ date: DATE, memberId: "m1" });
      expect(a).toEqual(b);
    });
  });

  describe("cross-member difference where the seed includes memberId", () => {
    it("trivia differs across members on the same date", () => {
      const m1 = generateTrivia({ date: DATE, memberId: "m1" });
      const m2 = generateTrivia({ date: DATE, memberId: "m2" });
      expect(m1).not.toEqual(m2);
    });

    it("wouldYouRather differs across members on the same date", () => {
      const m1 = generateWouldYouRather({ date: DATE, memberId: "m1" });
      const m2 = generateWouldYouRather({ date: DATE, memberId: "m2" });
      expect(m1).not.toEqual(m2);
    });

    it("wordSearch differs across members on the same date (both seeds carry memberId)", () => {
      const m1 = generateWordSearch({ date: DATE, memberId: "m1" });
      const m2 = generateWordSearch({ date: DATE, memberId: "m2" });
      expect(m1.words).not.toEqual(m2.words);
    });
  });

  describe("cross-member sameness where the seed does NOT include memberId", () => {
    it("dadJoke is identical across members on the same date", () => {
      const m1 = generateDadJoke({ date: DATE, memberId: "m1" });
      const m2 = generateDadJoke({ date: DATE, memberId: "m2" });
      expect(m1).toEqual(m2);
    });

    it("riddle is identical across members on the same date", () => {
      const m1 = generateRiddle({ date: DATE, memberId: "m1" });
      const m2 = generateRiddle({ date: DATE, memberId: "m2" });
      expect(m1).toEqual(m2);
    });

    it("animalFact, numberFact, drawingPrompt, and wordOfDay are also member-independent (v1 parity)", () => {
      expect(generateAnimalFact({ date: DATE, memberId: "m1" })).toEqual(
        generateAnimalFact({ date: DATE, memberId: "m2" })
      );
      expect(generateNumberFact({ date: DATE, memberId: "m1" })).toEqual(
        generateNumberFact({ date: DATE, memberId: "m2" })
      );
      expect(generateDrawingPrompt({ date: DATE, memberId: "m1" })).toEqual(
        generateDrawingPrompt({ date: DATE, memberId: "m2" })
      );
      expect(generateWordOfDay({ date: DATE, memberId: "m1" })).toEqual(
        generateWordOfDay({ date: DATE, memberId: "m2" })
      );
    });
  });

  describe("trivia: the correct answer is NEVER in the payload (v1 parity, deliberate)", () => {
    it("the returned object has no correctAnswer/answer key", () => {
      const result = generateTrivia({ date: DATE, memberId: "m1" });
      expect(Object.keys(result).sort()).toEqual(["category", "difficulty", "options", "question"]);
      expect(result).not.toHaveProperty("correctAnswer");
      expect(result).not.toHaveProperty("answer");
    });
  });

  describe("riddle: the answer IS in the payload (v1 parity, contrast with trivia)", () => {
    it("the returned object carries the answer", () => {
      const result = generateRiddle({ date: DATE, memberId: "m1" });
      expect(result).toHaveProperty("answer");
      expect(typeof result.answer).toBe("string");
      expect(result.answer.length).toBeGreaterThan(0);
    });
  });

  describe("wordSearch serial-confinement (FR-020 fence)", () => {
    it("running another block between two wordSearch generations leaves both outputs unchanged", () => {
      const ctx = { date: DATE, memberId: "m1", params: { difficulty: "hard" as const } };
      const first = generateWordSearch(ctx);

      // A non-confined generator runs in between — it must not observe or perturb the restored
      // global Math.random left behind by the FIRST wordSearch call's withSeededMathRandom patch.
      generateDadJoke({ date: DATE, memberId: "m1" });
      generateTrivia({ date: DATE, memberId: "m1" });

      const second = generateWordSearch(ctx);
      expect(second).toEqual(first);
    });

    it("Math.random is restored to the original after a wordSearch generation", () => {
      const original = Math.random;
      generateWordSearch({ date: DATE, memberId: "m1" });
      expect(Math.random).toBe(original);
    });

    it("produces a grid of the profile's exact dimensions, fully filled with single letters", () => {
      const result = generateWordSearch({
        date: DATE,
        memberId: "m1",
        params: { difficulty: "medium" },
      });
      expect(result.rows).toBe(10);
      expect(result.cols).toBe(10);
      expect(result.grid).toHaveLength(10);
      for (const row of result.grid) {
        expect(row).toHaveLength(10);
        for (const cell of row) {
          expect(cell).toMatch(/^[A-Z]$/);
        }
      }
      expect(result.words.length).toBeLessThanOrEqual(12); // profile.maxWords
    });
  });

  describe("es-variant resolution for the 4 translated corpora (FR-009/INV-06)", () => {
    it("animalFact: es resolves the SAME index as en, in the es corpus", () => {
      const en = generateAnimalFact({ date: DATE, memberId: "m1" });
      const es = generateAnimalFact({ date: DATE, memberId: "m1", params: { language: "es" } });
      const idx = animalFactsCorpus.en.findIndex((entry) => entry.text === en.text);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(es).toEqual({
        text: animalFactsCorpus.es[idx].text,
        animal: animalFactsCorpus.es[idx].animal,
      });
    });

    it("numberFact: es resolves the same day-of-year entry, in the es corpus", () => {
      const en = generateNumberFact({ date: DATE, memberId: "m1" });
      const es = generateNumberFact({ date: DATE, memberId: "m1", params: { language: "es" } });
      const n = dayOfYear(DATE);
      const esEntry = numberFactsCorpus.es.find((row) => row.number === n);
      expect(en.number).toBe(n);
      expect(es).toEqual({ number: esEntry!.number, fact: esEntry!.fact, kind: esEntry!.kind });
    });

    it("wouldYouRather: es resolves the SAME index as en, in the es corpus", () => {
      const en = generateWouldYouRather({ date: DATE, memberId: "m1" });
      const es = generateWouldYouRather({ date: DATE, memberId: "m1", params: { language: "es" } });
      const idx = wouldYouRathersCorpus.en.findIndex((entry) => entry.optionA === en.optionA);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(es).toEqual({
        optionA: wouldYouRathersCorpus.es[idx].optionA,
        optionB: wouldYouRathersCorpus.es[idx].optionB,
      });
    });

    it("drawingPrompt: es resolves the SAME index as en, in the es corpus", () => {
      const en = generateDrawingPrompt({ date: DATE, memberId: "m1" });
      const es = generateDrawingPrompt({ date: DATE, memberId: "m1", params: { language: "es" } });
      const idx = drawingPromptsCorpus.en.findIndex((entry) => entry.text === en.prompt);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(es.prompt).toBe(drawingPromptsCorpus.es[idx].text);
    });

    it("defaulting (no language param) always resolves the en variant", () => {
      const defaulted = generateAnimalFact({ date: DATE, memberId: "m1" });
      const explicitEn = generateAnimalFact({
        date: DATE,
        memberId: "m1",
        params: { language: "en" },
      });
      expect(defaulted).toEqual(explicitEn);
    });
  });

  describe("assert-throw on a language without a corpus (no English-fallback degradation)", () => {
    it.each([
      [
        "dadJoke",
        () => generateDadJoke({ date: DATE, memberId: "m1", params: { language: "es" } }),
      ],
      [
        "wordOfDay",
        () => generateWordOfDay({ date: DATE, memberId: "m1", params: { language: "es" } }),
      ],
      ["trivia", () => generateTrivia({ date: DATE, memberId: "m1", params: { language: "es" } })],
      ["riddle", () => generateRiddle({ date: DATE, memberId: "m1", params: { language: "es" } })],
      [
        "wordSearch",
        () => generateWordSearch({ date: DATE, memberId: "m1", params: { language: "es" } }),
      ],
    ] as const)(
      "%s: an illegal es request throws CorpusBlockParamError, never falls back",
      (_type, run) => {
        expect(run).toThrow(CorpusBlockParamError);
      }
    );

    it("an unrecognized language also throws for a bilingual block (never silently defaults)", () => {
      expect(() =>
        generateAnimalFact({ date: DATE, memberId: "m1", params: { language: "fr" } })
      ).toThrow(CorpusBlockParamError);
    });
  });

  describe("numberFact dayOfYear keying (v1 exact recipe: keyed by dayOfYear, NOT a hash)", () => {
    it("dayOfYear matches the standard 1-based ordinal for known dates", () => {
      expect(dayOfYear("2026-01-01")).toBe(1);
      expect(dayOfYear("2026-12-31")).toBe(365); // 2026 is not a leap year
    });

    it("two DIFFERENT dates sharing the same day-of-year select the SAME corpus entry", () => {
      // Neither 2025 nor 2026 is a leap year, so June 15 falls on day-of-year 166 in both.
      expect(dayOfYear("2025-06-15")).toBe(166);
      expect(dayOfYear("2026-06-15")).toBe(166);

      const first = generateNumberFact({ date: "2025-06-15", memberId: "m1" });
      const second = generateNumberFact({ date: "2026-06-15", memberId: "m1" });
      expect(first).toEqual(second);
      expect(first.number).toBe(166);
    });

    it("a date NOT sharing the day-of-year selects a different entry", () => {
      const day1 = generateNumberFact({ date: "2026-01-01", memberId: "m1" });
      const day2 = generateNumberFact({ date: "2026-01-02", memberId: "m1" });
      expect(day1.number).not.toBe(day2.number);
    });
  });

  describe("params validation defense-in-depth (settings.ts validates upstream; this is the fence)", () => {
    it("wordOfDay: an invalid level throws rather than silently defaulting", () => {
      expect(() =>
        generateWordOfDay({ date: DATE, memberId: "m1", params: { level: "L9" } })
      ).toThrow(CorpusBlockParamError);
    });

    it("trivia: an invalid difficulty throws rather than silently defaulting", () => {
      expect(() =>
        generateTrivia({ date: DATE, memberId: "m1", params: { difficulty: "impossible" } })
      ).toThrow(CorpusBlockParamError);
    });

    it("wordSearch: an invalid difficulty throws rather than silently defaulting", () => {
      expect(() =>
        generateWordSearch({ date: DATE, memberId: "m1", params: { difficulty: "impossible" } })
      ).toThrow(CorpusBlockParamError);
    });

    it("wordOfDay: an absent level defaults to L2 (v1 parity)", () => {
      const withDefault = generateWordOfDay({ date: DATE, memberId: "m1" });
      const explicitL2 = generateWordOfDay({ date: DATE, memberId: "m1", params: { level: "L2" } });
      expect(withDefault).toEqual(explicitL2);
    });

    it("trivia: an absent difficulty defaults to easy (v1 parity)", () => {
      const withDefault = generateTrivia({ date: DATE, memberId: "m1" });
      const explicitEasy = generateTrivia({
        date: DATE,
        memberId: "m1",
        params: { difficulty: "easy" },
      });
      expect(withDefault).toEqual(explicitEasy);
    });
  });

  describe("riddle corpus sanity (EN-only by policy, not by missing translation infra)", () => {
    it("the selected riddle matches the underlying corpus entry at the recipe's index", () => {
      const result = generateRiddle({ date: DATE, memberId: "m1" });
      const found = riddlesCorpus.find((entry) => entry.question === result.question);
      expect(found).toBeDefined();
      expect(found?.answer).toBe(result.answer);
    });
  });

  /** P1 (D2): a `null` `pronunciation` reaching the merged render adapter
   * (`../render/adapter.ts`'s `wordOfDay` case, lines 81-83) throws `AdapterError` — it guards
   * `example` against both `undefined` and `null`, but `pronunciation` only against `undefined`.
   * `WordOfDayData.pronunciation` is now optional and omitted (not `null`) when the corpus entry
   * has none (v1 parity — `blocks/word-of-day.ts`'s `if (w.pronunciation) …`). Both branches are
   * exercised against the REAL `adaptBlockData`, not a re-implementation of its guard.
   */
  describe("wordOfDay pronunciation vs the render adapter (P1, D2 review)", () => {
    it("an entry WITH a pronunciation adapts cleanly and carries the key", () => {
      // 2026-09-08 / L2 -> "honest", pronunciation "/ˈɒnɪst/" (frozen, verified below too).
      const result = generateWordOfDay({ date: DATE, memberId: "m1", params: { level: "L2" } });
      expect(result.pronunciation).toBe("/ˈɒnɪst/");
      expect(() => adaptBlockData("wordOfDay", result)).not.toThrow();
      const adapted = adaptBlockData("wordOfDay", result) as Record<string, unknown>;
      expect(adapted.pronunciation).toBe("/ˈɒnɪst/");
    });

    it("an entry WITHOUT a pronunciation adapts cleanly with the key ABSENT (the P1 repro case)", () => {
      // 2026-01-19 / L3 -> "persevere", pronunciation AND example both null in the raw corpus
      // entry (reproduced live, D2) — the null `example` was already adapter-safe; the
      // null `pronunciation` was NOT, before this fix.
      const result = generateWordOfDay({
        date: "2026-01-19",
        memberId: "m1",
        params: { level: "L3" },
      });
      expect(result.word).toBe("persevere");
      expect(result).not.toHaveProperty("pronunciation");
      expect(() => adaptBlockData("wordOfDay", result)).not.toThrow();
      const adapted = adaptBlockData("wordOfDay", result) as Record<string, unknown>;
      expect(adapted).not.toHaveProperty("pronunciation");
      expect(adapted.example).toBeUndefined(); // example was also null here; adapter drops it too
    });
  });

  /** / (D2): the suite above proves determinism (same input -> same output twice)
   * but never pins WHICH content a fixed recipe selects — a mutant that changes a seed literal,
   * drops `memberId` from a member-scoped recipe, or swaps a default could still pass every
   * determinism check. These pin the EXACT v1-parity output for fixed inputs (independently
   * verified against the corpus files by index, not just re-run through the same code path).
   */
  describe("frozen seed-recipe pins (v1-parity, D2 review P2-1/P2-2)", () => {
    it("dadJoke: `${date}|joke` selects a pinned entry for 2026-09-08", () => {
      expect(generateDadJoke({ date: DATE, memberId: "m1" })).toEqual({
        text: "What do you call a crowd of ducks? A quack mob.",
      });
    });

    it("riddle: `${date}|riddle` selects a pinned entry for 2026-09-08", () => {
      expect(generateRiddle({ date: DATE, memberId: "m1" })).toEqual({
        question: "What comes once in a year, twice in a week, but never in a day?",
        answer: "The letter E.",
      });
    });

    it("animalFact: `${date}|animalFact` selects a pinned entry for 2026-09-08", () => {
      expect(generateAnimalFact({ date: DATE, memberId: "m1" })).toEqual({
        text: "Lemurs use scent glands on their wrists and chests to mark territory and communicate social status.",
        animal: "lemur",
      });
    });

    it("drawingPrompt: `${date}|drawingPrompt` selects a pinned entry for 2026-09-08", () => {
      expect(generateDrawingPrompt({ date: DATE, memberId: "m1" })).toEqual({
        prompt: "Draw a fox baking bread with a tiny apron on",
        requiresDrawingSpace: true,
      });
    });

    it('wordOfDay: `${date}|wordOfDay|${level}` (the literal "wordOfDay" segment included) selects a pinned entry', () => {
      const result = generateWordOfDay({ date: DATE, memberId: "m1", params: { level: "L2" } });
      expect(result).toEqual({
        word: "honest",
        type: "adjective",
        definition:
          "(of a person or institution) Scrupulous with regard to telling the truth; not given to swindling, lying, or fraud; upright.",
        example: "We’re the most honest people you will ever come across.",
        pronunciation: "/ˈɒnɪst/",
      });
    });

    it("wordSearch: the selection seed includes memberId — two members get DIFFERENT word lists on the same date", () => {
      const memberA = generateWordSearch({ date: DATE, memberId: "member-A" });
      const memberB = generateWordSearch({ date: DATE, memberId: "member-B" });
      expect(memberA.words).toEqual([
        "UNIT",
        "RENT",
        "BEARD",
        "FORTE",
        "ZOO",
        "VERS",
        "GRIT",
        "GLARE",
        "NORSE",
        "SAME",
      ]);
      expect(memberB.words).toEqual([
        "TOMMY",
        "WARE",
        "LATER",
        "BEGIN",
        "DIMLY",
        "FOUR",
        "HACK",
        "COMES",
        "FOG",
        "TON",
      ]);
      // The pinned lists themselves are the proof: not merely different grids, but different
      // WORD LISTS — the selection seed (not just the placement seed) carries memberId.
      expect(memberA.words).not.toEqual(memberB.words);
    });

    it("wordSearch: an absent difficulty defaults to the easy profile's exact dimensions", () => {
      const result = generateWordSearch({ date: DATE, memberId: "member-A" });
      expect(result.difficulty).toBe("easy");
      expect(result.rows).toBe(8);
      expect(result.cols).toBe(8);
    });
  });
});
