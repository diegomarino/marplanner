import { describe, it, expect, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import { useIsolatedDb } from "../helpers/db.js";

/** — US2 complete/uncomplete boundary tests (RED first).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Covers: FR-008/009/010/011; INV-04, AC-01/02.
 * - POST /api/chores/:id/completions {memberId, date} for currently-markable pair -> 204
 * - Identical repeated request -> still 204 with NO duplicate row (UNIQUE enforced)
 * - Not currently markable pair -> 400
 * - DELETE /api/chores/:id/completions for EXISTING completion whose routine soft-deleted -> still 204 (asymmetry test)
 * - DELETE for no existing completion -> still 204 (idempotent no-op, not 404)
 * - Yesterday behaves identically to today (no separate past-date code path)
 * - Malformed/impossible date -> 400 on POST
 * - Event emission happens post-commit-only (verified via in-test listener)
 */

describe("routines-complete boundary tests (T015 — US2)", () => {
  useIsolatedDb();

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

  // ── POST /api/chores/:id/completions (complete) ──────────────────────────

  it("POST /api/chores/:id/completions {memberId, date} for currently-markable pair -> 204", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(204);

    const db = getDb();
    const row = db
      .prepare("SELECT id FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
      .get(choreId, childId, "2026-08-13") as { id: string } | undefined;
    expect(row).toBeDefined();
  });

  it("POST /api/chores/:id/completions IDENTICAL request repeated -> still 204 with NO duplicate row", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // First completion
    let res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });
    expect(res.statusCode).toBe(204);

    // Second (identical) completion - should be idempotent
    res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });
    expect(res.statusCode).toBe(204);

    // Verify only ONE row exists
    const db = getDb();
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?"
      )
      .get(choreId, childId, "2026-08-13") as { c: number };
    expect(count.c).toBe(1);
  });

  it("POST /api/chores/:id/completions NOT currently markable (inactive assignment) -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Monday only (2026-08-13 is a Thursday — mismatch)
    seedAssignment(routineId, childId, ["mon"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/chores/:id/completions NOT currently markable (inactive chore) -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // Deactivate the chore (soft delete)
    const db = getDb();
    db.prepare("UPDATE chores SET active = 0 WHERE id = ?").run(choreId);

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/chores/:id/completions NOT currently markable (inactive routine) -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // Deactivate the routine (soft delete)
    const db = getDb();
    db.prepare("UPDATE routines SET active = 0 WHERE id = ?").run(routineId);

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/chores/:id/completions NOT currently markable (member archived) -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    // Archive the child BEFORE assignment (so they are not an active child)
    const childId = seedMember("child", "archived");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/chores/:id/completions yesterday behaves identically to today", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // Complete yesterday (also a Thursday)
    let res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-06",
      },
    });
    expect(res.statusCode).toBe(204);

    // Complete today (also a Thursday)
    res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });
    expect(res.statusCode).toBe(204);

    // Verify both rows exist
    const db = getDb();
    const countYesterday = db
      .prepare(
        "SELECT COUNT(*) AS c FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?"
      )
      .get(choreId, childId, "2026-08-06") as { c: number };
    const countToday = db
      .prepare(
        "SELECT COUNT(*) AS c FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?"
      )
      .get(choreId, childId, "2026-08-13") as { c: number };
    expect(countYesterday.c).toBe(1);
    expect(countToday.c).toBe(1);
  });

  it("POST /api/chores/:id/completions with malformed date -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-8-13", // malformed - not zero-padded month
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/chores/:id/completions with impossible date (Feb 30) -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-02-30", // impossible
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── DELETE /api/chores/:id/completions (uncomplete) ──────────────────────

  it("DELETE /api/chores/:id/completions for EXISTING completion whose routine soft-deleted -> still 204 (asymmetry test)", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // First complete the chore
    let res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });
    expect(res.statusCode).toBe(204);

    // Soft-delete the routine (making it NOT currently markable)
    const db = getDb();
    db.prepare("UPDATE routines SET active = 0 WHERE id = ?").run(routineId);

    // Uncomplete should STILL work (FR-009 / asymmetry)
    res = await app.inject({
      method: "DELETE",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      query: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(204);

    // Verify the row is gone
    const row = db
      .prepare("SELECT id FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
      .get(choreId, childId, "2026-08-13") as { id: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("DELETE /api/chores/:id/completions for no existing completion -> still 204 (idempotent no-op, not 404)", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // No completion exists for this key
    const res = await app.inject({
      method: "DELETE",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      query: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(204);

    // Verify no row was created
    const db = getDb();
    const row = db
      .prepare("SELECT id FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
      .get(choreId, childId, "2026-08-13") as { id: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("DELETE /api/chores/:id/completions with malformed date -> 400 (date validated symmetrically with POST)", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      query: {
        memberId: childId,
        date: "2026-8-13", // malformed - not zero-padded month
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("DELETE /api/chores/:id/completions with impossible date (Feb 30) -> 400", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      query: {
        memberId: childId,
        date: "2026-02-30", // impossible
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── Event emission verification (post-commit-only) ───────────────────────

  it("POST /api/chores/:id/completions emits routines.completion_changed ONLY AFTER successful write", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // Import event bus and subscribe
    const { eventBus } = await import("../../src/server/lib/event-bus.js");
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    eventBus.subscribe("routines.completion_changed", (payload: unknown) => {
      emittedEvents.push({ name: "routines.completion_changed", payload });
    });

    // Complete the chore
    const res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(204);

    // Wait for microtask to flush
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify event was emitted with correct payload
    expect(emittedEvents).toHaveLength(1);
    const payload = emittedEvents[0].payload as {
      memberId: string;
      choreId: string;
      routineId: string;
      date: string;
      completed: boolean;
    };
    expect(payload).toMatchObject({
      memberId: childId,
      choreId: choreId,
      routineId: routineId,
      date: "2026-08-13",
      completed: true,
    });
  });

  it("DELETE /api/chores/:id/completions emits routines.completion_changed ONLY AFTER successful delete", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday)
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // First complete the chore
    let res = await app.inject({
      method: "POST",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      payload: {
        memberId: childId,
        date: "2026-08-13",
      },
    });
    expect(res.statusCode).toBe(204);

    // Import event bus and subscribe
    const { eventBus } = await import("../../src/server/lib/event-bus.js");
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    eventBus.subscribe("routines.completion_changed", (payload: unknown) => {
      emittedEvents.push({ name: "routines.completion_changed", payload });
    });

    // Now uncomplete
    res = await app.inject({
      method: "DELETE",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      query: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    expect(res.statusCode).toBe(204);

    // Wait for microtask to flush
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify event was emitted with completed=false
    expect(emittedEvents).toHaveLength(1);
    const payload = emittedEvents[0].payload as { completed: boolean };
    expect(payload.completed).toBe(false);
  });

  it("DELETE /api/chores/:id/completions no-op (no existing completion) emits NOTHING", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    // Subscribe BEFORE the request — no completion row exists for this key.
    const { eventBus } = await import("../../src/server/lib/event-bus.js");
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    eventBus.subscribe("routines.completion_changed", (payload: unknown) => {
      emittedEvents.push({ name: "routines.completion_changed", payload });
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chores/${choreId}/completions`,
      cookies: { mp_device_key: deviceKey },
      query: {
        memberId: childId,
        date: "2026-08-13",
      },
    });

    // Still 204 (idempotent no-op), but state did not change...
    expect(res.statusCode).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 0));

    //...so NO event fires — the contract's DELETE emits only "if a row existed".
    expect(emittedEvents).toHaveLength(0);
  });

  // ── Trap-sweep: post-commit-only discipline on FAILURE (ADR-040) ─────────
  //
  // The two tests above only prove an event fires on the happy path — they don't
  // prove emission is actually CONTINGENT on the write succeeding. This test
  // forces the underlying write to throw and asserts the event is never emitted,
  // which is the only thing that actually exercises "post-commit-only."

  it("does NOT emit routines.completion_changed when the underlying write fails", async () => {
    const { deviceKey } = seedKeys();
    seedDayPeriods();

    const childId = seedMember("child", "active");
    const routineId = seedRoutine("morning");
    const choreId = seedChore(routineId, "Make bed");
    // Assign to Thursday (2026-08-13 is a Thursday) — pair IS currently markable.
    seedAssignment(routineId, childId, ["thu"]);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    const { eventBus } = await import("../../src/server/lib/event-bus.js");
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    eventBus.subscribe("routines.completion_changed", (payload: unknown) => {
      emittedEvents.push({ name: "routines.completion_changed", payload });
    });

    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("INSERT INTO chore_completions")) {
        throw new Error("simulated write failure");
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: `/api/chores/${choreId}/completions`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          memberId: childId,
          date: "2026-08-13",
        },
      });
    } finally {
      spy.mockRestore();
    }

    // The route must not swallow the failure into a false 204.
    expect(res.statusCode).toBe(500);

    // Wait for any queued microtask emission to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emittedEvents).toHaveLength(0);

    // And no row was actually written.
    const row = originalPrepare(
      "SELECT id FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?"
    ).get(choreId, childId, "2026-08-13") as { id: string } | undefined;
    expect(row).toBeUndefined();
  });
});
