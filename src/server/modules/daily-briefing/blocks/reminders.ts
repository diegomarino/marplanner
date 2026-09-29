/** "reminders" domain block ("The 21 block types", FR-013). PORTED
 * from v1 `apps/api/src/lib/daily-briefing/blocks/reminders.ts` (weekday-scheduled + calendar-
 * matched reminder text for the day), re-sourced against v2's ALREADY-BUILT reminders domain.
 * v1 hand-rolled its own NFD diacritic-insensitive `calendarMatch` substring test against raw
 * `reminderRules`/`reminderRuleMembers`/`events` tables. v2's reminders domain has since grown a
 * richer, ALREADY-DIACRITIC-INSENSITIVE equivalent: `getReminders(memberId, date)`
 * (`src/server/modules/reminders`, host-api-barrel-exported — the SAME function 010's own
 * `gatherBlocks` already calls for its "reminders" block) resolves BOTH `scheduled`
 * (weekday-gated) and `calendar_gated` rules internally; the calendar_gated gate calls
 * `getEvents({query, queryFields,...})`, whose own matching (`calendar/index.ts`'s * `normalizeForMatch`) already does `.normalize("NFD").replace(\p{Diacritic}/gu, "")` — the exact
 * v1 recipe this module was briefed to port. Re-implementing that matching here would DUPLICATE
 * (and risk diverging from) the reminders domain's own already-correct gate, so this block is a
 * thin wrapper: call `getReminders`, wrap each emission into the envelope v2 "reminders" shape.
 * Two v1 features have NO v2 equivalent to port, by construction of the v2 reminder schema
 * (`design/contracts` + `src/server/db/schema.ts`'s `reminder`/`reminder_assignment` tables carry
 * no time-of-day or priority columns at all):
 * - v1 could attach a matched event's start/end time as a bold-prefixed range (`id` field on the
 * rendered list item) and sort timed entries separately; v2's `ReminderEmission` is a bare
 * `{id, text}` with no time data, so every item here is untimed (v1's own untimed branch).
 * - v1 sorted untimed items by a per-rule `priority` (desc); v2 rules have no priority field, so
 * this block preserves `getReminders`' own return order (scheduled apply-to-all, then
 * specific, then calendar-gated apply-to-all, then calendar-gated specific).
 */
import { getReminders } from "../../../host-api";

const TYPE = "reminders";

export interface RemindersBlockContext {
  memberId: string;
  date: string;
}

export interface RemindersBlockItem {
  value: string;
}

export interface RemindersBlockGroup {
  items: RemindersBlockItem[];
}

export interface RemindersBlockData {
  groups: RemindersBlockGroup[];
}

export const remindersBlock = {
  type: TYPE,
  scope: "member" as const,
  source:
    "src/server/modules/reminders getReminders (host-api-barrel-exported, 010 precedent — already NFD-diacritic-insensitive calendar_gated matching via getEvents' normalizeForMatch)",
  async generate(ctx: RemindersBlockContext): Promise<RemindersBlockData | null> {
    const emissions = getReminders(ctx.memberId, ctx.date);
    if (emissions.length === 0) return null;
    return { groups: [{ items: emissions.map((e) => ({ value: e.text })) }] };
  },
};
