import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — apply_to_all CRUD boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the routines suite
 * convention (useIsolatedDb + raw SQL seed helpers).
 * Covers: FR-013 (kind/targetingMode immutable on edit), the apply_to_all
 * create/list/get/edit/delete lifecycle. RED until wires
 * listReminders/getReminder/editReminder/deleteReminder + their routes.
 */
describe("reminders-crud boundary tests (T004/T005)", () => {
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

  it("PATCH /api/reminders/:id with targetingMode in body → 400 (immutable, FR-013)", async () => {
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
        payload: { targetingMode: "specific" },
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

  it("PATCH /api/reminders/:id with an unknown field (assignments) → 400, nothing persisted", async () => {
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
});
