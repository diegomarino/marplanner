import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — Routine + chore CRUD boundary tests (RED-first).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * RED-BY-DESIGN: src/server/modules/routines/index.ts does NOT exist yet.
 * Requests will 501 — this test IS EXPECTED TO FAIL (RED).
 * (routines module + route wiring) is the task that turns this green.
 * Covers: FR-001, FR-007, FR-017, FR-019
 * Rules tested:
 * Rule 1 — getRoutineById/getChoreById tolerant of soft-delete (404 only for unknown id)
 * Rule 2 — dayPeriodId is immutable after creation (editRoutine only writes name/active)
 * Rule 3 — reorderChores is atomic with full-set validation, prior order intact on rejection
 */

describe("routines-crud boundary tests (T008 — red-by-design)", () => {
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

  it("rejects invalid routine edits and chore icons without changing stored rows", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const routine = (
        await app.inject({
          method: "POST",
          url: "/api/routines",
          cookies: { mp_device_key: deviceKey },
          payload: { name: "Morning", dayPeriodId: "morning" },
        })
      ).json();
      const chore = (
        await app.inject({
          method: "POST",
          url: `/api/routines/${routine.id}/chores`,
          cookies: { mp_device_key: deviceKey },
          payload: { name: "Brush teeth", icon: "🪥" },
        })
      ).json();
      const before = getDb().prepare("SELECT total_changes() AS changes").get();
      for (const [method, url, payload] of [
        ["PATCH", `/api/routines/${routine.id}`, { name: "Changed", active: "yes" }],
        ["POST", `/api/routines/${routine.id}/chores`, { name: "New", icon: 7 }],
        ["PATCH", `/api/chores/${chore.id}`, { name: "Changed", icon: 7 }],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          cookies: { mp_device_key: deviceKey },
          payload,
        });
        expect(response.statusCode, url).toBe(400);
        expect(response.json()).toMatchObject({
          error: "validation_error",
          message: expect.any(String),
        });
      }
      expect(getDb().prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/routines/${routine.id}`,
            cookies: { mp_device_key: deviceKey },
          })
        ).json()
      ).toEqual(routine);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/chores/${chore.id}`,
            cookies: { mp_device_key: deviceKey },
          })
        ).json()
      ).toEqual(chore);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/routines — create a routine ────────────────────────────────

  it("POST /api/routines with valid dayPeriodId → 201 (FR-001)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Morning Cleanup", dayPeriodId: "morning" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name", "Morning Cleanup");
      expect(body).toHaveProperty("dayPeriodId", "morning");
      expect(body).toHaveProperty("active", true);
    } finally {
      await app.close();
    }
  });

  it("POST /api/routines with unknown dayPeriodId → 400 (FR-001)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Bad Period", dayPeriodId: "nonexistent" },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  // ── GET /api/routines/:id — tolerant of soft-delete (Rule 1) ─────────────

  it("GET /api/routines/:id fetches active routine by id (FR-007)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create a routine
      const createRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Fetchable Routine", dayPeriodId: "morning" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = JSON.parse(createRes.body);

      // Fetch by id
      const res = await app.inject({
        method: "GET",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(id);
      expect(body.name).toBe("Fetchable Routine");
      expect(body.dayPeriodId).toBe("morning");
    } finally {
      await app.close();
    }
  });

  it("GET /api/routines/:id returns soft-deleted routine (Rule 1 — history read)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create + soft-delete a routine
      const createRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Deleted Routine", dayPeriodId: "afternoon" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = JSON.parse(createRes.body);

      // Soft-delete it
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(delRes.statusCode).toBe(204);

      // GET by id should still return it (Rule 1: tolerant of soft-delete)
      const res = await app.inject({
        method: "GET",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(id);
      expect(body.name).toBe("Deleted Routine");
      expect(body.active).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("GET /api/routines/:id 404 for truly unknown id (Rule 1)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/routines/nonexistent-id",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── PATCH /api/routines/:id — edit name/active ONLY (Rule 2) ────────────

  it("PATCH /api/routines/:id edits name and active (FR-001)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Original Name", dayPeriodId: "evening" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Edited Name", active: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Edited Name");
      expect(body.active).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/routines/:id ignores dayPeriodId — stored value NEVER changes (Rule 2)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create with dayPeriodId = "morning"
      const createRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Immutable Period", dayPeriodId: "morning" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = JSON.parse(createRes.body);

      // Try to change dayPeriodId via PATCH (Rule 2: it must be ignored or rejected)
      const res = await app.inject({
        method: "PATCH",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { dayPeriodId: "night" },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      // Rule 2: dayPeriodId MUST NOT change — it is immutable after creation
      expect(body.dayPeriodId).toBe("morning");
    } finally {
      await app.close();
    }
  });

  // ── DELETE /api/routines/:id — soft-delete ───────────────────────────────

  it("DELETE /api/routines/:id soft-deletes (disappears from active list)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "To Delete", dayPeriodId: "night" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(204);

      // Should no longer appear in active list
      const listRes = await app.inject({
        method: "GET",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);
      expect(list.every((r: { id: string }) => r.id !== id)).toBe(true);

      // But GET by id still returns it (Rule 1)
      const getRes = await app.inject({
        method: "GET",
        url: `/api/routines/${id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body).active).toBe(false);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/routines/:id/chores — create chore ─────────────────────────

  it("POST /api/routines/:id/chores → 201 with sortOrder appended (FR-001)", async () => {
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
        payload: { name: "Routine With Chores", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      // Create first chore
      const c1 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Sweep Floor" },
      });
      expect(c1.statusCode).toBe(201);
      const { sortOrder: so1 } = JSON.parse(c1.body);
      expect(so1).toBe(0);

      // Create second chore
      const c2 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Dust Shelves" },
      });
      expect(c2.statusCode).toBe(201);
      const { sortOrder: so2 } = JSON.parse(c2.body);
      expect(so2).toBe(1);

      // Verify: chore 1 has sortOrder 0, chore 2 has sortOrder 1
      expect(so1).toBe(0);
      expect(so2).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("persists a Unicode chore icon and clears it explicitly with null", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const routineResponse = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Icon routine", dayPeriodId: "morning" },
      });
      const { id: routineId } = JSON.parse(routineResponse.body);

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Brush teeth", icon: "🪥" },
      });
      expect(createResponse.statusCode).toBe(201);
      expect(JSON.parse(createResponse.body)).toMatchObject({ name: "Brush teeth", icon: "🪥" });
      const { id: choreId } = JSON.parse(createResponse.body);

      const clearResponse = await app.inject({
        method: "PATCH",
        url: `/api/chores/${choreId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { icon: null },
      });
      expect(clearResponse.statusCode).toBe(200);
      expect(JSON.parse(clearResponse.body)).toMatchObject({ icon: null });
    } finally {
      await app.close();
    }
  });

  // ── GET /api/chores/:id — tolerant of soft-delete ────────────────────────

  it("GET /api/chores/:id fetches active chore by id (FR-007)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore Routine", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const cRes = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Wipe Counter" },
      });
      expect(cRes.statusCode).toBe(201);
      const { id: choreId } = JSON.parse(cRes.body);

      const res = await app.inject({
        method: "GET",
        url: `/api/chores/${choreId}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(choreId);
      expect(body.name).toBe("Wipe Counter");
      expect(body.active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("GET /api/chores/:id returns soft-deleted chore (Rule 1 — history read)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore Routine", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const cRes = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Soft-Deleted Chore" },
      });
      expect(cRes.statusCode).toBe(201);
      const { id: choreId } = JSON.parse(cRes.body);

      // Soft-delete
      await app.inject({
        method: "DELETE",
        url: `/api/chores/${choreId}`,
        cookies: { mp_device_key: deviceKey },
      });

      // GET by id should still return it
      const res = await app.inject({
        method: "GET",
        url: `/api/chores/${choreId}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).active).toBe(false);
    } finally {
      await app.close();
    }
  });

  // ── PATCH /api/chores/:id — rename + move (FR-019) ───────────────────────

  it("PATCH /api/chores/:id can rename and move routineId (FR-019)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create two routines
      const r1 = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Routine 1", dayPeriodId: "morning" },
      });
      expect(r1.statusCode).toBe(201);
      const { id: r1Id } = JSON.parse(r1.body);

      const r2 = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Routine 2", dayPeriodId: "afternoon" },
      });
      expect(r2.statusCode).toBe(201);
      const { id: r2Id } = JSON.parse(r2.body);

      // Create a chore under r1
      const cRes = await app.inject({
        method: "POST",
        url: `/api/routines/${r1Id}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Old Chore" },
      });
      expect(cRes.statusCode).toBe(201);
      const { id: choreId } = JSON.parse(cRes.body);

      // Move chore to r2 + rename
      const res = await app.inject({
        method: "PATCH",
        url: `/api/chores/${choreId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Renamed Chore", routineId: r2Id },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Renamed Chore");
      expect(body.routineId).toBe(r2Id);
    } finally {
      await app.close();
    }
  });

  // ── PUT /api/routines/:id/chores/order — atomic reorder (Rule 3) ─────────

  it("PUT /api/routines/:id/chores/order replaces full order (Rule 3)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create a routine with 3 chores
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Reorder Routine", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const c1 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore A" },
      });
      expect(c1.statusCode).toBe(201);
      const { id: c1Id } = JSON.parse(c1.body);

      const c2 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore B" },
      });
      expect(c2.statusCode).toBe(201);
      const { id: c2Id } = JSON.parse(c2.body);

      const c3 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore C" },
      });
      expect(c3.statusCode).toBe(201);
      const { id: c3Id } = JSON.parse(c3.body);

      // Reorder: C, B, A (reverse)
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/chores/order`,
        cookies: { mp_device_key: deviceKey },
        payload: { choreIds: [c3Id, c2Id, c1Id] },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body[0].id).toBe(c3Id);
      expect(body[0].sortOrder).toBe(0);
      expect(body[1].id).toBe(c2Id);
      expect(body[1].sortOrder).toBe(1);
      expect(body[2].id).toBe(c1Id);
      expect(body[2].sortOrder).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("PUT reorder with mismatched choreIds → 400, prior order intact (Rule 3)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create a routine with 3 chores (order: A=0, B=1, C=2)
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Atomic Reorder", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const c1 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "A" },
      });
      expect(c1.statusCode).toBe(201);
      const { id: c1Id } = JSON.parse(c1.body);

      const c2 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "B" },
      });
      expect(c2.statusCode).toBe(201);
      const { id: c2Id } = JSON.parse(c2.body);

      const c3 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "C" },
      });
      expect(c3.statusCode).toBe(201);
      const { id: c3Id } = JSON.parse(c3.body);

      // Attempt reorder with a fake chore id (does not match active chore set)
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/chores/order`,
        cookies: { mp_device_key: deviceKey },
        payload: { choreIds: [c3Id, "fake-id", c1Id] },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");

      // Rule 3: re-read the order — prior order must be FULLY INTACT (no partial write)
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const chores = JSON.parse(listRes.body);
      const sorted = [...chores].sort(
        (a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder
      );
      expect(sorted[0].id).toBe(c1Id); // A still has sortOrder 0
      expect(sorted[1].id).toBe(c2Id); // B still has sortOrder 1
      expect(sorted[2].id).toBe(c3Id); // C still has sortOrder 2
    } finally {
      await app.close();
    }
  });

  it("PUT reorder with missing choreId → 400, prior order intact (Rule 3)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Partial Reorder", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const c1 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "A" },
      });
      expect(c1.statusCode).toBe(201);
      const { id: c1Id } = JSON.parse(c1.body);

      const c2 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "B" },
      });
      expect(c2.statusCode).toBe(201);
      const { id: c2Id } = JSON.parse(c2.body);

      // Attempt reorder with only 1 of 2 chore ids (missing one)
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/chores/order`,
        cookies: { mp_device_key: deviceKey },
        payload: { choreIds: [c1Id] },
      });
      expect(res.statusCode).toBe(400);

      // Prior order must be intact
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const chores = (JSON.parse(listRes.body) as Array<{ id: string; sortOrder: number }>).sort(
        (a, b) => a.sortOrder - b.sortOrder
      );
      expect(chores[0].id).toBe(c1Id);
      expect(chores[1].id).toBe(c2Id);
    } finally {
      await app.close();
    }
  });

  it("PUT reorder with inactive choreId → 400, prior order intact (Rule 3)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Inactive Reorder", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const c1 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "A" },
      });
      expect(c1.statusCode).toBe(201);
      const { id: c1Id } = JSON.parse(c1.body);

      const c2 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "B" },
      });
      expect(c2.statusCode).toBe(201);
      const { id: c2Id } = JSON.parse(c2.body);

      // Soft-delete C2
      await app.inject({
        method: "DELETE",
        url: `/api/chores/${c2Id}`,
        cookies: { mp_device_key: deviceKey },
      });

      // Attempt reorder including the inactive chore id
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/chores/order`,
        cookies: { mp_device_key: deviceKey },
        payload: { choreIds: [c1Id, c2Id] },
      });
      expect(res.statusCode).toBe(400);

      // Prior order must be intact (only active C1 should remain)
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const chores = JSON.parse(listRes.body);
      expect(chores.length).toBe(1);
      expect(chores[0].id).toBe(c1Id);
    } finally {
      await app.close();
    }
  });

  // ── P1 — duplicate chore IDs in reorder (self-referential check) ──────

  it("PUT reorder with duplicate choreIds (within correct count) → 400, prior order intact (P1 #1)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create a routine with exactly 2 active chores
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Duplicate Reorder", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      const c1 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "A" },
      });
      expect(c1.statusCode).toBe(201);
      const { id: c1Id } = JSON.parse(c1.body);

      const c2 = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "B" },
      });
      expect(c2.statusCode).toBe(201);
      const { id: c2Id } = JSON.parse(c2.body);

      // Send duplicate choreId: [c1Id, c1Id] — length is 2 (matches 2 active chores),
      // so the length check passes, but the old self-referential check never fires.
      // This test verifies the fix detects duplicates correctly.
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/${routineId}/chores/order`,
        cookies: { mp_device_key: deviceKey },
        payload: { choreIds: [c1Id, c1Id] },
      });
      expect(res.statusCode).toBe(400);

      // Verify prior order is fully intact (no partial write occurred)
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const chores = JSON.parse(listRes.body);
      expect(chores).toHaveLength(2);
      const sorted = [...chores].sort(
        (a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder
      );
      expect(sorted[0].id).toBe(c1Id); // A still at sortOrder 0
      expect(sorted[1].id).toBe(c2Id); // B still at sortOrder 1
    } finally {
      await app.close();
    }
  });

  // ── P1 — moving a chore to a new routine prevents sort_order collision ─

  it("PATCH chore move to routine with existing chore → new sort_order assigned (P1 #2)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      // Create two routines
      const r1 = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Source Routine", dayPeriodId: "morning" },
      });
      expect(r1.statusCode).toBe(201);
      const { id: r1Id } = JSON.parse(r1.body);

      const r2 = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Target Routine", dayPeriodId: "afternoon" },
      });
      expect(r2.statusCode).toBe(201);
      const { id: r2Id } = JSON.parse(r2.body);

      // Create chore X (sortOrder=0) under r1
      const cX = await app.inject({
        method: "POST",
        url: `/api/routines/${r1Id}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore X" },
      });
      expect(cX.statusCode).toBe(201);
      const { id: cXId } = JSON.parse(cX.body);

      // Create chore Y (sortOrder=0) under r2
      const cY = await app.inject({
        method: "POST",
        url: `/api/routines/${r2Id}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Chore Y" },
      });
      expect(cY.statusCode).toBe(201);

      // Move X to r2 — should NOT collide with Y's sortOrder (both were 0)
      const moveRes = await app.inject({
        method: "PATCH",
        url: `/api/chores/${cXId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { routineId: r2Id },
      });
      expect(moveRes.statusCode).toBe(200);

      // Verify: r2 now has 2 chores with DISTINCT sort_orders
      const r2Chores = await app.inject({
        method: "GET",
        url: `/api/routines/${r2Id}/chores`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(r2Chores.statusCode).toBe(200);
      const r2ChoreList = JSON.parse(r2Chores.body);
      expect(r2ChoreList).toHaveLength(2);
      const orderValues = r2ChoreList.map((c: { sortOrder: number }) => c.sortOrder);
      expect(new Set(orderValues).size).toBe(2); // no duplicates
    } finally {
      await app.close();
    }
  });

  // ── P2 — reactivating a soft-deleted chore gets fresh sort_order ──────

  it("PATCH chore reactivate (active false→true) → fresh sort_order (P2 #1)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const rRes = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Reactivate Routine", dayPeriodId: "morning" },
      });
      expect(rRes.statusCode).toBe(201);
      const { id: routineId } = JSON.parse(rRes.body);

      // Create A (sortOrder=0) and B (sortOrder=1)
      const cA = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "A" },
      });
      expect(cA.statusCode).toBe(201);

      const cB = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "B" },
      });
      expect(cB.statusCode).toBe(201);
      const { id: cBId } = JSON.parse(cB.body);

      // Soft-delete B (sortOrder=1)
      await app.inject({
        method: "DELETE",
        url: `/api/chores/${cBId}`,
        cookies: { mp_device_key: deviceKey },
      });

      // Create C (sortOrder=1, since B is gone, max active = 0)
      const cC = await app.inject({
        method: "POST",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "C" },
      });
      expect(cC.statusCode).toBe(201);
      const { sortOrder: cCSortOrder } = JSON.parse(cC.body);
      expect(cCSortOrder).toBe(1); // B's old sortOrder, now taken by C

      // Reactivate B — should get a fresh sortOrder (not colliding with C's 1)
      const reactRes = await app.inject({
        method: "PATCH",
        url: `/api/chores/${cBId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { active: true },
      });
      expect(reactRes.statusCode).toBe(200);

      // Verify: all 3 chores have DISTINCT sort_orders
      const listRes = await app.inject({
        method: "GET",
        url: `/api/routines/${routineId}/chores`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const chores = JSON.parse(listRes.body);
      expect(chores).toHaveLength(3);
      const orderValues = chores.map((c: { sortOrder: number }) => c.sortOrder);
      expect(new Set(orderValues).size).toBe(3); // no duplicates
    } finally {
      await app.close();
    }
  });

  // ── P2 — missing parent routine on chore routes → 404 (not 400) ───────

  it("POST chore under non-existent routine → 404 (P2 #2)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/routines/nonexistent-id/chores`,
        cookies: { mp_device_key: deviceKey },
        payload: { name: "Lost Chore" },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("PUT reorder under non-existent routine → 404 (P2 #2)", async () => {
    seedDayPeriods();
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/routines/nonexistent-id/chores/order`,
        cookies: { mp_device_key: deviceKey },
        payload: { choreIds: ["fake-id"] },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });
});
