/** wouldYouRather corpus block (v1 parity port of `blocks/would-you-rather.ts`).
 */
import { hashSeed, wouldYouRathersCorpus } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import { resolveCorpusLanguage, type CorpusGenerationContext } from "./context";

const TYPE: CorpusBlockType = "wouldYouRather";

export interface WouldYouRatherData {
  optionA: string;
  optionB: string;
}

/** v1 seed: `${date}|wouldYouRather|${memberId}` (table) — member-scoped (personal
 * block): each household member gets their own dilemma on a given date.
 * FR-009/INV-06: `params.language` selects the `en`/`es` variant (index-aligned corpora).
 */
export function generateWouldYouRather(ctx: CorpusGenerationContext): WouldYouRatherData {
  const language = resolveCorpusLanguage(TYPE, ctx.params);
  const pool = wouldYouRathersCorpus[language];
  const idx = hashSeed(`${ctx.date}|wouldYouRather|${ctx.memberId}`) % pool.length;
  const entry = pool[idx];
  return { optionA: entry.optionA, optionB: entry.optionB };
}
