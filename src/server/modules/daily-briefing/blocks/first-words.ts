/** firstWords corpus block: phonics-sequenced words for early readers.
 * Levels follow the usual synthetic-phonics progression: L1 CVC words with single-letter sounds,
 * L2 consonant digraphs (sh, ch, th, ng, ck…), L3 vowel digraphs and trigraphs (ai, ee, igh, oa,
 * ar, or…), L4 common tricky words. Each word carries its grapheme segmentation so the printed
 * slip can draw sound buttons under it.
 */
import { fisherYates, firstWordsCorpus, hashSeed } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import {
  assertCorpusLanguageAvailable,
  CorpusBlockParamError,
  type CorpusGenerationContext,
} from "./context";

const TYPE: CorpusBlockType = "firstWords";
const VALID_LEVELS = new Set(["L1", "L2", "L3", "L4"]);
const DEFAULT_LEVEL = "L1";

export const FIRST_WORDS_DEFAULT_COUNT = 3;
export const FIRST_WORDS_MIN_COUNT = 1;
export const FIRST_WORDS_MAX_COUNT = 6;

export interface FirstWordsWord {
  word: string;
  graphemes: string[];
  tricky: boolean;
}

export interface FirstWordsData {
  level: string;
  words: FirstWordsWord[];
}

/** True for an integer count inside the supported bounds (shared with settings.ts). */
export function isValidFirstWordsCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FIRST_WORDS_MIN_COUNT &&
    value <= FIRST_WORDS_MAX_COUNT
  );
}

/** Seed `${date}|firstWords|${level}`: level-scoped and member-independent, so the whole
 * household sees the same words on a date. The level pool is shuffled once per seed and the
 * first `count` words are taken, so raising the count only appends words.
 */
export function generateFirstWords(ctx: CorpusGenerationContext): FirstWordsData {
  assertCorpusLanguageAvailable(TYPE, ctx.params);

  const level = ctx.params?.level ?? DEFAULT_LEVEL;
  if (!VALID_LEVELS.has(level)) {
    throw new CorpusBlockParamError(`daily-briefing firstWords: invalid level "${level}"`);
  }
  const count = ctx.params?.count ?? FIRST_WORDS_DEFAULT_COUNT;
  if (!isValidFirstWordsCount(count)) {
    throw new CorpusBlockParamError(
      `daily-briefing firstWords: invalid count "${String(count)}" ` +
        `(expected an integer ${FIRST_WORDS_MIN_COUNT}-${FIRST_WORDS_MAX_COUNT})`
    );
  }

  const pool = firstWordsCorpus.filter((entry) => entry.level === level);
  const picked = fisherYates(pool, hashSeed(`${ctx.date}|firstWords|${level}`)).slice(0, count);
  return {
    level,
    words: picked.map((entry) => ({
      word: entry.word,
      graphemes: [...entry.graphemes],
      tricky: entry.tricky,
    })),
  };
}
