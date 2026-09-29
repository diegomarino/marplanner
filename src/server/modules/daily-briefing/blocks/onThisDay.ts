/** On-this-day block (FR-013/FR-019) — ships DEFAULT-DISABLED
 * (`../corpora/block-types.ts` `DEFAULT_DISABLED_BLOCK_TYPES`, FR-013, already seeded by the * settings-layer read-resolution); the generator itself is a normal shared-scope, cached,
 * allowFailure external block, same shape as `quoteOfDay` — the default-off behavior lives
 * entirely in `../settings.ts`, not here.
 * `languagePrefix` ("language-prefixed URL — a per-block-language later maps to a
 * URL swap") defaults `"en"`. The cache key is `(date, blockType)` only — `daily_briefing_block_cache`'s * PK carries no language column — so, until a language dimension is added to
 * that table, the FIRST generation of the day decides which language's content the whole
 * household shares for that date. This is not a regression: no admin surface exposes a
 * per-instance language for `onThisDay` today (FR-009 restricts the `language` param to
 * corpus-backed types; `onThisDay` is external, not corpus-backed).
 */
import { getOrFetchOnceDaily, type DailyBlockCache } from "../external/shared-cache";
import type { OnThisDayData, OnThisDaySource } from "../external/ports";

export type { OnThisDayData };

const BLOCK_TYPE = "onThisDay";

export async function generateOnThisDayBlock(
  cache: DailyBlockCache,
  source: OnThisDaySource,
  date: string,
  languagePrefix = "en"
): Promise<OnThisDayData | null> {
  return getOrFetchOnceDaily(cache, BLOCK_TYPE, () => source(date, languagePrefix));
}
