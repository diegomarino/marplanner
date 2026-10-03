import { describe, it, expect, vi, afterEach } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** / — US1 board-read boundary tests.
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Covers: FR-002/003/017/018; INV-01/02/03, AC-05; DAY-PERIODS-AC-05; KIOSK-SHELL-NAVIGATION-INV-04.
 * - Only active children appear in board columns (archived excluded entirely)
 * - All four day periods always present per column
 * - Malformed/impossible date → 400
 * - Zero active children → 200 with empty array (not error)
 */
describe("routines-board boundary tests (US1)", () => {
  useIsolatedDb();

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  function seedKeys() {
    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, hashKey(bootstrapKey), now);
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, hashKey(deviceKey), now);
    return { bootstrapKey, deviceKey };
  }

  function seedDayPeriods() {
    const db = getDb();
    // Day periods are seeded by migration, so use INSERT OR IGNORE
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

  function seedMember(role: "parent" | "child", lifecycle: "active" | "archived" = "active") {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, `Test ${role} ${id.slice(0, 4)}`, role, lifecycle, now, now);
    return id;
  }

  function seedRoutine(dayPeriodId: string) {
    const db = getDb();
    const routineId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).run(routineId, dayPeriodId, "Test Routine", now, now);
    return routineId;
  }

  function seedChore(routineId: string, name: string) {
    const db = getDb();
    const choreId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    // Determine max sortOrder for this routine
    const maxSortOrder = (
      db
        .prepare("SELECT MAX(sort_order) as max FROM chores WHERE routine_id = ?")
        .get(routineId) as { max: number | null } | undefined
    )?.max;
    const sortOrder = (maxSortOrder ?? -1) + 1;

    db.prepare(
      "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
    ).run(choreId, routineId, name, sortOrder, now, now);
    return choreId;
  }

  function seedAssignment(routineId: string, memberId: string, weekdays: string[]) {
    const db = getDb();
    const assignmentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
    ).run(assignmentId, routineId, memberId, JSON.stringify(weekdays), now, now);
    return assignmentId;
  }
  function seedChoreCompletion(choreId: string, memberId: string, date: string) {
    const db = getDb();
    const completionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, ?, ?)"
    ).run(completionId, choreId, memberId, date, now);
  }

  // ── GET /api/chores/board?date=<date> ─────────────────────────────────────

  it("GET /api/chores/board?date=2026-08-12 (Wednesday) with assigned child → 200 with chore column", async () => {
    // Freeze "today" away from 2026-08-12 so the streak/todayProgress null
    // assertions below stay decoupled from the wall clock — populates
    // both fields once the requested date equals household-today, and this
    // hardcoded request date would otherwise become today's real date and
    // flip those assertions (fix).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T12:00:00.000Z"));

    const { deviceKey } = seedKeys();
    seedDayPeriods();

    // Seed an active child
    const memberId = seedMember("child", "active");

    // Create a routine in morning period with 2 chores
    const routineId = seedRoutine("morning");
    const chore1Id = seedChore(routineId, "Breakfast dishes");
    const chore2Id = seedChore(routineId, "Feed pet");

    // Assign routine to child on Wednesdays (weekdayOf("2026-08-12") = "wed")
    seedAssignment(routineId, memberId, ["wed"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // 2026-08-12 is a Wednesday
    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      memberId: string;
      displayName: string;
      dayPeriods: Array<{
        id: string;
        labelKey: string;
        chores: Array<{ id: string; name: string; completed: boolean }>;
      }>;
      streak: number | null;
      todayProgress: { completed: number; total: number } | null;
    }>;

    expect(body).toHaveLength(1);
    expect(body[0].memberId).toBe(memberId);
    expect(body[0].displayName).toMatch(/^Test child/);

    // All 4 day periods present
    expect(body[0].dayPeriods).toHaveLength(4);
    const periodIds = body[0].dayPeriods.map((p) => p.id);
    expect(periodIds).toContain("morning");
    expect(periodIds).toContain("afternoon");
    expect(periodIds).toContain("evening");
    expect(periodIds).toContain("night");

    // Morning has 2 chores, others empty
    const morning = body[0].dayPeriods.find((p) => p.id === "morning");
    expect(morning).toBeDefined();
    expect(morning!.chores).toHaveLength(2);
    expect(morning!.chores[0].id).toBe(chore1Id);
    expect(morning!.chores[0].name).toBe("Breakfast dishes");
    expect(morning!.chores[0].completed).toBe(false);
    expect(morning!.chores[1].id).toBe(chore2Id);
    expect(morning!.chores[1].name).toBe("Feed pet");
    expect(morning!.chores[1].completed).toBe(false);

    // Afternoon, evening, night have empty chore arrays
    expect(body[0].dayPeriods.find((p) => p.id === "afternoon")!.chores).toEqual([]);
    expect(body[0].dayPeriods.find((p) => p.id === "evening")!.chores).toEqual([]);
    expect(body[0].dayPeriods.find((p) => p.id === "night")!.chores).toEqual([]);

    // Requested date (2026-08-12) is not "today" (frozen to 2020-01-01 above),
    // so the board suppresses streak/todayProgress — both stay null (FR-014).
    expect(body[0].streak).toBeNull();
    expect(body[0].todayProgress).toBeNull();
  });

  it("GET /api/chores/board?date=2026-08-13 (Thursday) with same assignment → 200 but empty (no weekday match)", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const memberId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    seedChore(routineId, "Breakfast dishes");
    // Assignment only covers Wednesday
    seedAssignment(routineId, memberId, ["wed"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // 2026-08-13 is a Thursday - assignment doesn't cover this day
    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-13",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      memberId: string;
      displayName: string;
      dayPeriods: Array<{
        id: string;
        labelKey: string;
        chores: Array<{ id: string; name: string; completed: boolean }>;
      }>;
    }>;

    expect(body).toHaveLength(1);
    // All periods have empty chores since no weekday match
    for (const period of body[0].dayPeriods) {
      expect(period.chores).toEqual([]);
    }
  });

  it("GET /api/chores/board with multiple children: assigned + unassigned → both appear", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    // Child 1: assigned
    const memberId1 = seedMember("child", "active");
    const routineId1 = seedRoutine("morning");
    seedChore(routineId1, "Task 1");
    seedAssignment(routineId1, memberId1, ["wed"]);

    // Child 2: active but no assignment
    const memberId2 = seedMember("child", "active");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      memberId: string;
      dayPeriods: Array<{ id: string; chores: Array<{ id: string }> }>;
    }>;

    // Both children appear as columns
    expect(body).toHaveLength(2);
    const memberIds = body.map((c) => c.memberId);
    expect(memberIds).toContain(memberId1);
    expect(memberIds).toContain(memberId2);

    // Child 1 has chores in morning, child 2 has empty periods
    const col1 = body.find((c) => c.memberId === memberId1);
    expect(col1!.dayPeriods.find((p) => p.id === "morning")!.chores).toHaveLength(1);

    const col2 = body.find((c) => c.memberId === memberId2);
    for (const period of col2!.dayPeriods) {
      expect(period.chores).toEqual([]);
    }
  });

  it("GET /api/chores/board with archived member → no column for them (KIOSK-SHELL-NAVIGATION-INV-04)", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    // Archived member with active assignment (should NOT appear)
    const archivedMemberId = seedMember("child", "archived");
    const routineId1 = seedRoutine("morning");
    seedChore(routineId1, "Task");
    seedAssignment(routineId1, archivedMemberId, ["wed"]);

    // Active member (SHOULD appear)
    const activeMemberId = seedMember("child", "active");
    const routineId2 = seedRoutine("afternoon");
    seedChore(routineId2, "Another Task");
    seedAssignment(routineId2, activeMemberId, ["wed"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ memberId: string }>;

    // Only active member appears
    expect(body).toHaveLength(1);
    expect(body[0].memberId).toBe(activeMemberId);

    // Archived member's assignment row is still in DB (archive-only)
    const db = getDb();
    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM routine_assignments WHERE member_id = ?")
      .get(archivedMemberId) as { cnt: number };
    expect(rows.cnt).toBeGreaterThan(0);
  });

  it("GET /api/chores/board with archived member who never had assignment → no column", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    // Archived member with NO assignment (should NOT appear)
    seedMember("child", "archived");

    // Active member with assignment
    const activeMemberId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    seedChore(routineId, "Task");
    seedAssignment(routineId, activeMemberId, ["wed"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ memberId: string }>;

    // Only active member appears
    expect(body).toHaveLength(1);
    expect(body[0].memberId).toBe(activeMemberId);
  });

  it("GET /api/chores/board with archived member who had assignment → column disappears", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    // Seed active member with assignment
    const memberId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    seedChore(routineId, "Task");
    seedAssignment(routineId, memberId, ["wed"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // First request: member is active
    let res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    let body = JSON.parse(res.body) as Array<{ memberId: string }>;
    expect(body).toHaveLength(1);

    // Archive the member
    const db = getDb();
    db.prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberId);

    // Second request: member is archived
    res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    body = JSON.parse(res.body) as Array<{ memberId: string }>;
    // Column should now be gone (archived members excluded entirely)
    expect(body).toHaveLength(0);
  });

  it("GET /api/chores/board with malformed date → 400", async () => {
    const { deviceKey } = seedKeys();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=invalid-date",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(400);
  });

  it("GET /api/chores/board with impossible date (Feb 30) → 400", async () => {
    const { deviceKey } = seedKeys();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2025-02-30",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(400);
  });

  it("GET /api/chores/board without date query param → 400", async () => {
    const { deviceKey } = seedKeys();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(400);
  });

  it("GET /api/chores/board with zero active children → 200 empty array (not error)", async () => {
    // No members seeded at all
    const { deviceKey } = seedKeys();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<unknown>;
    expect(body).toEqual([]);
  });

  it("GET /api/chores/board chore completed status from chore_completions table", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const memberId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Task");
    seedAssignment(routineId, memberId, ["wed"]);

    // Mark chore as completed for this date
    seedChoreCompletion(choreId, memberId, "2026-08-12");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      dayPeriods: Array<{ id: string; chores: Array<{ completed: boolean }> }>;
    }>;

    expect(body[0].dayPeriods.find((p) => p.id === "morning")!.chores[0].completed).toBe(true);
  });

  it("GET /api/chores/board chore sortOrder is preserved", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const memberId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    // Create chores in specific order
    const chore1Id = seedChore(routineId, "First");
    const chore2Id = seedChore(routineId, "Second");
    const chore3Id = seedChore(routineId, "Third");

    // Reorder to: 3, 1, 2
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    let res = await app.inject({
      method: "PUT",
      url: `/api/routines/${routineId}/chores/order`,
      cookies: { mp_device_key: deviceKey },
      payload: { choreIds: [chore3Id, chore1Id, chore2Id] },
    });
    expect(res.statusCode).toBe(200);

    seedAssignment(routineId, memberId, ["wed"]);

    res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      dayPeriods: Array<{ id: string; chores: Array<{ id: string }> }>;
    }>;

    const morningChores = body[0].dayPeriods.find((p) => p.id === "morning")!.chores;
    expect(morningChores).toHaveLength(3);
    expect(morningChores[0].id).toBe(chore3Id);
    expect(morningChores[1].id).toBe(chore1Id);
    expect(morningChores[2].id).toBe(chore2Id);
  });

  it("GET /api/chores/board only shows active chores (soft-deleted chore excluded)", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const memberId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const chore1Id = seedChore(routineId, "Active Task");
    const chore2Id = seedChore(routineId, "Deleted Task");

    // Soft delete chore 2
    const db = getDb();
    db.prepare("UPDATE chores SET active = 0 WHERE id = ?").run(chore2Id);

    seedAssignment(routineId, memberId, ["wed"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/chores/board?date=2026-08-12",
      cookies: { mp_device_key: deviceKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      dayPeriods: Array<{ id: string; chores: Array<{ id: string }> }>;
    }>;

    expect(body[0].dayPeriods.find((p) => p.id === "morning")!.chores).toHaveLength(1);
    expect(body[0].dayPeriods.find((p) => p.id === "morning")!.chores[0].id).toBe(chore1Id);
  });
});
