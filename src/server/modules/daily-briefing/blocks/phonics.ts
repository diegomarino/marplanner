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

/** Day number of a `YYYY-MM-DD` business date (days since 1970-01-01). */
function dayNumber(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new CorpusBlockParamError(`daily-briefing phonics: invalid date "${date}"`);
  }
  return Math.floor(ms / 86_400_000);
}

/** Rotation through the level: the word sequence is one seeded shuffle of the level pool after
 * another (pass k shuffled with seed `phonics|${level}|${k}`), and day d reads positions
 * d*count onwards. Every word of the level comes up once before any repeats; only a pass
 * boundary can bring a word back early, and a duplicate inside one day is skipped. The seed
 * carries no member id, so the whole household gets the same words.
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
  const passes = new Map<number, typeof pool>();
  const wordAt = (position: number) => {
    const pass = Math.floor(position / pool.length);
    let order = passes.get(pass);
    if (!order) {
      order = fisherYates(pool, hashSeed(`phonics|${level}|${pass}`));
      passes.set(pass, order);
    }
    return order[position % pool.length];
  };

  const picked: typeof pool = [];
  for (let position = dayNumber(ctx.date) * count; picked.length < count; position += 1) {
    const entry = wordAt(position);
    if (!picked.includes(entry)) picked.push(entry);
  }
  return {
    level,
    words: picked.map((entry) => ({
      word: entry.word,
      graphemes: [...entry.graphemes],
      tricky: entry.tricky,
    })),
  };
}
