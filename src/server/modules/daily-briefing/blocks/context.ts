/** Shared parameters and language resolution for deterministic corpus generators.
 * These generators are synchronous and perform no I/O. A requested corpus language
 * must exist; an unset override uses the available household variant, then English.
 */
import { isCorpusLanguageAvailable } from "../corpora";
import type { CorpusBlockType, CorpusLanguage } from "../corpora";

/** Frozen per-instance params (`daily_briefing_member_block_settings.params`). */
export interface CorpusBlockParams {
  language?: string;
  level?: string;
  difficulty?: string;
}

export interface CorpusGenerationContext {
  /** Household business date, `YYYY-MM-DD` (FR-012 — household tz, never server-local time). */
  date: string;
  /** Stable member id — consumed only by the seed recipes that include it. */
  memberId: string;
  /** Frozen instance params — settings.ts validates these BEFORE they ever reach here. */
  params?: CorpusBlockParams;
}

/** Thrown when `params.language` (or `.level`/`.difficulty`) has no on-disk corpus / no valid
 * value for a block type. settings.ts already rejects an illegal write at the boundary
 * (400 `corpus_language_unavailable`) — this is defense in depth for a generator invoked directly
 * (e.g. a future caller that bypasses settings validation), so an illegal request fails LOUDLY
 * rather than silently replacing an explicit override with English.
 */
export class CorpusBlockParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusBlockParamError";
  }
}

/** Resolve the corpus language variant for `type`. Absent `params.language` uses the household variant when available, then "en";
 * a present-but-unavailable language throws `CorpusBlockParamError` rather than falling back
 * (fallback applies only to an unset override).
 */
export function resolveCorpusLanguage(
  type: CorpusBlockType,
  params: CorpusBlockParams | undefined,
  householdLanguage = "en"
): CorpusLanguage {
  const requested = params?.language;
  if (requested === undefined) {
    return isCorpusLanguageAvailable(type, householdLanguage)
      ? (householdLanguage as CorpusLanguage)
      : "en";
  }
  if (!isCorpusLanguageAvailable(type, requested)) {
    throw new CorpusBlockParamError(
      `daily-briefing corpus block "${type}": language "${requested}" has no on-disk corpus ` +
        `(settings.ts must reject this write upstream — FR-009)`
    );
  }
  return requested as CorpusLanguage;
}

/** EN-only block types (dadJoke, wordOfDay, trivia, riddle, wordSearch) still route through
 * `resolveCorpusLanguage` so an illegal `language: "es"` request throws instead of being ignored
 * — the return value is simply never needed since there is only ever one pool to read from.
 */
export function assertCorpusLanguageAvailable(
  type: CorpusBlockType,
  params: CorpusBlockParams | undefined
): void {
  resolveCorpusLanguage(type, params);
}
