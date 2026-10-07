import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("member-admin-gate (negative tests for member admin authorization)", () => {
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
    lifecycle: "active" | "archived" = "active"
  ) => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, displayName, role, lifecycle, now, now);
    return id;
  };

  describe("legacy /members route is absent", () => {
    it("legacy /members management routes are NOT registered (specs/002-members-referential-root/spec.md FR-012/FR-013)", async () => {
      const { buildApp } = await import("../../src/server/app");
      const app = await buildApp();
      try {
        // The bare (non-/api) legacy management surface must not exist as a Fastify route.
        expect(app.hasRoute({ method: "GET", url: "/members" })).toBe(false);
        expect(app.hasRoute({ method: "POST", url: "/members" })).toBe(false);
        expect(app.hasRoute({ method: "GET", url: "/members/:id" })).toBe(false);
        expect(app.hasRoute({ method: "PATCH", url: "/members/:id" })).toBe(false);
        expect(app.hasRoute({ method: "GET", url: "/api/members" })).toBe(true);
        expect(app.hasRoute({ method: "DELETE", url: "/members/:id" })).toBe(false);
      } finally {
        await app.close();
      }
    });
    it("POST /api/members with valid device key succeeds, PIN not consulted", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      const deviceKey = seedKeys(db);

      createMember(db, "Parent Member", "parent");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: {
            displayName: "Child Member",
            role: "child" as const,
          },
        });

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("Child Member");
        expect(body.role).toBe("child");
        expect(body.lifecycle).toBe("active");

        const members = db
          .prepare("SELECT id, display_name, role FROM members WHERE display_name = ?")
          .all("Child Member") as any[];
        expect(members.length).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("PATCH /api/members/:id requires device key, 401 without", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      seedKeys(db);
      const memberId = createMember(db, "Original Name", "parent");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${memberId}`,
          payload: {
            displayName: "Updated Name",
          },
        });

        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("PATCH /api/members/:id with valid device key succeeds, regardless of member role", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const memberId = createMember(db, "Child Member", "child");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${memberId}`,
          cookies: { mp_device_key: deviceKey },
          payload: {
            displayName: "Updated Child Name",
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("Updated Child Name");

        const updated = db
          .prepare("SELECT display_name FROM members WHERE id = ?")
          .get(memberId) as any;
        expect(updated.display_name).toBe("Updated Child Name");
      } finally {
        await app.close();
      }
    });

    it("POST /api/members/:id/archive requires device key, 401 without", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      seedKeys(db);
      const memberId = createMember(db, "To Archive", "parent");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/members/${memberId}/archive`,
        });

        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("POST /api/members/:id/archive with valid device key succeeds, PIN not consulted", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const memberId = createMember(db, "Child To Archive", "child");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/members/${memberId}/archive`,
          cookies: { mp_device_key: deviceKey },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.lifecycle).toBe("archived");

        const archived = db
          .prepare("SELECT lifecycle FROM members WHERE id = ?")
          .get(memberId) as any;
        expect(archived.lifecycle).toBe("archived");
      } finally {
        await app.close();
      }
    });

    it("POST /api/members/:id/restore requires device key, 401 without", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      seedKeys(db);

      const memberId = createMember(db, "To Restore", "parent", "archived");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/members/${memberId}/restore`,
        });

        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("POST /api/members/:id/restore with valid device key succeeds, PIN not consulted", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const memberId = createMember(db, "Parent To Restore", "parent", "archived");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/members/${memberId}/restore`,
          cookies: { mp_device_key: deviceKey },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.lifecycle).toBe("active");

        const restored = db
          .prepare("SELECT lifecycle FROM members WHERE id = ?")
          .get(memberId) as any;
        expect(restored.lifecycle).toBe("active");
      } finally {
        await app.close();
      }
    });
  });

  describe("device key alone authorizes mutations (member role irrelevant)", () => {
    it("parent member cannot authorize mutation without device key", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      seedKeys(db);

      const memberId = createMember(db, "Parent Without Key", "parent");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/members/${memberId}/archive`,
        });

        expect(res.statusCode).toBe(401);

        const dbMember = db
          .prepare("SELECT lifecycle FROM members WHERE id = ?")
          .get(memberId) as any;
        expect(dbMember.lifecycle).toBe("active");
      } finally {
        await app.close();
      }
    });

    it("child member mutations work with device key (role does not gate)", async () => {
      const { buildApp } = await import("../../src/server/app");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const memberId = createMember(db, "Child Member", "child");

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/members/${memberId}/archive`,
          cookies: { mp_device_key: deviceKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.lifecycle).toBe("archived");
      } finally {
        await app.close();
      }
    });
  });
});
