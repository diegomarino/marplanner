import { validateWeekdays } from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";
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

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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
  ...BRIEFING_OPT_INS.filter(({ enabled }) => enabled).map(({ memberId }) => ({
    memberId,
    blockType: "onThisDay",
    enabled: true,
    weekdays: null,
    params: null,
  })),
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
    for (const message of DAILY_MESSAGES) {
      const date = addDays(asOfDate, message.dateOffset);
      upsertMessage.run(
        `demo:daily-message:${message.memberId.slice("demo:member:".length)}:${date}`,
        message.memberId,
        date,
        message.text,
        nowMs,
        nowMs
      );
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
