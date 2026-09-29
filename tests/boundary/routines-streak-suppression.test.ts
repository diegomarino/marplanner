import { describe, it, expect, vi, afterEach } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** / — board today-only streak/todayProgress suppression boundary test.
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Covers: FR-014; ROUTINES-CHORES-INV-09.
 * - GET.../board?date=<today> returns NUMERIC streak/todayProgress for a column
 * with history.
 * - GET.../board?date=<any OTHER date> returns streak:null AND todayProgress:null
 * for EVERY column, even one with rich history — suppression is server-side.
 */
describe("routines-streak-suppression boundary tests (T018/T019 — US3)", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── date helpers (mirror src/server/lib/household-date.ts) ────────────────

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

  // ── seed helpers ─────────────────────────────────────────────────────────

  function seedKeys() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, hashKey(deviceKey), now);
    return { deviceKey };
  }

  function seedDayPeriods() {
    const db = getDb();
    const periods = [
      { id: "morning", labelKey: "dayPeriod.morning", startMinutes: 300, sortOrder: 0 },
      { id: "afternoon", labelKey: "dayPeriod.afternoon", startMinutes: 720, sortOrder: 1 },
      { id: "evening", labelKey: "dayPeriod.evening", startMinutes: 1080, sortOrder: 2 },
      { id: "night", labelKey: "dayPeriod.night", startMinutes: 1260, sortOrder: 3 },
    ];
    for (const p of periods) {
      db.prepare(
        "INSERT OR IGNORE INTO day_periods (id, label_key, start_minutes, sort_order) VALUES (?, ?, ?, ?)"
      ).run(p.id, p.labelKey, p.startMinutes, p.sortOrder);
    }
  }

  function seedMember(createdAtDate: string) {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = epochMsFor(createdAtDate);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(id, `Test child ${id.slice(0, 4)}`, now, now);
    return id;
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

  function seedRichHistory(today: string) {
    const yesterday = addDays(today, -1);
    const memberId = seedMember(addDays(today, -30));
    const routineId = seedRoutine();
    const choreId = seedChore(routineId);
    seedAssignment(routineId, memberId, [weekdayOfDate(yesterday), weekdayOfDate(today)]);
    seedCompletion(choreId, memberId, yesterday);
    seedCompletion(choreId, memberId, today);
    return memberId;
  }

  // ── tests ────────────────────────────────────────────────────────────────

  it("GET board?date=<today> returns numeric streak/todayProgress for a column with history", async () => {
    // Freeze "today" for the whole test so the test's todayHouseholdDate
    // and the handler's internal Date.now-derived isToday agree
    // deterministically, even across a real-clock midnight rollover.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const { deviceKey } = seedKeys();
    seedDayPeriods();
    const today = todayHouseholdDate();
    const memberId = seedRichHistory(today);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/chores/board?date=${today}`,
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      memberId: string;
      streak: number | null;
      todayProgress: { completed: number; total: number } | null;
    }>;

    const column = body.find((c) => c.memberId === memberId)!;
    expect(column.streak).not.toBeNull();
    expect(typeof column.streak).toBe("number");
    expect(column.streak).toBe(2);
    expect(column.todayProgress).not.toBeNull();
    expect(column.todayProgress).toEqual({ completed: 1, total: 1 });
  });

  it("GET board?date=<any OTHER date> returns streak:null and todayProgress:null for EVERY column, even with rich history", async () => {
    // Freeze "today" for the whole test — see rationale above.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const { deviceKey } = seedKeys();
    seedDayPeriods();
    const today = todayHouseholdDate();
    const yesterday = addDays(today, -1);
    seedRichHistory(today);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/chores/board?date=${yesterday}`,
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      streak: number | null;
      todayProgress: { completed: number; total: number } | null;
    }>;

    expect(body.length).toBeGreaterThan(0);
    for (const column of body) {
      expect(column.streak).toBeNull();
      expect(column.todayProgress).toBeNull();
    }
  });
});
