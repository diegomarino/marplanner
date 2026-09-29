/** wordOfDay corpus block (v1 parity port of `blocks/word-of-day.ts`).
 */
import { hashSeed, vocabularyCorpus } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import {
  assertCorpusLanguageAvailable,
  CorpusBlockParamError,
  type CorpusGenerationContext,
} from "./context";

const TYPE: CorpusBlockType = "wordOfDay";
const VALID_LEVELS = new Set(["L1", "L2", "L3", "L4"]);
const DEFAULT_LEVEL = "L2";

/** `pronunciation` is OMITTED (not `null`) when the corpus entry has none — v1 parity
 * (`blocks/word-of-day.ts`: `pronunciation?: string; if (w.pronunciation) payload.pronunciation =
 * …`). This is deliberate, not cosmetic: the merged render adapter
 * (`../render/adapter.ts`'s `wordOfDay` case) guards `example` against both `undefined` AND
 * `null`, but only guards `pronunciation` against `undefined` — a `null` reaches `needString`,
 * which throws `AdapterError`. ~5% of L3 vocabulary entries (5/100) and ~3% of L4 (3/98) have a
 * `null` pronunciation, so emitting the key unconditionally as `string | null` would render-fail
 * every briefing that lands on one of those entries (— P1, D2; reproduced
 * live at date `2026-01-19`/level `L3` -> "persevere", `pronunciation: null`).
 */
export interface WordOfDayData {
  word: string;
  type: string;
  definition: string;
  example: string | null;
  pronunciation?: string;
}

/** v1 seed: `${date}|wordOfDay|${level}` (table) — level-scoped, memberId-independent:
 * every household member at the SAME level sees the same word on a given date.
 * `params.level` defaults to L2 (v1 parity); an out-of-range level throws (settings.ts already
 * validates this at the write boundary — see the `params` row).
 */
export function generateWordOfDay(ctx: CorpusGenerationContext): WordOfDayData {
  assertCorpusLanguageAvailable(TYPE, ctx.params); // EN-only (no vocabulary.es.json); throws on "es"

  const requested = ctx.params?.level;
  let level: string;
  if (requested === undefined) {
    level = DEFAULT_LEVEL;
  } else if (VALID_LEVELS.has(requested)) {
    level = requested;
  } else {
    throw new CorpusBlockParamError(
      `daily-briefing wordOfDay: invalid level "${requested}" (settings.ts must reject this upstream)`
    );
  }

  const pool = vocabularyCorpus.filter((entry) => entry.level === level);
  if (pool.length === 0) {
    throw new CorpusBlockParamError(
      `daily-briefing wordOfDay: no vocabulary entries for level "${level}"`
    );
  }

  const idx = hashSeed(`${ctx.date}|wordOfDay|${level}`) % pool.length;
  const entry = pool[idx];
  const data: WordOfDayData = {
    word: entry.word,
    type: entry.type,
    definition: entry.definition,
    example: entry.example,
  };
  // v1 parity: set the key ONLY when truthy — see the WordOfDayData doc comment above.
  if (entry.pronunciation) {
    data.pronunciation = entry.pronunciation;
  }
  return data;
}
