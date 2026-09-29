/** riddle corpus block (v1 parity port of `blocks/riddle.ts`).
 */
import { hashSeed, riddlesCorpus } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import { assertCorpusLanguageAvailable, type CorpusGenerationContext } from "./context";

const TYPE: CorpusBlockType = "riddle";

/** v1 parity, DELIBERATE contrast with trivia: the answer IS included here (— "riddle
 * (answer in payload, de-emphasized in view, rotated in print)"). the family view renders it
 * inline, de-emphasized; the print render rotates it (out of this module's scope).
 */
export interface RiddleData {
  question: string;
  answer: string;
}

/** v1 seed: `${date}|riddle` (table) — date-only, no memberId (v1 `scope: "shared"`). */
export function generateRiddle(ctx: CorpusGenerationContext): RiddleData {
  assertCorpusLanguageAvailable(TYPE, ctx.params); // EN-only BY POLICY (v1 study); throws on "es"

  const pool = riddlesCorpus;
  const idx = hashSeed(`${ctx.date}|riddle`) % pool.length;
  const entry = pool[idx];
  return { question: entry.question, answer: entry.answer };
}
