/** "streak" domain block ("The 21 block types", FR-013). PORTED
 * from v1 `apps/api/src/lib/daily-briefing/blocks/streak.ts` (a member's completed-day streak +
 * the last 7 days' pass/fail dots), re-sourced against v2's routines domain.
 * v2 seam: `getBoard(date)` (`src/server/modules/routines`, host-api-barrel-exported — the SAME
 * function `daily-briefing/index.ts`'s 010 `gatherBlocks` already calls for its own "chores"
 * block, per implementation scope's "MIRROR 010's existing access patterns exactly"). `getBoard`
 * returns, per active child, a derived `streak` count (`ROUTINES-CHORES` `getStreak` — a
 * "qualifying day" walk: every chore SCHEDULED that day was completed) computed only when `date`
 * is the household's real current day (`isToday` inside `getBoard`); for any other date it is
 * `null`. Since generation always runs for the household's current date (the scheduled 06:00 pass
 * or a same-day manual run —), this is the day `streak` is populated, so a `null`
 * here for a genuinely backfilled/historical regeneration degrades to `days: 0` rather than
 * fabricating a number (documented divergence — v1's persisted `completedDayStreak` had no such
 * gap; v2's derive-on-read design does).
 * `last7`: v1 read a raw completions table (`any completion recorded that day`); v2 has no
 * barrel-exported day-by-day completion primitive, but `getBoard(date)` already exposes, for ANY
 * date (not just "today" — only the `streak`/`todayProgress` fields are `isToday`-gated, the
 * `dayPeriods`/`chores` composition is computed unconditionally), each chore's `completed` flag
 * for that date. This block therefore calls `getBoard` once per lookback day and derives
 * "qualifying" the SAME way `getStreak` does (something scheduled that day AND every scheduled
 * chore complete) — 7 full `getBoard` compositions (each O(children × chores) for that date),
 * bounded and acceptable in the once-daily 06:00 batch-generation context this block runs in; no
 * new host-api surface needed.
 * Divergence in the transparent-day case: `getStreak`'s own walk treats a day with nothing
 * scheduled as TRANSPARENT (skipped — neither breaks nor extends the count). `last7` has no third
 * state to represent that — it is a `boolean[]` dot row — so a transparent day renders as a
 * missed (`false`) dot here, indistinguishable from a genuinely incomplete day. This is inherent
 * to the shape (v1's own `last7` had the same two-state limitation over its raw completions read)
 * and only affects the 7-day DISPLAY strip; `days` itself is `getStreak`'s real count and still
 * correctly skips transparent days.
 */
import { getBoard } from "../../../host-api";
import { getLabels } from "../render/labels";

const TYPE = "streak";

export interface StreakBlockContext {
  memberId: string;
  date: string;
  /** Household language for the `label` snapshot string (P1 fold addendum,
   * DAILY-BRIEFING-INV-06) — resolved by the caller (`index.ts`'s generator dispatch) via the same
   * settings read `../render/labels.ts#getLabels` documents. Optional — `getLabels` defaults to the
   * household's system-wide default ("en") when absent. */
  language?: string;
}

export interface StreakBlockData {
  days: number;
  label: string;
  last7: boolean[];
}

/** `{y,m,d}`-safe subtraction of `n` days from a `YYYY-MM-DD` string — pure calendar-date
 * arithmetic (timezone-invariant: a calendar date minus N days is the same calendar date
 * everywhere), NOT the household-instant math FR-012 reserves for wall-clock/event-window
 * computations (`src/shared/householdTime.ts`). Mirrors that module's own `addOneLocalDay`
 * technique (`Date.UTC` normalization), just subtracting instead of adding. */
function subtractDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Last 7 calendar dates strictly BEFORE `date`, chronological (oldest first) — v1 parity
 * (today itself is excluded: it's always incomplete when the briefing generates at 06:00). */
function lastNDatesBeforeToday(date: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n; i >= 1; i -= 1) {
    out.push(subtractDays(date, i));
  }
  return out;
}

/** Whether `memberId`'s day on `date` "qualifies" for the streak (something scheduled AND every
 * scheduled chore completed) — the same predicate `routines`' own `getStreak` walk uses
 * internally, re-derived here from `getBoard`'s already-public per-day chore composition since no
 * barrel-exported primitive answers this directly for an arbitrary historical date. */
function qualifies(memberId: string, date: string): boolean {
  const column = getBoard(date).find((c) => c.memberId === memberId);
  if (!column) return false;
  const chores = column.dayPeriods.flatMap((dp) => dp.chores);
  if (chores.length === 0) return false;
  return chores.every((c) => c.completed);
}

export const streakBlock = {
  type: TYPE,
  scope: "member" as const,
  source: "src/server/modules/routines getBoard (host-api-barrel-exported, 010 precedent)",
  generate(ctx: StreakBlockContext): StreakBlockData | null {
    const todayColumn = getBoard(ctx.date).find((c) => c.memberId === ctx.memberId);
    if (!todayColumn) return null; // not an active child tracked by routines at all

    const dates = lastNDatesBeforeToday(ctx.date, 7);
    const last7 = dates.map((d) => qualifies(ctx.memberId, d));

    const days = todayColumn.streak ?? 0;
    const streakLabels = getLabels(ctx.language).streak;
    const label = days === 0 ? streakLabels.startToday : streakLabels.daysStrong(days);
    return { days, label, last7 };
  },
};
