import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Lifecycle-filtered member read boundary test.
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * FRs realized: FR-002, FR-003, FR-004a
 * Scenarios:
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key row + a device key into api_keys.
 * 3. Create test members: one active parent, one archived parent, one active child.
 * 4. Run four GET /api/members variations:
 * a) No query param (default): expect active only → active parent, active child
 * b) ?lifecycle=active: expect active only → same as (a)
 * c) ?lifecycle=archived: expect archived only → archived parent
 * d) ?lifecycle=all: expect both → all three members
 * e) ?lifecycle=unknown: expect 400 Bad Request
 */
describe("member-list-lifecycle (red-by-design, turns green)", () => {
  useIsolatedDb();

  const seedKeys = (db: any) => {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);
    return deviceKey;
  };

  const createMember = (
    db: any,
    displayName: string,
    role: "parent" | "child",
    lifecycle: "active" | "archived"
  ) => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, displayName, role, lifecycle, now, now);
    return id;
  };

  it("default query (no param) returns active members only", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const activeParentId = createMember(db, "Abuelita", "parent", "active");
    const archivedParentId = createMember(db, "Abuelito", "parent", "archived");
    const activeChildId = createMember(db, "Peque", "child", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);

      const ids = body.map((m: any) => m.id);
      expect(ids).toContain(activeParentId);
      expect(ids).toContain(activeChildId);
      expect(ids).not.toContain(archivedParentId);

      body.forEach((m: any) => {
        expect(m.lifecycle).toBe("active");
      });
    } finally {
      await app.close();
    }
  });

  it("?lifecycle=active returns active members only", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const activeParentId = createMember(db, "Abuelita", "parent", "active");
    const archivedParentId = createMember(db, "Abuelito", "parent", "archived");
    const activeChildId = createMember(db, "Peque", "child", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=active",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);

      const ids = body.map((m: any) => m.id);
      expect(ids).toContain(activeParentId);
      expect(ids).toContain(activeChildId);
      expect(ids).not.toContain(archivedParentId);

      body.forEach((m: any) => {
        expect(m.lifecycle).toBe("active");
      });
    } finally {
      await app.close();
    }
  });

  it("?lifecycle=archived returns archived members only", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const activeParentId = createMember(db, "Abuelita", "parent", "active");
    const archivedParentId = createMember(db, "Abuelito", "parent", "archived");
    const activeChildId = createMember(db, "Peque", "child", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=archived",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);

      const ids = body.map((m: any) => m.id);
      expect(ids).not.toContain(activeParentId);
      expect(ids).not.toContain(activeChildId);
      expect(ids).toContain(archivedParentId);

      body.forEach((m: any) => {
        expect(m.lifecycle).toBe("archived");
      });
    } finally {
      await app.close();
    }
  });

  it("?lifecycle=all returns both active and archived members", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const activeParentId = createMember(db, "Abuelita", "parent", "active");
    const archivedParentId = createMember(db, "Abuelito", "parent", "archived");
    const activeChildId = createMember(db, "Peque", "child", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=all",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(3);

      const ids = body.map((m: any) => m.id);
      expect(ids).toContain(activeParentId);
      expect(ids).toContain(archivedParentId);
      expect(ids).toContain(activeChildId);
    } finally {
      await app.close();
    }
  });

  it("?lifecycle=unknown returns 400 Bad Request", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const db = getDb();
    const deviceKey = seedKeys(db);

    createMember(db, "Abuelita", "parent", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=unknown",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });
});
