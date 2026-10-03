/** "shotgun" domain block ("The 21 block types", FR-013). PORTED
 * from v1 `apps/api/src/lib/daily-briefing/blocks/shotgun.ts` (fisherYates-shuffled front-seat
 * ranking among opted-in active members, capped at 4, seeded by `hashSeed(date)` for a
 * household-wide deterministic-per-day order).
 * v1's opt-in signal was a bespoke `memberBlockSettings` table; v2's equivalent
 * (`daily_briefing_member_block_settings`, D8) is THIS PLUGIN's own settings table — a same-plugin
 * read, so this block imports `../settings` directly (no Rule B concern; `../settings` is inside
 * `src/server/modules/daily-briefing/* `) and reuses `resolveMemberBlockSettings`'s FR-013
 * default-resolution rule (absent row -> enabled, since "shotgun" is not in
 * `DEFAULT_DISABLED_BLOCK_TYPES`) rather than re-deriving it here. Deliberate v1->v2 re-homing:
 * v1's opt-in required an explicit settings row (absence -> excluded); v2 defaults a member IN
 * (absence -> enabled) per the canonical FR-013 rule every block type shares, so a household that
 * never touches shotgun's settings now gets every active member ranked, not zero.
 * The one missing piece is enumerating "every active member" to resolve settings against and to
 * shuffle: `src/server/host-api/index.ts` exports only per-id member reads
 * (`isActiveMember`/`assertActiveMember`/`memberExists`/`resolveMemberLabel`), no bulk listing —
 * `listActiveMembers`/`listActiveChildren` exist in `modules/members/referential.ts` but are NOT
 * barrel-exported. Adding that export is outside this module's queued-path scope (host-api is not
 * `src/server/modules/daily-briefing/blocks/* `), so — mirroring `./message.ts`'s same-shaped gap
 * — the member roster is an INJECTABLE port (`ctx.listActiveMembers`); `generate` returns
 * `null` when it is not supplied, matching this block's own "nothing to show" convention and
 * production's current (unwired) state.
 */
import { readHouseholdTimezone, weekdayOf } from "../../../host-api";
import { fisherYates, hashSeed } from "../corpora/determinism";
import { resolveMemberBlockSettings } from "../settings";

const TYPE = "shotgun";
const MAX_RANKED = 4;

export interface ShotgunActiveMember {
  id: string;
  displayName: string;
}

export interface ShotgunBlockContext {
  date: string;
  /** See the module doc above — the host-api member-listing gap this generator is built around. */
  listActiveMembers?: () => ShotgunActiveMember[];
}

export interface ShotgunBlockData {
  ranking: string[];
}

export const shotgunBlock = {
  type: TYPE,
  scope: "shared" as const,
  source:
 "../settings (resolveMemberBlockSettings, same-plugin) + ctx.listActiveMembers (host-api member-listing gap, see module doc) + ../corpora/determinism (hashSeed/fisherYates)",
  async generate(ctx: ShotgunBlockContext): Promise<ShotgunBlockData | null> {
    if (!ctx.listActiveMembers) return null;
    const activeMembers = ctx.listActiveMembers();
    if (activeMembers.length === 0) return null;

    const tz = readHouseholdTimezone();
    const weekday = weekdayOf(ctx.date, tz);

    const eligible = activeMembers.filter((member) => {
      const settings = resolveMemberBlockSettings(member.id, TYPE);
      if (!settings.enabled) return false;
      // `weekdays: null` means "all days" (D8/settings.ts); a provided array gates on it.
      return settings.weekdays === null || settings.weekdays.includes(weekday);
    });
    if (eligible.length === 0) return null;

    const names = eligible.map((member) => member.displayName);
    const shuffled = fisherYates(names, hashSeed(ctx.date));
    // Cap at 4 — a 5-seat car always has a driver, so only 4 passenger spots are up for grabs
    // (v1 parity comment, verbatim rationale).
    const ranking = shuffled.slice(0, MAX_RANKED);

    return { ranking };
  },
};
