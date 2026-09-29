/** animalFact corpus block (v1 parity port of `blocks/animal-fact.ts`).
 */
import { animalFactsCorpus, hashSeed } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import { resolveCorpusLanguage, type CorpusGenerationContext } from "./context";

const TYPE: CorpusBlockType = "animalFact";

export interface AnimalFactData {
  text: string;
  animal: string;
}

/** v1 seed: `${date}|animalFact` (table) — date-only, no memberId (v1 `scope: "shared"`
 * parity). FR-009/INV-06: `params.language` selects the `en`/`es` variant; the SAME index is used
 * regardless of variant (both on-disk corpora are index-aligned translations of the same fact).
 */
export function generateAnimalFact(ctx: CorpusGenerationContext): AnimalFactData {
  const language = resolveCorpusLanguage(TYPE, ctx.params);
  const pool = animalFactsCorpus[language];
  const idx = hashSeed(`${ctx.date}|animalFact`) % pool.length;
  const entry = pool[idx];
  return { text: entry.text, animal: entry.animal };
}
