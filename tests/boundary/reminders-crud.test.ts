import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — apply_to_all CRUD boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the routines suite
 * convention (useIsolatedDb + raw SQL seed helpers).
 * Covers: FR-013 (kind immutable on edit), FR-019 (targetingMode editable), the apply_to_all
 * create/list/get/edit/delete lifecycle. RED until wires
 * listReminders/getReminder/editReminder/deleteReminder + their routes.
 */
describe("reminders-crud boundary tests", () => {
  useIsolatedDb();

  // ── helpers ──────────────────────────────────────────────────────────────

  function seedKeys() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return { deviceKey };
  }

  function seedMember(role: "parent" | "child" = "child") {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(id, `Test Member ${id.slice(0, 4)}`, role, now, now);
    return id;
  }

  async function createApplyToAllReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    overrides: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon", "thu"],
        ...overrides,
      },
    });
  }

  async function withApp(
    run: (app: import("fastify").FastifyInstance, deviceKey: string) => Promise<void>
  ) {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await run(app, deviceKey);
    } finally {
      await app.close();
    }
  }

  async function patchReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    id: string,
    payload: unknown
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/reminders/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload: payload as Record<string, unknown>,
    });
  }

  async function readReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    id: string
  ) {
    const res = await app.inject({
      method: "GET",
      url: `/api/reminders/${id}`,
      cookies: { mp_device_key: deviceKey },
    });
    return JSON.parse(res.body);
  }

  async function createSpecificReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    memberId: string
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        assignments: [{ memberId, weekdays: ["mon"] }],
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body);
  }

  async function createCalendarGated(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    overrides: Record<string, unknown> = {}
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "trae las espinilleras",
        query: "futbol",
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body);
  }

  function assignmentRows(reminderId: string) {
    return getDb()
      .prepare(
        "SELECT member_id AS memberId, active FROM reminder_assignment WHERE reminder_id = ? ORDER BY member_id"
      )
      .all(reminderId) as Array<{ memberId: string; active: number }>;
  }

  // ── POST /api/reminders — create (precedent, re-asserted here) ────────

  it("POST /api/reminders creates an apply_to_all rule → 201", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createApplyToAllReminder(app, deviceKey);
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeTypeOf("string");
      expect(body.kind).toBe("scheduled");
      expect(body.targetingMode).toBe("apply_to_all");
      expect(body.weekdays).toEqual(["mon", "thu"]);
      expect(body.active).toBe(true);
      expect(body.assignments).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ── GET /api/reminders — list ───────────────────────────────────────────

  it("GET /api/reminders lists a created rule", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(created.id);
    } finally {
      await app.close();
    }
  });

  it("GET /api/reminders returns [] when no rules exist", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const listRes = await app.inject({
        method: "GET",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
      });
      expect(listRes.statusCode).toBe(200);
      expect(JSON.parse(listRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ── GET /api/reminders/:id — one rule ───────────────────────────────────

  it("GET /api/reminders/:id returns the created rule", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.body);
      expect(body).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("GET /api/reminders/:id with unknown id → 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/reminders/nonexistent-id",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  // ── PATCH /api/reminders/:id — edit ─────────────────────────────────────

  it("PATCH /api/reminders/:id edits text, active, and weekdays → 200", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { text: "saca el reciclaje", active: false, weekdays: ["fri"] },
      });
      expect(patchRes.statusCode).toBe(200);
      const body = JSON.parse(patchRes.body);
      expect(body.text).toBe("saca el reciclaje");
      expect(body.active).toBe(false);
      expect(body.weekdays).toEqual(["fri"]);
      // Immutable fields unchanged
      expect(body.kind).toBe("scheduled");
      expect(body.targetingMode).toBe("apply_to_all");
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with kind in body → 400 (immutable, FR-013)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { kind: "scheduled" },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      // Nothing changed
      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with an invalid targetingMode value → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, { targetingMode: "by_role" });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH /api/reminders/:id with an unknown field (query) → 400, nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { query: "title contains basura" },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with assignments on an apply_to_all rule that stays apply_to_all → 400, nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId: "x", weekdays: ["mon"] }] },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with an empty object {} → 400 (nothing to edit), nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: {},
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with a JSON array body → 400, nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: ["not", "an", "object"],
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with weekdays on a SPECIFIC rule → 400 (not 500), nothing persisted (Codex rework)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "scheduled",
          targetingMode: "specific",
          text: "coges el bus",
          assignments: [{ memberId, weekdays: ["mon"] }],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["fri"] },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/reminders/:id with unknown id → 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/reminders/nonexistent-id",
        cookies: { mp_device_key: deviceKey },
        payload: { text: "x" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── DELETE /api/reminders/:id — hard delete ─────────────────────────────

  it("DELETE /api/reminders/:id hard-deletes the rule → 204, subsequent GET → 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createApplyToAllReminder(app, deviceKey);
      const created = JSON.parse(createRes.body);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(deleteRes.statusCode).toBe(204);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(404);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(listRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/reminders/:id with unknown id → 404", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/reminders/nonexistent-id",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ── PATCH targetingMode switching (spec: Admin Reminders and Messages) ──────

  it("PATCH apply_to_all → specific with assignments → 200, weekdays cleared, emits only for the assigned member", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const memberB = seedMember();
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);

      const res = await patchReminder(app, deviceKey, created.id, {
        text: "coges el bus",
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("specific");
      expect(body.weekdays).toBeNull();
      expect(body.text).toBe("coges el bus");
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({ memberId: memberA, weekdays: ["mon"] });

      // 2026-01-05 is a Monday.
      const emits = async (memberId: string) => {
        const e = await app.inject({
          method: "GET",
          url: `/api/reminders/emissions?memberId=${memberId}&date=2026-01-05`,
          cookies: { mp_device_key: deviceKey },
        });
        return (JSON.parse(e.body) as Array<{ id: string }>).map((x) => x.id);
      };
      expect(await emits(memberA)).toContain(created.id);
      expect(await emits(memberB)).not.toContain(created.id);
    });
  });

  it("PATCH apply_to_all → specific without assignments → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, { targetingMode: "specific" });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH apply_to_all → specific that also sends rule-level weekdays → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        weekdays: ["mon"],
        assignments: [{ memberId: memberA, weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH apply_to_all → specific with an unknown member → 400 and the rule is left apply_to_all (atomic)", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, {
        text: "changed text",
        targetingMode: "specific",
        assignments: [{ memberId: "no-such-member", weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
      expect(assignmentRows(created.id)).toEqual([]);
    });
  });

  it("PATCH specific → apply_to_all with weekdays → 200, assignments deactivated not deleted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "apply_to_all",
        weekdays: ["tue", "thu"],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("apply_to_all");
      expect(body.weekdays).toEqual(["tue", "thu"]);
      expect(body.assignments).toEqual([]);
      expect(assignmentRows(created.id)).toEqual([{ memberId: memberA, active: 0 }]);
    });
  });

  it("PATCH specific → apply_to_all without weekdays → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "apply_to_all",
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("switching specific → apply_to_all → specific reuses and reactivates the member's row", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      expect(
        (
          await patchReminder(app, deviceKey, created.id, {
            targetingMode: "apply_to_all",
            weekdays: ["mon"],
          })
        ).statusCode
      ).toBe(200);
      const back = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["fri"] }],
      });
      expect(back.statusCode).toBe(200);
      const body = JSON.parse(back.body);
      expect(body.weekdays).toBeNull();
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({ memberId: memberA, weekdays: ["fri"] });
      expect(assignmentRows(created.id)).toEqual([{ memberId: memberA, active: 1 }]);
    });
  });

  it("PATCH on a specific rule with assignments replaces the set and edits text in one request", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const memberB = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        text: "nuevo texto",
        targetingMode: "specific",
        assignments: [{ memberId: memberB, weekdays: ["wed"] }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.text).toBe("nuevo texto");
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({ memberId: memberB, weekdays: ["wed"] });
      expect(assignmentRows(created.id)).toEqual(
        [
          { memberId: memberA, active: 0 },
          { memberId: memberB, active: 1 },
        ].sort((a, b) => a.memberId.localeCompare(b.memberId))
      );
    });
  });

  it("PATCH re-saving a specific rule keeps an assigned member who has since been archived", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        text: "sigue igual",
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["mon", "tue"] }],
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).assignments[0]).toMatchObject({
        memberId: memberA,
        weekdays: ["mon", "tue"],
      });
    });
  });

  it("PATCH calendar_gated apply_to_all → specific with membership assignments → 200", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createCalendarGated(app, deviceKey);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: [] }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("specific");
      expect(body.weekdays).toBeNull();
      expect(body.query).toBe("futbol");
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0].memberId).toBe(memberA);
    });
  });

  it("PATCH calendar_gated → specific with per-assignment weekdays → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createCalendarGated(app, deviceKey);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH calendar_gated specific → apply_to_all needs no extra fields and deactivates the memberships", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createCalendarGated(app, deviceKey, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA }],
      });
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "apply_to_all",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("apply_to_all");
      expect(body.assignments).toEqual([]);
      expect(assignmentRows(created.id)).toEqual([{ memberId: memberA, active: 0 }]);
    });
  });
});
