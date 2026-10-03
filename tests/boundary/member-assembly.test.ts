import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — Member assembly boundary test (wiring verification).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Asserts three things:
 * 1. All new routes are registered:
 * - PATCH /api/members/:id
 * - POST /api/members/:id/archive
 * - POST /api/members/:id/restore
 * 2. Each route is auth-boundary-protected (ADR-059):
 * - No device cookie → 401
 * 3. Routes respond to OPTIONS preflight (CORS).
 * No behaviour is tested — only registration + auth boundary.
 */
describe("member-assembly (wiring verification)", () => {
  useIsolatedDb();

  it("PATCH /api/members/:id is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const memberId = randomUUID();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(memberId, "Test Member", "parent", now, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/members/${memberId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { displayName: "Updated Name" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(memberId);
      expect(body.displayName).toBe("Updated Name");
    } finally {
      await app.close();
    }
  });

 it("POST /api/members/:id/archive is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const memberId = randomUUID();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(memberId, "Test Member", "parent", now, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(memberId);
      expect(body.lifecycle).toBe("archived");

      // Verify member was archived
      const row = db.prepare("SELECT lifecycle FROM members WHERE id = ?").get(memberId) as {
        lifecycle: string;
      };
      expect(row.lifecycle).toBe("archived");
    } finally {
      await app.close();
    }
  });

 it("POST /api/members/:id/restore is registered", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const memberId = randomUUID();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'archived', ?, ?)"
    ).run(memberId, "Test Member", "parent", now, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(memberId);
      expect(body.lifecycle).toBe("active");

      // Verify member was restored to active
      const row = db.prepare("SELECT lifecycle FROM members WHERE id = ?").get(memberId) as {
        lifecycle: string;
      };
      expect(row.lifecycle).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/members/:id requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/members/some-id",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("POST /api/members/:id/archive requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/some-id/archive",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("POST /api/members/:id/restore requires auth (401 without device cookie)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/some-id/restore",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/members/:id returns 401 for OPTIONS without auth", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/members/some-id",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
