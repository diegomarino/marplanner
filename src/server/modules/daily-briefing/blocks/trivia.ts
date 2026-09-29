/** trivia corpus block (v1 parity port of `blocks/trivia.ts`).
 */
import { hashSeed, triviaCorpus } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import {
  assertCorpusLanguageAvailable,
  CorpusBlockParamError,
  type CorpusGenerationContext,
} from "./context";

const TYPE: CorpusBlockType = "trivia";
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const DEFAULT_DIFFICULTY: "easy" | "medium" | "hard" = "easy";

/** v1 parity, DELIBERATE ("The 21 block types" — "trivia (correct
 * answer NEVER in payload)"): `correctAnswer` is never read out of the corpus entry into this
 * payload. `options` carries the full multiple-choice list (including the correct one, unmarked)
 * so the family view can render a prompt with no answer key baked in.
 */
export interface TriviaData {
  question: string;
  options: string[];
  category: string;
  difficulty: "easy" | "medium" | "hard";
}

/** v1 seed: `${date}|trivia|${memberId}` (table) — member-scoped (personal block). */
export function generateTrivia(ctx: CorpusGenerationContext): TriviaData {
  assertCorpusLanguageAvailable(TYPE, ctx.params); // EN-only; throws on an illegal "es" request

  const requested = ctx.params?.difficulty;
  let difficulty: "easy" | "medium" | "hard";
  if (requested === undefined) {
    difficulty = DEFAULT_DIFFICULTY;
  } else if (VALID_DIFFICULTIES.has(requested)) {
    difficulty = requested as "easy" | "medium" | "hard";
  } else {
    throw new CorpusBlockParamError(
      `daily-briefing trivia: invalid difficulty "${requested}" (settings.ts must reject this upstream)`
    );
  }

  const pool = triviaCorpus.filter((entry) => entry.difficulty === difficulty);
  if (pool.length === 0) {
    throw new CorpusBlockParamError(
      `daily-briefing trivia: no entries for difficulty "${difficulty}"`
    );
  }

  const idx = hashSeed(`${ctx.date}|trivia|${ctx.memberId}`) % pool.length;
  const entry = pool[idx];
  // entry.correctAnswer is intentionally NEVER read into the returned payload (v1 parity above).
  return {
    question: entry.question,
    options: entry.options,
    category: entry.category,
    difficulty: entry.difficulty,
  };
}
