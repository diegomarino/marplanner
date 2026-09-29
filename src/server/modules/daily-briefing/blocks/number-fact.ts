/** numberFact corpus block (v1 parity port of `blocks/number-fact.ts`).
 */
import { numberFactsCorpus } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import {
  resolveCorpusLanguage,
  CorpusBlockParamError,
  type CorpusGenerationContext,
} from "./context";

const TYPE: CorpusBlockType = "numberFact";

export interface NumberFactData {
  number: number;
  fact: string;
  kind: "math" | "trivia";
}

/** v1 exact recipe: numberFact is keyed by `dayOfYear(date)`, NOT a hash ("numberFact
 * keyed by dayOfYear"). UTC noon dodges any DST boundary regardless of the household's offset —
 * every date maps to a stable 1..366 ordinal independent of server-local time (FR-012 spirit).
 */
export function dayOfYear(dateIso: string): number {
  const d = new Date(`${dateIso}T12:00:00.000Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
  const diff = d.getTime() - start.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

/** FR-009/INV-06: `params.language` selects the `en`/`es` variant; both corpora share `number`s. */
export function generateNumberFact(ctx: CorpusGenerationContext): NumberFactData {
  const language = resolveCorpusLanguage(TYPE, ctx.params);
  const n = dayOfYear(ctx.date);
  const entry = numberFactsCorpus[language].find((row) => row.number === n);
  if (!entry) {
    throw new CorpusBlockParamError(
      `daily-briefing numberFact: no entry for day-of-year ${n} (date "${ctx.date}")`
    );
  }
  return { number: entry.number, fact: entry.fact, kind: entry.kind };
}
