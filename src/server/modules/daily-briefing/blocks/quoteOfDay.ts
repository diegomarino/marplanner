/** Quote-of-the-day block (FR-013/FR-019) — shared scope, cached per date
 * (`getOrFetchOnceDaily`, `daily_briefing_block_cache` blockType `"quoteOfDay"`): at most one
 * `source` call per date per household, reused across every member's briefing. A
 * failed/timed-out `source` call skips the block (resolves `null`) WITHOUT caching the
 * failure, so the next generation pass retries (FR-019 allowFailure + "no negative caching").
 */
import { getOrFetchOnceDaily, type DailyBlockCache } from "../external/shared-cache";
import type { QuoteOfDayData, QuoteSource } from "../external/ports";

export type { QuoteOfDayData };

const BLOCK_TYPE = "quoteOfDay";

export async function generateQuoteOfDayBlock(
  cache: DailyBlockCache,
  source: QuoteSource
): Promise<QuoteOfDayData | null> {
  return getOrFetchOnceDaily(cache, BLOCK_TYPE, source);
}
