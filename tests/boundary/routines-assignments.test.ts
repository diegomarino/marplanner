import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** / — Assignment CRUD boundary tests (GREEN).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * The upsertAssignment and deactivateAssignment implementations are wired to the
 * PUT/DELETE routes; all tests exercise working endpoints.
 * Covers: FR-001, FR-002, FR-005
 * Invariants tested:
 * INV-01 — assignments target active children only (via listActiveChildren reuse)
 * INV-02 — weekdays must be one of the 7 canonical codes
 */
describe("routines-assignments boundary tests", () => {
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
    const periods = [
      { id: "morning", labelKey: "period.morning", startMinutes: 300, sortOrder: 0 },
      { id: "afternoon", labelKey: "period.afternoon", startMinutes: 720, sortOrder: 1 },
      { id: "evening", labelKey: "period.evening", startMinutes: 1080, sortOrder: 2 },
      { id: "night", labelKey: "period.night", startMinutes: 1260, sortOrder: 3 },
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
    ).run(id, `Test Member ${id.slice(0, 4)}`, role, lifecycle, now, now);
    return id;
  }

  // ── PUT /api/routines/:id/assignments/:memberId — upsert (FR-005) ──────────

  it("PUT /api/routines/:id/assignments/:memberId with valid active child → 200 (FR-005)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create a routine
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Assignment Routine", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      // Create an active child
      const childId = seedMember("child", "active");

      // Upsert assignment
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "wed", "fri"] },
      });

      // Implementation is active — expects 200 on successful upsert
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("memberId", childId);
      expect(body).toHaveProperty("weekdays");
      expect(body.weekdays).toEqual(["mon", "wed", "fri"]);
      expect(body).toHaveProperty("active", true);
    } finally {
      await app.close();
    }
  });

  it("PUT /api/routines/:id/assignments/:memberId — same pair twice → ONE row (upsert, no duplicate)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Upsert Routine", dayPeriodId: "afternoon" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId = seedMember("child", "active");

      // First upsert
      const r1 = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "tue"] },
      });
      expect(r1.statusCode).toBe(200);
      const firstBody = JSON.parse(r1.body);
      expect(firstBody).toHaveProperty("id");

      // Second upsert with different weekdays
      const r2 = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["wed", "thu", "fri"] },
      });
      expect(r2.statusCode).toBe(200);
      const secondBody = JSON.parse(r2.body);

      // Confirm: same id (reused row, not a duplicate)
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.weekdays).toEqual(["wed", "thu", "fri"]);

      // Verify exactly one row exists by listing assignments for the routine
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/assignments`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const assignments = JSON.parse(listRes.body);
      expect(assignments.length).toBe(1);
      expect(assignments[0].id).toBe(firstBody.id);
      expect(assignments[0].weekdays).toEqual(["wed", "thu", "fri"]);
    } finally {
      await app.close();
    }
  });

  it("PUT /api/routines/:id/assignments/:memberId with archived member → 400 (INV-01)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Archived Test", dayPeriodId: "evening" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      // Create an archived child
      const archivedId = seedMember("child", "archived");

      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${archivedId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon"] },
      });

      // Archived member → 400 (validation error — INV-01: must be active child)
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("PUT /api/routines/:id/assignments/:memberId with parent → 400 (not a child, INV-01)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Parent Test", dayPeriodId: "night" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      // Create a parent (not a child)
      const parentId = seedMember("parent", "active");

      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${parentId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon"] },
      });

      // Parent → 400 (validation error — must be a child)
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("PUT /api/routines/:id/assignments/:memberId with invalid weekday → 400 (FR-002, INV-02)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Invalid Weekday", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId = seedMember("child", "active");

      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "invalid_day"] },
      });

      // Invalid weekday → 400 (validation error — INV-02)
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("PUT /api/routines/:id/assignments/:memberId with non-existent memberId → 400 (#348)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Nonexistent Member Test", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      // Syntactically-valid but nonexistent memberId: listActiveChildren.some(...)
      // can't distinguish "doesn't exist" from "not an active child", so this
      // falls into the generic AssignmentValidationError → 400 (not 404).
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/nonexistent-member-id`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon"] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("PUT /api/routines/:id/assignments/:memberId with non-existent routine → 404", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const childId = seedMember("child", "active");

      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/nonexistent-id/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon"] },
      });

      // Non-existent routine → 404 (not found)
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("DELETE → PUT reactivates same assignment row", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Reactivation Test", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId = seedMember("child", "active");

      // First upsert to create the assignment
      const upsertRes1 = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "wed"] },
      });
      expect(upsertRes1.statusCode).toBe(200);
      const firstBody = JSON.parse(upsertRes1.body);
      expect(firstBody).toHaveProperty("id");
      const firstId = firstBody.id;

      // Deactivate the assignment
      const deactivateRes = await app.inject({
        method: "DELETE",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(deactivateRes.statusCode).toBe(204);

      // Reactivate via upsert (same row, active flips back to true)
      const upsertRes2 = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "wed"] },
      });
      expect(upsertRes2.statusCode).toBe(200);
      const secondBody = JSON.parse(upsertRes2.body);

      // Same id (reused row)
      expect(secondBody.id).toBe(firstId);
      // active should be true again
      expect(secondBody.active).toBe(true);

      // Verify via GET that the SAME row exists (one active, since we reused it)
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/assignments`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const assignments = JSON.parse(listRes.body);
      // Only 1 assignment row (reused), now active again
      expect(assignments.length).toBe(1);
      expect(assignments[0].id).toBe(firstId);
      expect(assignments[0].active).toBe(true);
    } finally {
      await app.close();
    }
  });

  // ── GET /api/routines/:id/assignments — list assignments (INV-08) ─────

  it("GET /api/routines/:id/assignments returns all assignments including soft-deactivated", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "List Test", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId1 = seedMember("child", "active");
      const childId2 = seedMember("child", "active");

      // Create first assignment
      await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId1}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "wed"] },
      });

      // Create second assignment
      await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId2}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["tue", "thu"] },
      });

      // List assignments
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/assignments`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const assignments = JSON.parse(listRes.body);
      expect(assignments.length).toBe(2);

      // Deactivate one assignment
      await app.inject({
        method: "DELETE",
        url: `/api/routines/${routineId}/assignments/${childId1}`,
        cookies: { mp_device_key: deviceKey },
      });

      // GET still returns both (including soft-deactivated) per INV-08
      const listRes2 = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/assignments`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes2.statusCode).toBe(200);
      const assignments2 = JSON.parse(listRes2.body);
      expect(assignments2.length).toBe(2);

      // Verify one is active, one is inactive
      const active = assignments2.filter((a: any) => a.active === true);
      const inactive = assignments2.filter((a: any) => a.active === false);
      expect(active.length).toBe(1);
      expect(inactive.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ── DELETE /api/routines/:id/assignments/:memberId — deactivate ────────────

  it("DELETE /api/routines/:id/assignments/:memberId soft-deactivates (FR-005)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Deactivate Test", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId = seedMember("child", "active");

      // First upsert to create the assignment
      const upsertRes = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "wed"] },
      });
      expect(upsertRes.statusCode).toBe(200);

      // Now deactivate
      const res = await app.inject({
        method: "DELETE",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
      });

      // Soft-deactivate → 204 No Content (empty response)
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/routines/:id/assignments/:memberId is idempotent (repeat DELETE → 204, not 404) (#348)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Idempotent Delete Test", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId = seedMember("child", "active");

      const upsertRes = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon", "wed"] },
      });
      expect(upsertRes.statusCode).toBe(200);

      // deactivateAssignment looks up by routine_id+member_id only (no active=1
      // filter), so a repeat DELETE on the same pair 204s instead of 404ing.
      const firstDelete = await app.inject({
        method: "DELETE",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(firstDelete.statusCode).toBe(204);

      const secondDelete = await app.inject({
        method: "DELETE",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(secondDelete.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/routines/:id/assignments/:memberId when no assignment exists → 404", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "No Assignment Test", dayPeriodId: "afternoon" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const childId = seedMember("child", "active");

      const res = await app.inject({
        method: "DELETE",
        url: `/api/routines/${routineId}/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
      });

      // No assignment exists → 404
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/routines/:id/assignments/:memberId with non-existent routine → 404", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const childId = seedMember("child", "active");

      const res = await app.inject({
        method: "DELETE",
        url: `/api/routines/nonexistent-id/assignments/${childId}`,
        cookies: { mp_device_key: deviceKey },
      });

      // Non-existent routine → 404
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
