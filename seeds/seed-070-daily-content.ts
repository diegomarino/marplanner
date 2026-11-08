import { validateWeekdays } from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";
import { readWeekStartDay } from "../src/server/lib/household-date";
import { ALL_BLOCK_TYPES } from "../src/server/modules/daily-briefing/corpora/block-types";

const DAILY_MESSAGES = [
  {
    memberId: "demo:member:bart",
    dateOffset: -1,
    text: "Return the library book after school.",
  },
  {
    memberId: "demo:member:bart",
    dateOffset: 0,
    text: "Bring your skateboard after school.",
  },
  {
    memberId: "demo:member:bart",
    dateOffset: 1,
    text: "Science project materials are ready for tomorrow.",
  },
  {
    memberId: "demo:member:homer",
    dateOffset: 0,
    text: "Remember: family game night starts after dinner.",
  },
  {
    memberId: "demo:member:lisa",
    dateOffset: 0,
    text: "Practice one new song before screen time.",
  },
] as const;

/**
 * Week-relative messages: keys are day offsets from the first day of the current household week
 * (-7..-1 previous week, 0..6 current week, 7..13 next week). The asOfDate-relative messages
 * above win when both target the same member and date.
 */
const WEEK_MESSAGES: Record<string, Record<number, string>> = {
  "demo:member:bart": {
    [-6]: "Hand in the overdue book report.",
    [-4]: "No skateboarding in the school hallway.",
    [-2]: "Isotopes road trip! Bring your foam finger.",
    0: "Apologize to Principal Skinner for the whoopee cushion.",
    1: "Detention after school. Bring chalk for your lines.",
    2: "Feed Santa's Little Helper before school.",
    3: "Krusty taping at 5. Don't be late!",
    4: "Spelling quiz today: study 'embiggen' and 'cromulent'.",
    5: "Chili cook-off today. Stay away from the extra-hot peppers!",
    6: "Wear your Sunday shirt for church.",
    7: "Picture day: comb your hair. Yes, really.",
    9: "Lisa's recital tonight. Clap at the end, not during.",
    11: "Field trip: bring the signed permission slip.",
  },
  "demo:member:lisa": {
    [-7]: "Return the library books on jazz history.",
    [-5]: "Science club: bring your notebook.",
    [-3]: "Practice the new Bleeding Gums Murphy solo.",
    0: "Junior Campers meeting at 6.",
    1: "Saxophone practice at 6. Warm up first!",
    2: "Your vegetarian lunch is in the blue box.",
    3: "Krusty taping at 5 with Bart.",
    4: "Reading club book: chapters 4 to 6.",
    5: "Ask Mr. Flanders if Maggie can visit again.",
    6: "Help Mom bake pretzels for the barbecue.",
    8: "Final recital rehearsal after school.",
    9: "Recital tonight at 7. You've got this!",
    11: "Field trip: bring a notebook for the museum.",
  },
  "demo:member:homer": {
    [-6]: "Parent-teacher night at 7. Wear a tie.",
    [-3]: "Check your radiation badge before the shift.",
    0: "Bowling shoes are in the trunk.",
    1: "Don't forget to fix the garage door.",
    2: "Bowling league tonight at Barney's Bowlarama.",
    3: "Mr. Burns wants the safety report on his desk.",
    4: "Trivia night at Moe's. Study the state capitals!",
    5: "Chili cook-off: go easy on the hot peppers.",
    6: "Barbecue at Ned's. Be neighborly!",
    8: "Safety inspection at 10. Tidy up your console.",
    10: "Buy flowers for Marge.",
    12: "Anniversary dinner at 8. The reservation is under Simpson.",
  },
  "demo:member:marge": {
    [-5]: "Pick up the dry cleaning.",
    [-2]: "Pack snacks for the Isotopes trip.",
    0: "Painting class at 10.",
    1: "Kwik-E-Mart run: milk, bread and Krusty-O's.",
    2: "Book club tonight at 7:30.",
    3: "Call Patty and Selma about Sunday.",
    4: "Maggie's baby gym at 10:30.",
    5: "Playdate at the Flanders' at 10.",
    6: "Bring the pretzels to the barbecue.",
    7: "Iron the kids' picture day outfits.",
    9: "Lisa's recital at 7. Bring the camera.",
    13: "Grampa's birthday lunch at 1.",
  },
  "demo:member:maggie": {
    [-4]: "Mr. Honey Bunny needs a bath.",
    0: "Nap time after lunch.",
    2: "Stacking blocks with Mom.",
    4: "Baby gym at 10:30!",
    6: "Church with the whole family.",
    10: "New pacifier day!",
  },
};

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

type SeedMessage = { id: string; memberId: string; date: string; text: string };

/** Deterministic rolling messages for the previous, current and next household weeks. */
export function buildDailyMessages(asOfDate: string, weekStartDay: number): SeedMessage[] {
  const weekday = new Date(`${asOfDate}T00:00:00Z`).getUTCDay();
  const weekStart = addDays(asOfDate, -((weekday - weekStartDay + 7) % 7));
  const byKey = new Map<string, SeedMessage>();
  const put = (memberId: string, date: string, text: string) => {
    const id = `demo:daily-message:${memberId.slice("demo:member:".length)}:${date}`;
    byKey.set(id, { id, memberId, date, text });
  };
  for (const [memberId, messages] of Object.entries(WEEK_MESSAGES)) {
    for (const [offset, text] of Object.entries(messages)) {
      put(memberId, addDays(weekStart, Number(offset)), text);
    }
  }
  for (const message of DAILY_MESSAGES) {
    put(message.memberId, addDays(asOfDate, message.dateOffset), message.text);
  }
  return [...byKey.values()].sort((left, right) => left.id.localeCompare(right.id));
}

const BRIEFING_OPT_INS = [
  { memberId: "demo:member:bart", enabled: false },
  { memberId: "demo:member:homer", enabled: true },
  { memberId: "demo:member:lisa", enabled: true },
  { memberId: "demo:member:maggie", enabled: false },
  { memberId: "demo:member:marge", enabled: true },
] as const;

const BRIEFING_BLOCK_ORDER = ALL_BLOCK_TYPES.map((type) =>
  type === "dadJoke" ? { type, params: { difficulty: "easy" } } : { type }
);

const MEMBER_BLOCK_SETTINGS = [
  {
    memberId: "demo:member:bart",
    blockType: "dadJoke",
    enabled: false,
    weekdays: [],
    params: { difficulty: "easy" },
  },
  {
    memberId: "demo:member:homer",
    blockType: "message",
    enabled: true,
    weekdays: null,
    params: null,
  },
  {
    memberId: "demo:member:lisa",
    blockType: "message",
    enabled: true,
    weekdays: null,
    params: null,
  },
  // Default-off blocks are switched on for opted-in members so the demo shows every block.
  ...(["onThisDay", "firstWords"] as const).flatMap((blockType) =>
    BRIEFING_OPT_INS.filter(({ enabled }) => enabled).map(({ memberId }) => ({
      memberId,
      blockType,
      enabled: true,
      weekdays: null,
      params: null,
    }))
  ),
] as const;

/**
 * Public demo content for Daily Messages and Daily Briefing settings.
 *
 * These writes use the canonical tables directly so seed-owned IDs and timestamps remain stable;
 * the generic authoring helpers intentionally allocate random IDs or read Date.now. The
 * corresponding public/domain reads remain the verification boundary for this seed.
 */
const seedDailyContent: SeedModule = {
  id: "daily:content:demo",
  run({ db, asOfDate, nowMs }) {
    const upsertMessage = db.prepare(
      `INSERT INTO daily_messages (id, member_id, date, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id, date) DO UPDATE SET
         id = excluded.id,
         text = excluded.text,
         updated_at = excluded.updated_at
       WHERE id IS NOT excluded.id
          OR text IS NOT excluded.text`
    );
    const messages = buildDailyMessages(asOfDate, readWeekStartDay());
    const keep = new Set(messages.map((message) => message.id));
    const removeStale = db.prepare("DELETE FROM daily_messages WHERE id = ?");
    const seedOwned = db
      .prepare("SELECT id FROM daily_messages WHERE id GLOB 'demo:daily-message:*'")
      .all() as { id: string }[];
    for (const { id } of seedOwned) {
      if (!keep.has(id)) removeStale.run(id);
    }
    for (const message of messages) {
      upsertMessage.run(message.id, message.memberId, message.date, message.text, nowMs, nowMs);
    }

    const upsertOptIn = db.prepare(
      `INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at
       WHERE enabled IS NOT excluded.enabled`
    );
    for (const optIn of BRIEFING_OPT_INS) {
      upsertOptIn.run(optIn.memberId, optIn.enabled ? 1 : 0, nowMs, nowMs);
    }

    const orderJson = JSON.stringify(BRIEFING_BLOCK_ORDER);
    db.prepare(
      `INSERT INTO daily_briefing_block_order (id, order_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         order_json = excluded.order_json,
         updated_at = excluded.updated_at
       WHERE order_json IS NOT excluded.order_json`
    ).run(orderJson, nowMs);

    db.prepare(
      `INSERT INTO daily_briefing_settings (id, generation_time, auto_print_trigger, updated_at)
       VALUES (1, '06:30', 'morning_complete', ?)
       ON CONFLICT(id) DO UPDATE SET
         generation_time = excluded.generation_time,
         auto_print_trigger = excluded.auto_print_trigger,
         updated_at = excluded.updated_at
       WHERE generation_time IS NOT excluded.generation_time
          OR auto_print_trigger IS NOT excluded.auto_print_trigger`
    ).run(nowMs);

    const upsertMemberBlockSettings = db.prepare(
      `INSERT INTO daily_briefing_member_block_settings
         (member_id, block_type, enabled, weekdays, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id, block_type) DO UPDATE SET
         enabled = excluded.enabled,
         weekdays = excluded.weekdays,
         params = excluded.params,
         updated_at = excluded.updated_at
       WHERE enabled IS NOT excluded.enabled
          OR weekdays IS NOT excluded.weekdays
          OR params IS NOT excluded.params`
    );
    for (const setting of MEMBER_BLOCK_SETTINGS) {
      upsertMemberBlockSettings.run(
        setting.memberId,
        setting.blockType,
        setting.enabled ? 1 : 0,
        setting.weekdays === null ? null : JSON.stringify(validateWeekdays(setting.weekdays)),
        setting.params === null ? null : JSON.stringify(setting.params),
        nowMs,
        nowMs
      );
    }
  },
};

export default seedDailyContent;
