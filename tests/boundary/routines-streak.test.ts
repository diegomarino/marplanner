import { describe, it, expect } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getStreak } from "../../src/server/modules/routines/index";
import { useIsolatedDb } from "../helpers/db";

/** / — US3 streak-algorithm unit tests (streak in isolation, no HTTP layer).
 * Covers: FR-012/013/014; ROUTINES-CHORES-INV-06/09, ROUTINES-CHORES-AC-04.
 * - Transparent day (nothing scheduled) neither breaks nor extends the streak.
 * - In-progress "today" does not break the run through the prior qualifying day and
 * does not itself count until fully complete.
 * - Recomputing after a routine behind the streak is soft-deleted drops affected days.
 * - Zero completion history and "no routine ever configured" both return 0, never
 * null/undefined/throw — and the latter proves the walk is BOUNDED (terminates).
 */
describe("routines-streak unit tests (US3)", () => {
  useIsolatedDb();

  // ── date helpers (mirror src/server/lib/household-date.ts's timezone-invariant
  // weekday derivation, so these tests are correct regardless of which real
  // calendar day they run on) ────────────────────────────────────────────────

  function todayHouseholdDate(): string {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const day = parts.find((p) => p.type === "day")!.value;
    return `${year}-${month}-${day}`;
  }

  function weekdayOfDate(dateStr: string): string {
    const [y, m, d] = dateStr.split("-").map(Number);
    const instant = new Date(Date.UTC(y, m - 1, d));
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });
    return formatter.format(instant).substring(0, 3).toLowerCase();
  }

  function addDays(dateStr: string, delta: number): string {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function epochMsFor(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  // ── seed helpers (direct DB inserts, same pattern as routines-board.test.ts) ──

  function seedMember(createdAtDate: string) {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = epochMsFor(createdAtDate);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(id, `Test child ${id.slice(0, 4)}`, now, now);
    return id;
  }

  function seedDayPeriod() {
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO day_periods (id, label_key, start_minutes, sort_order) VALUES ('morning', 'dayPeriod.morning', 300, 0)"
    ).run();
  }

  function seedRoutine() {
    const db = getDb();
    const routineId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES (?, 'morning', 'Test Routine', 1, ?, ?)"
    ).run(routineId, now, now);
    return routineId;
  }

  function softDeleteRoutine(routineId: string) {
    const db = getDb();
    db.prepare("UPDATE routines SET active = 0 WHERE id = ?").run(routineId);
  }

  function seedChore(routineId: string) {
    const db = getDb();
    const choreId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, 'Task', 0, 1, ?, ?)"
    ).run(choreId, routineId, now, now);
    return choreId;
  }

  function seedAssignment(routineId: string, memberId: string, weekdays: string[]) {
    const db = getDb();
    const assignmentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
    ).run(assignmentId, routineId, memberId, JSON.stringify(weekdays), now, now);
  }

  function seedCompletion(choreId: string, memberId: string, date: string) {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, choreId, memberId, date, Date.now());
  }

  // ── tests ────────────────────────────────────────────────────────────────

  it("zero completion history ⇒ streak 0 (never null/undefined/throw) — the empty-walk base case", () => {
    const today = todayHouseholdDate();
    const memberId = seedMember(addDays(today, -30));
    seedDayPeriod();
    const routineId = seedRoutine();
    seedChore(routineId);
    // Assignment covers today's weekday, but NO completion was ever recorded.
    seedAssignment(routineId, memberId, [weekdayOfDate(today)]);

    const streak = getStreak(memberId, today);
    expect(streak).toBe(0);
  });

  it("a child with NO routine ever configured terminates the walk and returns 0 (bounded lookback)", () => {
    const today = todayHouseholdDate();
    // Member created ~a year ago; every day since is transparent (no routine ever
    // configured) — an unbounded walk would never stop, but the created_at bound
    // must terminate it.
    const memberId = seedMember(addDays(today, -400));

    const streak = getStreak(memberId, today);
    expect(streak).toBe(0);
  });

  it("transparent day (nothing scheduled) neither breaks nor extends the streak", () => {
    const today = todayHouseholdDate();
    const dayMinus2 = addDays(today, -2);
    // dayMinus1 (addDays(today, -1)) is the transparent middle day: deliberately
    // left out of the assignment's weekdays below, so it has zero scheduled chores.

    const memberId = seedMember(addDays(today, -30));
    seedDayPeriod();
    const routineId = seedRoutine();
    const choreId = seedChore(routineId);
    // Assignment covers dayMinus2 and today's weekdays, but deliberately NOT
    // dayMinus1's weekday — that day has zero scheduled chores (transparent).
    seedAssignment(routineId, memberId, [weekdayOfDate(dayMinus2), weekdayOfDate(today)]);

    seedCompletion(choreId, memberId, dayMinus2);
    seedCompletion(choreId, memberId, today);

    const streak = getStreak(memberId, today);
    expect(streak).toBe(2);
  });

  it('in-progress "today" does not break the run through the prior qualifying day and does not count today', () => {
    const today = todayHouseholdDate();
    const yesterday = addDays(today, -1);

    const memberId = seedMember(addDays(today, -30));
    seedDayPeriod();
    const routineId = seedRoutine();
    const choreId = seedChore(routineId);
    seedAssignment(routineId, memberId, [weekdayOfDate(yesterday), weekdayOfDate(today)]);

    // Yesterday fully complete; today scheduled but still incomplete.
    seedCompletion(choreId, memberId, yesterday);

    const streak = getStreak(memberId, today);
    expect(streak).toBe(1);
  });

  it("completing today's last scheduled chore makes today qualify (streak includes it)", () => {
    const today = todayHouseholdDate();
    const yesterday = addDays(today, -1);

    const memberId = seedMember(addDays(today, -30));
    seedDayPeriod();
    const routineId = seedRoutine();
    const choreId = seedChore(routineId);
    seedAssignment(routineId, memberId, [weekdayOfDate(yesterday), weekdayOfDate(today)]);

    seedCompletion(choreId, memberId, yesterday);
    seedCompletion(choreId, memberId, today);

    const streak = getStreak(memberId, today);
    expect(streak).toBe(2);
  });

  it("soft-deleting a routine behind an established streak drops the affected day on recompute", () => {
    const today = todayHouseholdDate();
    const yesterday = addDays(today, -1);

    const memberId = seedMember(addDays(today, -30));
    seedDayPeriod();

    // routineA covers only yesterday's weekday; routineB covers only today's.
    const routineA = seedRoutine();
    const choreA = seedChore(routineA);
    seedAssignment(routineA, memberId, [weekdayOfDate(yesterday)]);

    const routineB = seedRoutine();
    const choreB = seedChore(routineB);
    seedAssignment(routineB, memberId, [weekdayOfDate(today)]);

    seedCompletion(choreA, memberId, yesterday);
    seedCompletion(choreB, memberId, today);

    expect(getStreak(memberId, today)).toBe(2);

    // Soft-delete routineB — today's ONLY scheduled chore now comes from an
    // inactive routine, so today becomes transparent (not qualifying) and drops
    // out of the live streak; yesterday (routineA, still active) still qualifies.
    softDeleteRoutine(routineB);

    expect(getStreak(memberId, today)).toBe(1);
  });
});
