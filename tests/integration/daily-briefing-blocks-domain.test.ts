import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { adaptBlockData } from "../../src/server/modules/daily-briefing/render/adapter";
import { messageBlock } from "../../src/server/modules/daily-briefing/blocks/message";
import { messageBlock as messageRenderDef } from "../../src/server/modules/daily-briefing/render/blocks/message";
import { shotgunBlock } from "../../src/server/modules/daily-briefing/blocks/shotgun";
import { streakBlock } from "../../src/server/modules/daily-briefing/blocks/streak";
import { streakTextBlock } from "../../src/server/modules/daily-briefing/blocks/streak-text";
import { todayBlock } from "../../src/server/modules/daily-briefing/blocks/today";
import { mealsBlock } from "../../src/server/modules/daily-briefing/blocks/meals";
import { birthdayBlock } from "../../src/server/modules/daily-briefing/blocks/birthday";
import { remindersBlock } from "../../src/server/modules/daily-briefing/blocks/reminders";
import { writeMemberBlockSettings } from "../../src/server/modules/daily-briefing/settings";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/daily-briefing.md — the DOMAIN block generators (FR-013):
 * shotgun, message, streak, today, meals, birthday, reminders, streakText. Each test seeds real
 * rows in the isolated SQLite database and calls the generator DIRECTLY (wires the registry
 * later — trap-sweep.md). Every block's output is additionally piped through the
 * render adapter (`adaptBlockData`) to prove render-compatibility (envelope v2
 * block shapes) without importing anything from `render/* ` other than that pure, already-merged
 * function.
 */
describe("daily-briefing domain blocks (FR-013)", () => {
  useIsolatedDb();

  const DATE = "2026-08-21"; // Friday
  const NOW_MADRID = new Date("2026-08-21T10:00:00.000Z").getTime(); // 12:00 Europe/Madrid (default tz)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MADRID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedMember(id: string, displayName = id, role: "child" | "parent" = "child"): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
      )
      .run(id, displayName, role, now, now);
  }

  function setHouseholdTimezone(tz: string): void {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
      )
      .run(JSON.stringify({ timezone: tz }), Date.now());
  }

  // ── message ─────────────────────────────────────────────────────────────────

  describe("message", () => {
    /** DAILY-MESSAGES-AC-07 fold: "Text stored verbatim; emoji/wrapping handled
     * at render" — the GENERATOR must freeze the snapshot RAW, never sanitizing it. Asserts the
     * emoji survives generation verbatim, and that the adapter (the render-path boundary) accepts
     * the raw, un-stripped text unchanged.
     */
    it("preserves the injected daily-message's text VERBATIM (emojis included) at generation, adapter-compatible (FR-013, AC-07)", async () => {
      const result = messageBlock.generate({
        memberId: "m1",
        date: DATE,
        readDailyMessage: () => ({ text: "Have a wonderful day! 🎉" }),
      });
      expect(result).toEqual({ text: "Have a wonderful day! 🎉" });
      expect(adaptBlockData("message", result)).toEqual({ text: "Have a wonderful day! 🎉" });
    });

    it("returns null (no block) when no port is injected — the current unwired production state", async () => {
      const result = messageBlock.generate({ memberId: "m1", date: DATE });
      expect(result).toBeNull();
    });

    it("returns null ONLY when no message row exists for the date — never because the text is empty/emoji-only (AC-07)", async () => {
      const result = messageBlock.generate({
        memberId: "m1",
        date: DATE,
        readDailyMessage: () => null,
      });
      expect(result).toBeNull();
    });

    /** AC-07's core point: an EXISTING message always yields a block, regardless of what
     * render-time sanitization would do to its content. Before this generation stripped
     * emojis and an all-emoji message collapsed to an empty string -> null (no block) — exactly
     * the AC-07 violation flagged.
     */
    it("an emoji-only message still yields a block, with the raw (unstripped) text in the snapshot (AC-07)", async () => {
      const result = messageBlock.generate({
        memberId: "m1",
        date: DATE,
        readDailyMessage: () => ({ text: "🎉🎊" }),
      });
      expect(result).not.toBeNull();
      expect(result).toEqual({ text: "🎉🎊" });
    });

    /** The emoji strip lives at RENDER time (the print-layer render-def), not generation — proves
     * it fired there instead of merely asserting it did NOT fire at generation (the tests above).
     * An emoji-only message's rendered body is a BLANK string, not an absent block: the
     * `BlockDefinition` itself still exists and renders (a `<div>` with empty children), matching
     * AC-07's "an existing message always yields a block".
     */
    it("the message render-def strips emojis for print, leaving a blank (but present) rendered body for an emoji-only message", () => {
      // `ctx` (pressedslip's RenderContext) is unused by this render-def — a real one requires a
      // full composition/theme/logger; stub it since only `data` drives this block's output.
      const stubCtx = {} as Parameters<typeof messageRenderDef.render>[0]["ctx"];

      const rendered = messageRenderDef.render({ data: { text: "🎉🎊" }, ctx: stubCtx });
      expect((rendered?.props as { children: string } | undefined)?.children).toBe("");

      const renderedMixed = messageRenderDef.render({
        data: { text: "Have a wonderful day! 🎉" },
        ctx: stubCtx,
      });
      expect((renderedMixed?.props as { children: string } | undefined)?.children).toBe(
        "Have a wonderful day!"
      );
    });
  });

  // ── shotgun ─────────────────────────────────────────────────────────────────

  describe("shotgun", () => {
    const members = [
      { id: "s1", displayName: "Alice" },
      { id: "s2", displayName: "Bob" },
      { id: "s3", displayName: "Cleo" },
      { id: "s4", displayName: "Dee" },
      { id: "s5", displayName: "Eve" },
    ];

    it("ranks opted-in active members, cap 4, deterministic for the same date, adapter-compatible (FR-013)", async () => {
      const ctx = { date: DATE, listActiveMembers: () => members };
      const first = shotgunBlock.generate(ctx);
      const second = shotgunBlock.generate(ctx);
      expect(first).not.toBeNull();
      expect(first?.ranking.length).toBe(4);
      // Determinism: same date -> same selection AND order.
      expect(second).toEqual(first);
      expect(() => adaptBlockData("shotgun", first)).not.toThrow();
    });

    it("excludes a member explicitly disabled for shotgun via daily-briefing settings", async () => {
      // writeMemberBlockSettings strict-writes against an ACTIVE member (assertActiveMember) —
      // seed the real row so the settings write itself isn't what's under test here.
      seedMember("s1", "Alice");
      writeMemberBlockSettings("s1", "shotgun", { enabled: false });
      const result = shotgunBlock.generate({ date: DATE, listActiveMembers: () => members });
      expect(result?.ranking).not.toContain("Alice");
    });

    it("excludes a member whose shotgun weekdays mask does not include the date's weekday", async () => {
      // DATE (2026-08-21) is a Friday ("fri"); restrict s2 to Mondays only.
      seedMember("s2", "Bob");
      writeMemberBlockSettings("s2", "shotgun", { weekdays: ["mon"] });
      const result = shotgunBlock.generate({ date: DATE, listActiveMembers: () => members });
      expect(result?.ranking).not.toContain("Bob");
    });

    it("returns null when no member-listing port is injected (host-api gap — see module doc)", async () => {
      const result = shotgunBlock.generate({ date: DATE });
      expect(result).toBeNull();
    });
  });

  // ── streak / streakText ──────────────────────────────────────────────────────

  describe("streak + streakText (delegate)", () => {
    const memberId = "streak-member";

    function seedRoutineWithChore(): { routineId: string; choreId: string } {
      const now = Date.now();
      const db = getDb();
      db.prepare(
        "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES ('routine-streak', 'morning', 'Morning jobs', 1, ?, ?)"
      ).run(now, now);
      db.prepare(
        "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES ('chore-streak', 'routine-streak', 'Make bed', 0, 1, ?, ?)"
      ).run(now, now);
      // 'fri' matches DATE and every lookback day used below (all Fridays, one week apart is NOT
      // used here — assignment applies to every weekday so completions alone gate "qualifying").
      db.prepare(
        'INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (\'assignment-streak\', \'routine-streak\', ?, \'["mon","tue","wed","thu","fri","sat","sun"]\', 1, ?, ?)'
      ).run(memberId, now, now);
      return { routineId: "routine-streak", choreId: "chore-streak" };
    }

    function completeChoreOn(choreId: string, date: string): void {
      const now = Date.now();
      getDb()
        .prepare(
          "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(`completion-${date}`, choreId, memberId, date, now);
    }

    it("returns null for a member the routines board does not track at all (a parent, never a routines participant) (FR-013)", async () => {
      // getBoard enumerates every ACTIVE CHILD unconditionally (even with zero routines) — the
      // only member shape it never returns a column for is a non-child (or archived/unknown)
      // member, which is what this block's own "not tracked at all" gate actually guards against.
      seedMember(memberId, memberId, "parent");
      const result = streakBlock.generate({ memberId, date: DATE });
      expect(result).toBeNull();
    });

    it("computes last7 qualifying-day dots and today's streak count, adapter-compatible", async () => {
      // getStreak bounds its backward walk at the member's created_at date — seed it well before
      // the lookback window (not `seedMember`'s default `Date.now`, which would equal DATE and
      // make every historical day "before the member existed").
      getDb()
        .prepare(
          "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
        )
        .run(memberId, memberId, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1));
      const { choreId } = seedRoutineWithChore();

      // Complete the chore on the 3 days immediately before DATE (2026-08-18,19,20) but not on
      // the older 4 days — last7 (oldest..newest, excluding DATE itself) must reflect exactly that.
      completeChoreOn(choreId, "2026-08-18");
      completeChoreOn(choreId, "2026-08-19");
      completeChoreOn(choreId, "2026-08-20");

      // P1 fold addendum: `label` now resolves through `render/labels.ts#getLabels`
      // (DAILY-BRIEFING-INV-06) — pin "en" explicitly since this test's own subject is the
      // streak/last7 COMPUTATION, not the label's language (that's covered by dedicated
      // es/en label tests elsewhere).
      const result = streakBlock.generate({ memberId, date: DATE, language: "en" });
      expect(result).not.toBeNull();
      expect(result?.last7).toEqual([false, false, false, false, true, true, true]);
      // getStreak walks backward from DATE (not itself completed) through the 3 consecutive
      // qualifying days (08-18..08-20) and stops at the first incomplete day (08-17).
      expect(result?.days).toBe(3);
      expect(result?.label).toBe("3 days strong");
      expect(() => adaptBlockData("streak", result)).not.toThrow();

      // streakText is a pure delegate — identical data for the identical context (same "en" pin).
      const textResult = streakTextBlock.generate({ memberId, date: DATE, language: "en" });
      expect(textResult).toEqual(result);
      expect(() => adaptBlockData("streakText", textResult)).not.toThrow();
    });

    /** P1 fold addendum (DAILY-BRIEFING-INV-06): an "es" household resolves `label` in
     * Spanish — "racha" mirrors `src/client/i18n/messages.ts`'s existing
     * "chores.board.streakLabel" ("Racha:") vocabulary. Reuses the exact fixture above; only the
     * requested language differs. */
    it("an es household resolves the streak label in Spanish (Codex #709 P1 fold)", async () => {
      getDb()
        .prepare(
          "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
        )
        .run(memberId, memberId, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1));
      const { choreId } = seedRoutineWithChore();
      completeChoreOn(choreId, "2026-08-18");
      completeChoreOn(choreId, "2026-08-19");
      completeChoreOn(choreId, "2026-08-20");

      const result = streakBlock.generate({ memberId, date: DATE, language: "es" });
      expect(result?.days).toBe(3);
      expect(result?.label).toBe("3 días de racha");
    });
  });

  // ── today ───────────────────────────────────────────────────────────────────

  describe("today", () => {
    const memberId = "today-member";

    function seedEvent(opts: {
      id: string;
      title: string;
      allDay: boolean;
      startUtc?: string;
      endUtc?: string;
      tzid?: string;
      startDate?: string;
      endDate?: string;
    }): void {
      const now = Date.now();
      const db = getDb();
      if (opts.allDay) {
        db.prepare(
          "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES (?, 'local', ?, 1, ?, ?, ?, ?)"
        ).run(opts.id, opts.title, opts.startDate, opts.endDate, now, now);
      } else {
        db.prepare(
          "INSERT INTO calendar_events (id, source, title, all_day, start_utc, end_utc, tzid, created_at, updated_at) VALUES (?, 'local', ?, 0, ?, ?, ?, ?, ?)"
        ).run(opts.id, opts.title, opts.startUtc, opts.endUtc, opts.tzid, now, now);
      }
      db.prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      ).run(`assign-${opts.id}`, opts.id, memberId, now);
    }

    it("returns null when no events are assigned to the member that day", async () => {
      seedMember(memberId);
      const result = todayBlock.generate({ memberId, date: DATE });
      expect(result).toBeNull();
    });

    it("orders all-day events before timed events, truncates long bullets, adapter-compatible (FR-013)", async () => {
      seedMember(memberId);
      seedEvent({
        id: "timed-1",
        title: "Doctor appointment",
        allDay: false,
        startUtc: "2026-08-21T08:00:00.000Z", // 10:00 Europe/Madrid (summer, UTC+2)
        endUtc: "2026-08-21T09:00:00.000Z",
        tzid: "Europe/Madrid",
      });
      seedEvent({
        id: "allday-1",
        title:
          "A very long all-day event title that exceeds the thirty-six character bullet budget",
        allDay: true,
        startDate: DATE,
        endDate: "2026-08-22",
      });

      const result = todayBlock.generate({ memberId, date: DATE });
      expect(result).not.toBeNull();
      expect(result?.bullets.length).toBe(2);
      // All-day first, regardless of any time.
      expect(result?.bullets[0].length).toBeLessThanOrEqual(36);
      expect(result?.bullets[0].endsWith("…")).toBe(true);
      // Timed event second, prefixed with the household-tz-formatted time.
      expect(result?.bullets[1]).toMatch(/^10:00 Doctor appointment$/);
      expect(() => adaptBlockData("today", result)).not.toThrow();
    });

    /** (D1): the test above is adversarially WEAK — its timed event's UTC instant
     * (08:00Z) is already later than the all-day event's UTC-midnight parse (00:00Z), so a plain
     * occurrenceStart-time comparison with NO explicit "all-day always wins" branch would still
     * sort it correctly, by accident. This test seeds a timed event whose UTC instant
     * (2026-08-20T22:05:00.000Z) is BEFORE that UTC midnight — it is still local
     * 2026-08-21T00:05 in Europe/Madrid (UTC+2 in August), so it correctly belongs to DATE's today
     * block — and asserts the all-day bullet is `bullets[0]` BY IDENTITY (the exact expected
     * truncation, not merely "something short ending in an ellipsis"), so only the explicit
     * all-day-first RULE — not incidental UTC ordering — can make this pass.
     */
    it("keeps the all-day bullet first even when a timed event's UTC instant precedes the all-day event's UTC-midnight parse (FR-013, P1-2)", async () => {
      seedMember(memberId);
      seedEvent({
        id: "timed-early-utc",
        title: "Doctor appointment",
        allDay: false,
        startUtc: "2026-08-20T22:05:00.000Z", // 00:05 Europe/Madrid on 2026-08-21
        endUtc: "2026-08-20T23:00:00.000Z",
        tzid: "Europe/Madrid",
      });
      seedEvent({
        id: "allday-early-utc",
        title:
          "A very long all-day event title that exceeds the thirty-six character bullet budget",
        allDay: true,
        startDate: DATE,
        endDate: "2026-08-22",
      });

      const result = todayBlock.generate({ memberId, date: DATE });
      expect(result?.bullets[0]).toBe("A very long all-day event title tha…");
      expect(result?.bullets[1]).toMatch(/^00:05 Doctor appointment$/);
    });

    it("caps at 10 events", async () => {
      seedMember(memberId);
      for (let i = 0; i < 12; i += 1) {
        seedEvent({
          id: `cap-${i}`,
          title: `Event ${i}`,
          allDay: true,
          startDate: DATE,
          endDate: "2026-08-22",
        });
      }
      const result = todayBlock.generate({ memberId, date: DATE });
      expect(result?.bullets.length).toBe(10);
    });

    /** FR-013/FR-012 household-tz window test: an event at 23:30 LOCAL time in a timezone WEST of
     * UTC (America/New_York, UTC-4 in August) falls on the FOLLOWING UTC calendar day
     * (2026-08-22T03:30:00.000Z). A naive UTC-anchored day-bounds check (v1's `dayBounds`,
     * explicitly NOT ported per FR-012/) would exclude this event from "2026-08-21"the * today block, since its UTC instant lies outside `[2026-08-21T00:00Z, 2026-08-22T00:00Z)`.
     * `today.ts` never builds its own window — it delegates entirely to `getEvents`, which resolves
     * the window via household-timezone wall-clock math (`calendar/index.ts`'s * `buildExpandRange`/`wallClockToInstant`) — so the event must still land in TODAY's block.
     */
    it("places a 23:30-local event in TODAY's block even when its UTC instant falls on the next UTC day (FR-012)", async () => {
      setHouseholdTimezone("America/New_York");
      seedMember(memberId);
      seedEvent({
        id: "late-local",
        title: "Late night snack",
        allDay: false,
        startUtc: "2026-08-22T03:30:00.000Z", // 23:30 America/New_York on 2026-08-21 (EDT, UTC-4)
        endUtc: "2026-08-22T04:00:00.000Z",
        tzid: "America/New_York",
      });

      const result = todayBlock.generate({ memberId, date: DATE });
      expect(result).not.toBeNull();
      expect(result?.bullets).toEqual(["23:30 Late night snack"]);
    });
  });

  // ── meals ───────────────────────────────────────────────────────────────────

  describe("meals", () => {
    function seedOneOffMeal(slot: string, note: string, date = DATE, id?: string): void {
      const now = Date.now();
      getDb()
        .prepare(
          "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES (?, NULL, NULL, ?, ?, NULL, ?, ?)"
        )
        .run(id ?? `meal-${slot}-${date}`, date, slot, note, now);
    }

    it("returns null when nothing is planned that day", async () => {
      const result = mealsBlock.generate({ date: DATE });
      expect(result).toBeNull();
    });

    it("returns verbatim lunch/dinner lists when planned, omits snack, adapter-compatible (FR-013)", async () => {
      seedOneOffMeal("lunch", "Soup 🍲");
      seedOneOffMeal("dinner", "Pasta");

      const result = mealsBlock.generate({ date: DATE });
      expect(result).toEqual({
        lunch: [{ kind: "note", label: "Soup 🍲" }],
        dinner: [{ kind: "note", label: "Pasta" }],
      });
      expect(result).not.toHaveProperty("snack");
      expect(() => adaptBlockData("meals", result)).not.toThrow();
    });

    it("preserves ALL entries for a slot (N-per-slot) as lists in domain order, adapter-compatible (FR-013, AC-10)", async () => {
      seedOneOffMeal("lunch", "Soup", DATE, "meal-lunch-a");
      seedOneOffMeal("lunch", "Tacos", DATE, "meal-lunch-b");
      seedOneOffMeal("dinner", "Pasta");

      const result = mealsBlock.generate({ date: DATE });
      expect(result).toEqual({
        lunch: [
          { kind: "note", label: "Soup" },
          { kind: "note", label: "Tacos" },
        ],
        dinner: [{ kind: "note", label: "Pasta" }],
      });
      expect(() => adaptBlockData("meals", result)).not.toThrow();
    });

    it("preserves stale recipe references as structured tombstone entries", () => {
      const db = getDb();
      db.pragma("foreign_keys = OFF");
      try {
        db.prepare(
          "INSERT INTO meal_entries (id, entry_date, slot, recipe_id, created_at) VALUES ('stale', ?, 'dinner', 'missing-recipe', ?)"
        ).run(DATE, Date.now());
      } finally {
        db.pragma("foreign_keys = ON");
      }
      expect(mealsBlock.generate({ date: DATE })).toEqual({
        dinner: [{ kind: "recipe", label: "Deleted recipe" }],
      });
    });

    it("excludes breakfast (v1 parity — the envelope shape has no breakfast field)", async () => {
      seedOneOffMeal("breakfast", "Toast");
      const result = mealsBlock.generate({ date: DATE });
      expect(result).toBeNull();
    });
  });

  // ── birthday ────────────────────────────────────────────────────────────────

  describe("birthday", () => {
    it("returns null when no member-listing port is injected (host-api gap — see module doc)", async () => {
      const result = birthdayBlock.generate({ memberId: "b1", date: DATE });
      expect(result).toBeNull();
    });

    it("computes own + family days-until, leap-day Feb-29 -> Feb-28 substitution, sorted ascending, adapter-compatible (FR-013)", async () => {
      const listActiveMembers = () => [
        { id: "b1", displayName: "Self", birthDate: { month: 8, day: 25, year: 2015 } }, // 4 days away
        { id: "b2", displayName: "Sibling 🎈", birthDate: { month: 8, day: 23, year: 2018 } }, // 2 days away
        // 2026 is not a leap year — Feb 29 -> Feb 28 substitution; already passed this year (Feb),
        // so the NEXT occurrence lands in 2027 (also not a leap year) -> Feb 28, 2027.
        { id: "b3", displayName: "LeapDay", birthDate: { month: 2, day: 29, year: 2012 } },
        { id: "b4", displayName: "NoBirthday", birthDate: null },
      ];

      // P1 fold addendum: `ownLabel` now resolves through `render/labels.ts#getLabels`
      // (DAILY-BRIEFING-INV-06) — pin "en" explicitly since this test's own subject is the
      // days-until COMPUTATION, not the label's language (that's covered by dedicated es/en label
      // tests elsewhere).
      const result = birthdayBlock.generate({
        memberId: "b1",
        date: DATE,
        listActiveMembers,
        language: "en",
      });
      expect(result).not.toBeNull();
      expect(result?.daysUntilOwn).toBe(4);
      expect(result?.ownLabel).toBe("4 days to your birthday");
      expect(result?.family.map((f) => f.name)).toEqual(["Sibling", "LeapDay"]);
      expect(result?.family[0].daysUntil).toBe(2);
      expect(
        result?.family.every((f, i, arr) => i === 0 || arr[i - 1].daysUntil <= f.daysUntil)
      ).toBe(true);
      expect(() => adaptBlockData("birthday", result)).not.toThrow();
    });

    /** P1 fold addendum (DAILY-BRIEFING-INV-06): an "es" household resolves `ownLabel`
     * in Spanish, both the non-zero-days and the `daysUntilOwn === 0` branches. */
    it("an es household resolves ownLabel in Spanish, both branches (Codex #709 P1 fold)", async () => {
      const listActiveMembers = () => [
        { id: "b1", displayName: "Self", birthDate: { month: 8, day: 25, year: 2015 } }, // 4 days away
      ];
      const result = birthdayBlock.generate({
        memberId: "b1",
        date: DATE,
        listActiveMembers,
        language: "es",
      });
      expect(result?.ownLabel).toBe("Faltan 4 días para tu cumpleaños");

      const todayListActiveMembers = () => [
        { id: "b1", displayName: "Self", birthDate: { month: 8, day: 21, year: 2015 } }, // today
      ];
      const todayResult = birthdayBlock.generate({
        memberId: "b1",
        date: DATE,
        listActiveMembers: todayListActiveMembers,
        language: "es",
      });
      expect(todayResult?.ownLabel).toBe("FELIZ CUMPLEAÑOS");
    });

    /** (D1): "computes own + family days-until..." above only asserts LeapDay's NAME
     * and its position in the sorted order — dropping BOTH the "landing year not a leap year" and
     * the "substitute to Feb-28" logic simultaneously would still produce a value that sorts last
     * and keeps the same name, so it would pass undetected. This test asserts the EXACT computed
     * value.
     */
    it("computes the exact Feb-29 -> Feb-28 leap-day substituted days-until value (FR-013, P1-1)", async () => {
      const listActiveMembers = () => [
        { id: "b1", displayName: "Self", birthDate: null },
        // From 2026-08-21: 2026's Feb 29 already passed and doesn't exist (not a leap year), so
        // the next occurrence is 2027-02-28 (2027 is not a leap year either) — 191 days out
        // .
        { id: "b3", displayName: "LeapDay", birthDate: { month: 2, day: 29, year: 2012 } },
      ];

      const result = birthdayBlock.generate({
        memberId: "b1",
        date: DATE,
        listActiveMembers,
      });
      expect(result?.family.find((f) => f.name === "LeapDay")?.daysUntil).toBe(191);
    });

    it("emits HAPPY BIRTHDAY as the own label when daysUntilOwn is 0", async () => {
      const listActiveMembers = () => [
        { id: "b1", displayName: "Self", birthDate: { month: 8, day: 21, year: 2015 } },
      ];
      // P1 fold addendum: pin "en" explicitly (see the comment on the days-until test
      // above — this test's subject is the daysUntilOwn===0 branch, not the label's language).
      const result = birthdayBlock.generate({
        memberId: "b1",
        date: DATE,
        listActiveMembers,
        language: "en",
      });
      expect(result?.daysUntilOwn).toBe(0);
      expect(result?.ownLabel).toBe("HAPPY BIRTHDAY");
    });
  });

  // ── reminders ───────────────────────────────────────────────────────────────

  describe("reminders", () => {
    const memberId = "reminders-member";

    it("returns null when no reminder rule emits that day", async () => {
      seedMember(memberId);
      const result = remindersBlock.generate({ memberId, date: DATE });
      expect(result).toBeNull();
    });

    it("wraps a weekday-scheduled apply-to-all reminder into the envelope groups shape, adapter-compatible (FR-013)", async () => {
      seedMember(memberId);
      const now = Date.now();
      getDb()
        .prepare(
          `INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at)
           VALUES ('reminder-1', 'scheduled', 'apply_to_all', 'Pack the school bag', '["fri"]', 1, ?, ?)`
        )
        .run(now, now);

      const result = remindersBlock.generate({ memberId, date: DATE });
      expect(result).toEqual({ groups: [{ items: [{ value: "Pack the school bag" }] }] });
      expect(() => adaptBlockData("reminders", result)).not.toThrow();
    });

    /** FR-013's ported "NFD diacritic-insensitive match": v2's calendar_gated matching
     * (`calendar/index.ts#normalizeForMatch`, reached transitively via `getReminders`) already
     * implements this — the rule's query "Práctica" (with an accent) must match an event titled
     * "practica" (without one), proving the diacritic-insensitive path fires end-to-end through
     * this block, not just inside the reminders/calendar modules in isolation.
     */
    it("matches a calendar_gated reminder diacritic-insensitively via the real getEvents/getReminders seam", async () => {
      seedMember(memberId);
      const now = Date.now();
      const db = getDb();
      db.prepare(
        `INSERT INTO reminder (id, kind, targeting_mode, text, query, query_fields, active, created_at, updated_at)
         VALUES ('reminder-cg', 'calendar_gated', 'apply_to_all', 'Bring your kit', 'Práctica', '["title"]', 1, ?, ?)`
      ).run(now, now);
      db.prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES ('event-cg', 'local', 'practica de futbol', 1, ?, ?, ?, ?)"
      ).run(DATE, "2026-08-22", now, now);
      db.prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('assign-cg', 'event-cg', ?, ?)"
      ).run(memberId, now);

      const result = remindersBlock.generate({ memberId, date: DATE });
      expect(result).toEqual({ groups: [{ items: [{ value: "Bring your kit" }] }] });
    });
  });
});
