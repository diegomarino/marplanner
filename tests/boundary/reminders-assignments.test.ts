import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — specific-mode assignment + atomic set-replace boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the routines/reminders-crud
 * suite convention (useIsolatedDb + raw SQL seed helpers).
 * Quickstart Scenario C (per-member weekdays) + Scenario E (atomicity). Covers
 * FR-004/FR-005/FR-009/FR-010/FR-011, REMINDERS-INV-08, REMINDERS-AC-07, SC-002/SC-004.
 * RED until wires createReminder(specific)/replaceAssignments + the PUT route.
 */
describe("reminders-assignments boundary tests", () => {
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

  function seedMember(
    role: "parent" | "child" = "child",
    lifecycle: "active" | "archived" = "active"
  ) {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, `Test Member ${id.slice(0, 4)}`, role, lifecycle, now, now);
    return id;
  }

  async function createSpecificReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    assignments: Array<{ memberId: string; weekdays: string[] }>,
    overrides: Record<string, unknown> = {}
  ) {
    return app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        assignments,
        ...overrides,
      },
    });
  }

  it("rejects replacement for a missing reminder and invalid emission dates without writes", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await app.ready();
      const before = getDb().prepare("SELECT total_changes() AS changes").get();
      const missing = await app.inject({
        method: "PUT",
        url: "/api/reminders/missing/assignments",
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId, weekdays: ["mon"] }] },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "not_found", message: expect.any(String) });
      const invalid = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberId}&date=not-a-date`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: "validation_error",
        message: expect.any(String),
      });
      expect(getDb().prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/reminders (specific) — atomic create (Scenario C, E) ─────────

  it("POST specific create with 2 members creates the rule + assignments atomically → 201, embeds them", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon", "wed"] },
        { memberId: lucasId, weekdays: ["fri"] },
      ]);
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.kind).toBe("scheduled");
      expect(body.targetingMode).toBe("specific");
      expect(body.weekdays).toBeNull();
      expect(body.assignments).toHaveLength(2);

      const pablo = body.assignments.find((a: { memberId: string }) => a.memberId === pabloId);
      const lucas = body.assignments.find((a: { memberId: string }) => a.memberId === lucasId);
      expect(pablo).toMatchObject({ memberId: pabloId, weekdays: ["mon", "wed"], active: true });
      expect(lucas).toMatchObject({ memberId: lucasId, weekdays: ["fri"], active: true });
      expect(pablo.id).toBeTypeOf("string");
    } finally {
      await app.close();
    }
  });

  it("POST specific create where one assignment targets an inactive member → 400, NOTHING persisted — atomic create (INV-08/AC-07, SC-004)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child", "active");
    const ghostId = seedMember("child", "archived");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
        { memberId: ghostId, weekdays: ["fri"] },
      ]);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");

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

  // ── Emission — per-member own weekdays only (Scenario C / FR-011, SC-002) ──

  it("specific rule emits for each member on ONLY their own assigned weekdays (FR-011, SC-002)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon", "wed"] },
        { memberId: lucasId, weekdays: ["fri"] },
      ]);
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      async function emissionsFor(memberId: string, date: string) {
        const res = await app.inject({
          method: "GET",
          url: `/api/reminders/emissions?memberId=${memberId}&date=${date}`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body);
      }

      // 2026-08-17 Mon, 2026-08-19 Wed, 2026-08-21 Fri (matches reminders-emission convention)
      expect(await emissionsFor(pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
      expect(await emissionsFor(pabloId, "2026-08-19")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
      expect(await emissionsFor(pabloId, "2026-08-21")).toEqual([]);

      expect(await emissionsFor(lucasId, "2026-08-21")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
      expect(await emissionsFor(lucasId, "2026-08-17")).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ── GET /:id embeds assignments (matrix data source) ────────────────────────

  it("GET /api/reminders/:id on a specific rule embeds its assignments array (matrix data source)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon", "wed"] },
        { memberId: lucasId, weekdays: ["fri"] },
      ]);
      const created = JSON.parse(createRes.body);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.body);
      expect(body.assignments).toHaveLength(2);
      expect(body.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memberId: pabloId, weekdays: ["mon", "wed"], active: true }),
          expect.objectContaining({ memberId: lucasId, weekdays: ["fri"], active: true }),
        ])
      );
    } finally {
      await app.close();
    }
  });

  // ── PUT /api/reminders/:id/assignments — atomic full-set replace ───────────

  it("PUT assignments — one call that adds a member, removes another (by omission), and changes a weekday set → 200, atomic end-state only", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");
    const mariaId = seedMember("child");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
        { memberId: lucasId, weekdays: ["fri"] },
      ]);
      const created = JSON.parse(createRes.body);

      // New desired set: Pablo's weekdays change (mon -> wed), Lucas omitted (removed),
      // Maria added — all in ONE atomic call.
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          assignments: [
            { memberId: pabloId, weekdays: ["wed"] },
            { memberId: mariaId, weekdays: ["tue"] },
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody).toHaveLength(2);
      expect(putBody).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memberId: pabloId, weekdays: ["wed"], active: true }),
          expect.objectContaining({ memberId: mariaId, weekdays: ["tue"], active: true }),
        ])
      );

      // GET reflects the SAME end-state — Lucas no longer among active assignments.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toHaveLength(2);
      expect(getBody.assignments.map((a: { memberId: string }) => a.memberId).sort()).toEqual(
        [mariaId, pabloId].sort()
      );

      // Lucas no longer emits; Maria emits on Tuesday; Pablo emits on Wednesday, not Monday.
      async function emissionsFor(memberId: string, date: string) {
        const res = await app.inject({
          method: "GET",
          url: `/api/reminders/emissions?memberId=${memberId}&date=${date}`,
          cookies: { mp_device_key: deviceKey },
        });
        return JSON.parse(res.body);
      }
      expect(await emissionsFor(lucasId, "2026-08-21")).toEqual([]);
      expect(await emissionsFor(mariaId, "2026-08-18")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
      expect(await emissionsFor(pabloId, "2026-08-17")).toEqual([]);
      expect(await emissionsFor(pabloId, "2026-08-19")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("PUT assignments with an inactive/archived member in the set → 400, NOTHING persisted (active-member strict-write)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child", "active");
    const ghostId = seedMember("child", "archived");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
      ]);
      const created = JSON.parse(createRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          // Pablo (valid, first) + an archived member (invalid) — proves validation
          // runs over the WHOLE set before any write, not a partial per-row apply.
          assignments: [
            { memberId: pabloId, weekdays: ["wed"] },
            { memberId: ghostId, weekdays: ["fri"] },
          ],
        },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

      // Nothing changed — Pablo's original assignment (mon, not wed) is intact.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toEqual([
        expect.objectContaining({ memberId: pabloId, weekdays: ["mon"], active: true }),
      ]);
    } finally {
      await app.close();
    }
  });

  // ── PUT assignments — relax to newly-added-only active check ─────────

  function archiveMember(id: string) {
    const db = getDb();
    db.prepare("UPDATE members SET lifecycle = 'archived', updated_at = ? WHERE id = ?").run(
      Date.now(),
      id
    );
  }

  it("PUT assignments including an already-assigned member who is now archived → 200, their row is preserved/updated (#401)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child", "active");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
      ]);
      const created = JSON.parse(createRes.body);

      archiveMember(pabloId);

      // Pablo already has an assignment row on this rule — the full-set replace
      // still includes him (with changed weekdays) — must NOT be rejected for
      // being archived, since he is not being newly added.
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          assignments: [{ memberId: pabloId, weekdays: ["wed"] }],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody).toEqual([
        expect.objectContaining({ memberId: pabloId, weekdays: ["wed"], active: true }),
      ]);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toEqual([
        expect.objectContaining({ memberId: pabloId, weekdays: ["wed"], active: true }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("PUT assignments mixing a preserved archived member with a NEWLY-added archived member → 400, nothing persisted (newly-added-only, #401)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child", "active");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
      ]);
      const created = JSON.parse(createRes.body);

      archiveMember(pabloId);
      const ghostId = seedMember("child", "archived");

      // Pablo (already-assigned, archived — would be preserved) + Ghost (brand-new,
      // archived — must still be rejected) in the SAME set-replace. The new member's
      // failure blocks the whole write, so even Pablo's row stays untouched (atomicity).
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          assignments: [
            { memberId: pabloId, weekdays: ["wed"] },
            { memberId: ghostId, weekdays: ["fri"] },
          ],
        },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toEqual([
        expect.objectContaining({ memberId: pabloId, weekdays: ["mon"], active: true }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("PUT assignments re-adding a member who was deactivated (omitted) then archived → 400, must reactivate first (Codex rework)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child", "active");
    const lucasId = seedMember("child", "active");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
        { memberId: lucasId, weekdays: ["fri"] },
      ]);
      const created = JSON.parse(createRes.body);

      // Omit Pablo from a replace — his row goes active=0 (deactivate-by-omission).
      const omitRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          assignments: [{ memberId: lucasId, weekdays: ["fri"] }],
        },
      });
      expect(omitRes.statusCode).toBe(200);

      archiveMember(pabloId);

      // Pablo's ONLY row here is now inactive — re-adding him is effectively a NEW
      // addition (not "already assigned"), so the active check must still apply.
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          assignments: [
            { memberId: lucasId, weekdays: ["fri"] },
            { memberId: pabloId, weekdays: ["wed"] },
          ],
        },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

      // Nothing changed — Pablo stays omitted, Lucas's row is untouched.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toEqual([
        expect.objectContaining({ memberId: lucasId, weekdays: ["fri"], active: true }),
      ]);
    } finally {
      await app.close();
    }
  });

  // ── PUT assignments — reject unknown fields / non-object bodies ──

  it("PUT assignments with an unknown top-level field → 400, nothing persisted (additionalProperties: false)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
      ]);
      const created = JSON.parse(createRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          assignments: [{ memberId: pabloId, weekdays: ["wed"] }],
          revision: 1,
        },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

      // Nothing changed — Pablo's original assignment (mon, not wed) is intact.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toEqual([
        expect.objectContaining({ memberId: pabloId, weekdays: ["mon"], active: true }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("PUT assignments with a JSON array body → 400, nothing persisted", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
      ]);
      const created = JSON.parse(createRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: [{ memberId: pabloId, weekdays: ["wed"] }],
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.assignments).toEqual([
        expect.objectContaining({ memberId: pabloId, weekdays: ["mon"], active: true }),
      ]);
    } finally {
      await app.close();
    }
  });
});
