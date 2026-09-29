/** drawingPrompt corpus block (v1 parity port of `blocks/drawing-prompt.ts`).
 */
import { drawingPromptsCorpus, hashSeed } from "../corpora";
import type { CorpusBlockType } from "../corpora";
import { resolveCorpusLanguage, type CorpusGenerationContext } from "./context";

const TYPE: CorpusBlockType = "drawingPrompt";

export interface DrawingPromptData {
  prompt: string;
  requiresDrawingSpace: true;
}

/** v1 seed: `${date}|drawingPrompt` (table) — date-only, no memberId (v1
 * `scope: "shared"` parity). FR-009/INV-06: `params.language` selects the `en`/`es` variant
 * (index-aligned corpora).
 */
export function generateDrawingPrompt(ctx: CorpusGenerationContext): DrawingPromptData {
  const language = resolveCorpusLanguage(TYPE, ctx.params);
  const pool = drawingPromptsCorpus[language];
  const idx = hashSeed(`${ctx.date}|drawingPrompt`) % pool.length;
  return { prompt: pool[idx].text, requiresDrawingSpace: true };
}
