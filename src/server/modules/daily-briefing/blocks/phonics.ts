/** phonics corpus block: phonics-sequenced words for early readers.
 * Levels follow the usual synthetic-phonics progression: L1 CVC words with single-letter sounds,
 * L2 consonant digraphs (sh, ch, th, ng, ck…), L3 vowel digraphs and trigraphs (ai, ee, igh, oa,
 * ar, or…), L4 common tricky words. Each word carries its grapheme segmentation so the printed
 * slip can draw sound buttons under it.
 */
import { fisherYates, phonicsCorpus, hashSeed } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import {
  assertCorpusLanguageAvailable,
  CorpusBlockParamError,
  type CorpusGenerationContext,
} from "./context";

const TYPE: CorpusBlockType = "phonics";
const VALID_LEVELS = new Set(["L1", "L2", "L3", "L4"]);
const DEFAULT_LEVEL = "L1";

export const PHONICS_DEFAULT_COUNT = 3;
export const PHONICS_MIN_COUNT = 1;
export const PHONICS_MAX_COUNT = 6;

export interface PhonicsWord {
  word: string;
  graphemes: string[];
  tricky: boolean;
}

export interface PhonicsData {
  level: string;
  words: PhonicsWord[];
}

/** True for an integer count inside the supported bounds (shared with settings.ts). */
export function isValidPhonicsCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PHONICS_MIN_COUNT &&
    value <= PHONICS_MAX_COUNT
  );
}

/** Seed `${date}|phonics|${level}`: level-scoped and member-independent, so the whole
 * household sees the same words on a date. The level pool is shuffled once per seed and the
 * first `count` words are taken, so raising the count only appends words.
 */
export function generatePhonics(ctx: CorpusGenerationContext): PhonicsData {
  assertCorpusLanguageAvailable(TYPE, ctx.params);

  const level = ctx.params?.level ?? DEFAULT_LEVEL;
  if (!VALID_LEVELS.has(level)) {
    throw new CorpusBlockParamError(`daily-briefing phonics: invalid level "${level}"`);
  }
  const count = ctx.params?.count ?? PHONICS_DEFAULT_COUNT;
  if (!isValidPhonicsCount(count)) {
    throw new CorpusBlockParamError(
      `daily-briefing phonics: invalid count "${String(count)}" ` +
        `(expected an integer ${PHONICS_MIN_COUNT}-${PHONICS_MAX_COUNT})`
    );
  }

  const pool = phonicsCorpus.filter((entry) => entry.level === level);
  const picked = fisherYates(pool, hashSeed(`${ctx.date}|phonics|${level}`)).slice(0, count);
  return {
    level,
    words: picked.map((entry) => ({
      word: entry.word,
      graphemes: [...entry.graphemes],
      tricky: entry.tricky,
    })),
  };
}
