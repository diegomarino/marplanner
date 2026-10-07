import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — apply_to_all discriminant boundary tests (RED first).
 * Quickstart Scenario D (apply_to_all half only — the `specific` half lands
 * with /): each case → 400, nothing persisted (SC-001). Covers
 * FR-001/002/006/014.
 */
describe("reminders-discriminant boundary tests — apply_to_all half", () => {
  useIsolatedDb();

  function seedKeys() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return { deviceKey };
  }

  async function expectRejectedAndNothingPersisted(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    payload: Record<string, unknown>
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty("error");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body)).toEqual([]);
  }

  it("apply_to_all create with no weekdays → 400, nothing persisted (FR-006)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
      });
    } finally {
      await app.close();
    }
  });

  it("apply_to_all create with EMPTY weekdays: [] → 400, nothing persisted (passes the DB CHECK, module must reject)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: [],
      });
    } finally {
      await app.close();
    }
  });

  it('apply_to_all create with non-canonical weekday "1" → 400, nothing persisted (SC-005)', async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["1"],
      });
    } finally {
      await app.close();
    }
  });

  it('apply_to_all create with non-canonical weekday "monday" → 400, nothing persisted (SC-005)', async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["monday"],
      });
    } finally {
      await app.close();
    }
  });

  it("create with kind: calendar_gated → 400, nothing persisted (FR-001/002/014)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon"],
      });
    } finally {
      await app.close();
    }
  });

  it("create carrying a query field → 400, nothing persisted (calendar_gated not offered, FR-014)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon"],
        query: "title contains basura",
      });
    } finally {
      await app.close();
    }
  });

  it("create carrying a queryFields field → 400, nothing persisted (calendar_gated not offered, FR-014)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon"],
        queryFields: ["title"],
      });
    } finally {
      await app.close();
    }
  });
});

/** — specific discriminant boundary tests (RED first).
 * Quickstart Scenario D (specific half): each case → 400, nothing persisted
 * (SC-001/SC-003). Covers FR-003/004/005/006, REMINDERS-INV-01/02/09,
 * REMINDERS-AC-04. RED until wires the specific create + assignments
 * set-replace paths.
 */
describe("reminders-discriminant boundary tests — specific half", () => {
  useIsolatedDb();

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

  async function expectCreateRejectedAndNothingPersisted(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    payload: Record<string, unknown>
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty("error");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body)).toEqual([]);
  }

  it("specific create with a rule-level weekdays → 400, nothing persisted (INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        weekdays: ["mon"],
        assignments: [{ memberId, weekdays: ["mon"] }],
      });
    } finally {
      await app.close();
    }
  });

  it("apply_to_all create with per-assignment weekdays (assignments field) → 400, nothing persisted (INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon"],
        assignments: [{ memberId, weekdays: ["mon"] }],
      });
    } finally {
      await app.close();
    }
  });

  it("specific create with assignments omitted → 400, nothing persisted (FR-005: zero assignments)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
      });
    } finally {
      await app.close();
    }
  });

  it("specific create with EMPTY assignments: [] → 400, nothing persisted (FR-005: zero assignments)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        assignments: [],
      });
    } finally {
      await app.close();
    }
  });

  it("specific create with an assignment weekdays: [] → 400, nothing persisted (INV-09/AC-04, SC-001/003)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        assignments: [{ memberId, weekdays: [] }],
      });
    } finally {
      await app.close();
    }
  });

  it("PUT /api/reminders/:id/assignments against an apply_to_all rule → 400, nothing changed", async () => {
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
          targetingMode: "apply_to_all",
          text: "saca la basura",
          weekdays: ["mon"],
        },
      });
      const created = JSON.parse(createRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId, weekdays: ["mon"] }] },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

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

  it("PUT /api/reminders/:id/assignments with assignments: [] → 400 (INV-02: may not drop to zero active assignments)", async () => {
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
      const created = JSON.parse(createRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [] },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

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

  it("PUT /api/reminders/:id/assignments with a per-assignment weekdays: [] → 400, nothing persisted", async () => {
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
      const created = JSON.parse(createRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId, weekdays: [] }] },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

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
});
