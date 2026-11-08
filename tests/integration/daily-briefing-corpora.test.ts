import { describe, expect, it } from "vitest";
import {
  animalFactsCorpus,
  CORPUS_BLOCK_TYPES,
  corpusLanguagesFor,
  dadJokesCorpus,
  drawingPromptsCorpus,
  fisherYates,
  getWordSearchPool,
  hashSeed,
  isCorpusBackedBlockType,
  isCorpusLanguageAvailable,
  isKnownBlockType,
  numberFactsCorpus,
  riddlesCorpus,
  triviaCorpus,
  vocabularyCorpus,
  withSeededMathRandom,
  wouldYouRathersCorpus,
} from "../../src/server/modules/daily-briefing/corpora/index";

/** docs/features/daily-briefing.md (trap-sweep row): loader
 * shapes/counts, deterministic seeded selection, ES-variant resolution for the 4 translated
 * corpora, riddles EN-only (v1 policy), and corpus-availability-map correctness — the exact
 * surface `../settings.ts` and the future block generators depend on.
 */
describe("daily-briefing corpora", () => {
  describe("loader shapes and counts (v1 study parity)", () => {
    it("jokes: 588 entries, each a TextEntry", () => {
      expect(dadJokesCorpus).toHaveLength(588);
      expect(dadJokesCorpus[0]).toHaveProperty("text");
      expect(typeof dadJokesCorpus[0].text).toBe("string");
    });

    it("trivia: 832 entries", () => {
      expect(triviaCorpus).toHaveLength(832);
      expect(triviaCorpus[0]).toMatchObject({
        question: expect.any(String),
        correctAnswer: expect.any(String),
        options: expect.any(Array),
        difficulty: expect.stringMatching(/^(easy|medium|hard)$/),
        category: expect.any(String),
      });
    });

    it("vocabulary: 398 entries", () => {
      expect(vocabularyCorpus).toHaveLength(398);
      expect(vocabularyCorpus[0]).toMatchObject({
        word: expect.any(String),
        level: expect.stringMatching(/^L[1-4]$/),
      });
    });

    it("animal facts: 484 entries (en), 484 entries (es)", () => {
      expect(animalFactsCorpus.en).toHaveLength(484);
      expect(animalFactsCorpus.es).toHaveLength(484);
    });

    it("number facts: 366 entries (en), 366 entries (es)", () => {
      expect(numberFactsCorpus.en).toHaveLength(366);
      expect(numberFactsCorpus.es).toHaveLength(366);
    });

    it("drawing prompts: 365 entries (en), 365 entries (es)", () => {
      expect(drawingPromptsCorpus.en).toHaveLength(365);
      expect(drawingPromptsCorpus.es).toHaveLength(365);
    });

    it("would-you-rathers: 201 entries (en), 201 entries (es)", () => {
      expect(wouldYouRathersCorpus.en).toHaveLength(201);
      expect(wouldYouRathersCorpus.es).toHaveLength(201);
    });

    it("riddles: EN-only corpus, non-empty", () => {
      expect(riddlesCorpus.length).toBeGreaterThan(0);
      expect(riddlesCorpus[0]).toMatchObject({
        question: expect.any(String),
        answer: expect.any(String),
        difficulty: expect.stringMatching(/^(easy|medium|hard)$/),
      });
    });

    it("word-search pools: non-empty for every difficulty", () => {
      expect(getWordSearchPool("easy").length).toBeGreaterThan(0);
      expect(getWordSearchPool("medium").length).toBeGreaterThan(0);
      expect(getWordSearchPool("hard").length).toBeGreaterThan(0);
    });
  });

  describe("deterministic seeded selection (research D7)", () => {
    it("hashSeed is a pure function: same input -> same output, always", () => {
      const a = hashSeed("2026-09-08|joke");
      const b = hashSeed("2026-09-08|joke");
      expect(a).toBe(b);
    });

    /** v1-verified golden vectors (batch-B): self-consistency checks alone can't
     * detect algorithm drift from v1 (e.g. a mulberry32 constant or the SHA-1 offset changing
     * while staying internally consistent) — these pin the EXACT v1 output for fixed inputs, so
     * such drift fails loudly instead of surviving.
     */
    it("hashSeed matches v1's exact SHA-1-derived output for known inputs", () => {
      expect(hashSeed("2026-09-08|joke")).toBe(68940901);
      expect(hashSeed("2026-09-08")).toBe(2022378160);
    });

    it("fisherYates matches v1's exact mulberry32-driven permutation for a known seed", () => {
      expect(fisherYates(["a", "b", "c", "d", "e"], hashSeed("2026-09-08"))).toEqual([
        "d",
        "e",
        "b",
        "c",
        "a",
      ]);
    });

    it("the SAME seed selects the SAME corpus entry twice", () => {
      const seed = hashSeed("2026-09-08|joke");
      const idxA = seed % dadJokesCorpus.length;
      const idxB = hashSeed("2026-09-08|joke") % dadJokesCorpus.length;
      expect(idxA).toBe(idxB);
      expect(dadJokesCorpus[idxA]).toBe(dadJokesCorpus[idxB]);
    });

    it("a DIFFERENT date generally selects a different entry", () => {
      const idxDay1 = hashSeed("2026-09-08|joke") % dadJokesCorpus.length;
      const idxDay2 = hashSeed("2026-09-09|joke") % dadJokesCorpus.length;
      // Not a mathematical guarantee (a hash collision on the modulus is possible), but a
      // 588-entry pool makes an accidental collision on ANY two adjacent-day probes vanishingly
      // unlikely — if this ever flakes, the recipe (not the test) is the first suspect.
      expect(idxDay1).not.toBe(idxDay2);
    });

    it("fisherYates is deterministic for a fixed seed and is an actual permutation", () => {
      const items = ["a", "b", "c", "d", "e"];
      const seed = hashSeed("2026-09-08");
      const shuffledA = fisherYates(items, seed);
      const shuffledB = fisherYates(items, seed);
      expect(shuffledA).toEqual(shuffledB);
      expect([...shuffledA].sort()).toEqual([...items].sort());
    });

    it("withSeededMathRandom confines the patch: Math.random is restored after, even on throw", () => {
      const original = Math.random;
      const seenInside: number[] = [];
      withSeededMathRandom(hashSeed("seed-a"), () => {
        seenInside.push(Math.random());
      });
      expect(Math.random).toBe(original);

      expect(() =>
        withSeededMathRandom(hashSeed("seed-b"), () => {
          throw new Error("boom");
        })
      ).toThrow("boom");
      expect(Math.random).toBe(original);
    });

    it("withSeededMathRandom is itself deterministic for a fixed seed", () => {
      const draw = (seed: number) => withSeededMathRandom(seed, () => Math.random());
      const seed = hashSeed("2026-09-08|member-1|wordSearch|easy|placement");
      expect(draw(seed)).toBe(draw(seed));
    });
  });

  describe("ES-variant resolution (INV-06, the 4 translated corpora)", () => {
    it.each([
      ["animalFact", animalFactsCorpus] as const,
      ["numberFact", numberFactsCorpus] as const,
      ["drawingPrompt", drawingPromptsCorpus] as const,
      ["wouldYouRather", wouldYouRathersCorpus] as const,
    ])("%s: en and es siblings both resolve and are structurally aligned", (_type, corpus) => {
      expect(corpus.en.length).toBeGreaterThan(0);
      expect(corpus.es.length).toBe(corpus.en.length);
      // Same index in each language variant addresses the "same slot" (a fixed seed picks the
      // same index regardless of which language variant is loaded at generation time).
      expect(typeof corpus.en[0]).toBe(typeof corpus.es[0]);
    });
  });

  describe("corpus-availability map (FR-008/FR-009)", () => {
    it("riddles are EN-only: es is not an available language", () => {
      expect(corpusLanguagesFor("riddle")).toEqual(["en"]);
      expect(isCorpusLanguageAvailable("riddle", "en")).toBe(true);
      expect(isCorpusLanguageAvailable("riddle", "es")).toBe(false);
    });

    it("trivia and wordOfDay (vocabulary) are EN-only", () => {
      expect(isCorpusLanguageAvailable("trivia", "es")).toBe(false);
      expect(isCorpusLanguageAvailable("wordOfDay", "es")).toBe(false);
    });

    it("the 4 translated corpora accept both en and es", () => {
      for (const type of ["animalFact", "numberFact", "drawingPrompt", "wouldYouRather"] as const) {
        expect(isCorpusLanguageAvailable(type, "en")).toBe(true);
        expect(isCorpusLanguageAvailable(type, "es")).toBe(true);
      }
    });

    /** (batch-B): table-drive the FULL corpus-backed-type x language matrix against a
     * hardcoded expected table (not derived from `corpusLanguagesFor`, which would make this
     * tautological) — a per-cell mutation of `CORPUS_LANGUAGE_AVAILABILITY` (e.g. dadJoke
     * silently gaining `es`) fails exactly the one affected cell instead of surviving the
     * looser spot-checks below.
     */
    const EXPECTED_CORPUS_AVAILABILITY: Record<
      (typeof CORPUS_BLOCK_TYPES)[number],
      { en: boolean; es: boolean }
    > = {
      dadJoke: { en: true, es: false },
      wordOfDay: { en: true, es: false },
      animalFact: { en: true, es: true },
      numberFact: { en: true, es: true },
      trivia: { en: true, es: false },
      riddle: { en: true, es: false },
      phonics: { en: true, es: false },
      wouldYouRather: { en: true, es: true },
      wordSearch: { en: true, es: false },
      drawingPrompt: { en: true, es: true },
    };

    it.each(
      Object.entries(EXPECTED_CORPUS_AVAILABILITY).flatMap(([type, { en, es }]) => [
        [type, "en", en] as const,
        [type, "es", es] as const,
      ])
    )("%s + %s -> available:%s", (type, language, expected) => {
      expect(isCorpusLanguageAvailable(type, language)).toBe(expected);
    });

    it("a non-corpus block type (e.g. message) never accepts a language override (FR-008)", () => {
      expect(isCorpusBackedBlockType("message")).toBe(false);
      expect(isCorpusLanguageAvailable("message", "en")).toBe(false);
      expect(isCorpusLanguageAvailable("message", "es")).toBe(false);
    });

    it("an unknown block type never accepts a language override", () => {
      expect(isCorpusLanguageAvailable("not-a-real-type", "en")).toBe(false);
    });

    it("every CORPUS_BLOCK_TYPE is a known block type", () => {
      for (const type of CORPUS_BLOCK_TYPES) {
        expect(isKnownBlockType(type)).toBe(true);
      }
    });

    it("isKnownBlockType recognizes all 21 registry types and rejects garbage", () => {
      expect(isKnownBlockType("shotgun")).toBe(true);
      expect(isKnownBlockType("streakText")).toBe(true);
      expect(isKnownBlockType("weatherText")).toBe(true);
      expect(isKnownBlockType("onThisDay")).toBe(true);
      expect(isKnownBlockType("not-a-real-type")).toBe(false);
      expect(isKnownBlockType(42)).toBe(false);
    });
  });
});
