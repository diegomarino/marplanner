/** "streakText" domain block ("The 21 block types" — "the two `*Text`
 * types delegate to their visual twins' data"). PORTED from v1
 * `apps/api/src/lib/daily-briefing/blocks/streak-text.ts` verbatim: a pure delegate to
 * `./streak.ts`'s generator, so both visual treatments (the pictorial streak block and its
 * text-only pressedslip render twin) always stay in lockstep — one source of truth for the
 * `{days, label, last7}` shape (adapter.ts's shared "streak"/"streakText" case).
 */
import { streakBlock, type StreakBlockContext, type StreakBlockData } from "./streak";

export const streakTextBlock = {
  type: "streakText" as const,
  scope: "member" as const,
  source: "./streak.ts (pure delegate — v1 parity)",
  async generate(ctx: StreakBlockContext): Promise<StreakBlockData | null> {
    return streakBlock.generate(ctx);
  },
};
