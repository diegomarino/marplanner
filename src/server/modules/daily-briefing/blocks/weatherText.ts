/** `weatherText` block (FR-013) —: "the two `*Text` types delegate
 * to their visual twins' data". Delegates to `generateWeatherBlock` unchanged: same cache entry
 * (`daily_briefing_block_cache` blockType `"weather"`), so calling both `weather` and
 * `weatherText` in the same generation pass never doubles the external call — the second call is
 * always a cache hit (`tests/integration/daily-briefing-blocks-external.test.ts` "weatherText
 * delegates to weather's data").
 */
import type { DailyBlockCache } from "../external/shared-cache";
import { generateWeatherBlock, type WeatherBlockData } from "./weather";

export type { WeatherBlockData };

export async function generateWeatherTextBlock(
  cache: DailyBlockCache,
  date: string,
  now: number
): Promise<WeatherBlockData | null> {
  return generateWeatherBlock(cache, date, now);
}
