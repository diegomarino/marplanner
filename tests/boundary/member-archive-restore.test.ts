import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("member-archive-restore (red-by-design, turns green)", () => {
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

  const getMemberRowCount = (db: any) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM members").get() as { count: number };
    return row.count;
  };

  it("POST /members/:id/archive sets lifecycle=archived and returns Member", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const memberId = createMember(db, "Abuelita", "parent", "active");

    const app = await buildApp();

    try {
      let res = await app.inject({
        method: "GET",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
      });
      let body = JSON.parse(res.body);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(memberId);
      expect(body[0].lifecycle).toBe("active");

      res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const archivedMember = JSON.parse(res.body);
      expect(archivedMember.id).toBe(memberId);
      expect(archivedMember.lifecycle).toBe("archived");
      expect(archivedMember.displayName).toBe("Abuelita");

      const memberDb = db
        .prepare("SELECT id, lifecycle FROM members WHERE id = ?")
        .get(memberId) as { id: string; lifecycle: string };

      expect(memberDb.lifecycle).toBe("archived");

      res = await app.inject({
        method: "GET",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
      });
      body = JSON.parse(res.body);
      expect(body.length).toBe(0);

      res = await app.inject({
        method: "GET",
        url: "/api/members?lifecycle=archived",
        cookies: { mp_device_key: deviceKey },
      });
      body = JSON.parse(res.body);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(memberId);
      expect(body[0].lifecycle).toBe("archived");
    } finally {
      await app.close();
    }
  });

  it("re-archive is idempotent 200 no-op", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const memberId = createMember(db, "Abuelita", "parent", "active");

    const app = await buildApp();

    try {
      let res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);

      const rowCountBefore = getMemberRowCount(db);

      res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const rowCountAfter = getMemberRowCount(db);
      expect(rowCountBefore).toBe(rowCountAfter);

      const member = db.prepare("SELECT id, lifecycle FROM members WHERE id = ?").get(memberId) as {
        id: string;
        lifecycle: string;
      };

      expect(member.lifecycle).toBe("archived");
    } finally {
      await app.close();
    }
  });

  it("POST /members/:id/restore returns archived member to active", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const memberId = createMember(db, "Abuelita", "parent", "active");

    // Archive the member first using the API to ensure it's truly archived
    const app = await buildApp();

    try {
      let res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      // Verify pre-restore state is archived
      const memberRow = db.prepare("SELECT lifecycle FROM members WHERE id = ?").get(memberId) as {
        lifecycle: string;
      };
      expect(memberRow.lifecycle).toBe("archived");

      // Restore the member
      res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const memberAfterRestore = JSON.parse(res.body);

      // Assert response is Member DTO with lifecycle=active
      expect(memberAfterRestore.id).toBe(memberId);
      expect(memberAfterRestore.lifecycle).toBe("active");
      expect(memberAfterRestore.displayName).toBe("Abuelita");

      const memberDb = db
        .prepare("SELECT id, lifecycle FROM members WHERE id = ?")
        .get(memberId) as { id: string; lifecycle: string };

      expect(memberDb.lifecycle).toBe("active");

      res = await app.inject({
        method: "GET",
        url: "/api/members",
        cookies: { mp_device_key: deviceKey },
      });
      let body = JSON.parse(res.body);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(memberId);
      expect(body[0].lifecycle).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("re-restore is idempotent 200 no-op", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const memberId = createMember(db, "Abuelita", "parent", "active");

    // Archive first
    const app = await buildApp();

    try {
      let res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);

      // Restore the member
      res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);

      const rowCountBefore = getMemberRowCount(db);
      const memberBefore = db
        .prepare("SELECT id, lifecycle, updated_at FROM members WHERE id = ?")
        .get(memberId) as {
        id: string;
        lifecycle: string;
        updated_at: number;
      };

      // Re-restore (idempotent no-op)
      res = await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);

      const rowCountAfter = getMemberRowCount(db);
      expect(rowCountBefore).toBe(rowCountAfter);

      const memberAfter = db
        .prepare("SELECT id, lifecycle, updated_at FROM members WHERE id = ?")
        .get(memberId) as {
        id: string;
        lifecycle: string;
        updated_at: number;
      };

      expect(memberAfter.lifecycle).toBe("active");
      // Idempotent no-op: updated_at should NOT change
      expect(memberAfter.updated_at).toBe(memberBefore.updated_at);
    } finally {
      await app.close();
    }
  });

  it("POST /members/:id/archive on unknown id returns 404", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    createMember(db, "Abuelita", "parent", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/unknown-id-12345/archive",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("POST /members/:id/restore on unknown id returns 404", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    createMember(db, "Abuelita", "parent", "active");

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/unknown-id-12345/restore",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("the row is NEVER deleted across archive→restore cycle", async () => {
    const { buildApp } = await import("../../src/server/app");

    const db = getDb();
    const deviceKey = seedKeys(db);

    const memberId = createMember(db, "Abuelita", "parent", "active");

    const app = await buildApp();

    try {
      let rowCountBeforeArchive = getMemberRowCount(db);
      expect(rowCountBeforeArchive).toBe(1);

      await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });

      let rowCountAfterArchive = getMemberRowCount(db);
      expect(rowCountAfterArchive).toBe(1);

      await app.inject({
        method: "POST",
        url: `/api/members/${memberId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });

      let rowCountAfterRestore = getMemberRowCount(db);
      expect(rowCountAfterRestore).toBe(1);

      const member = db.prepare("SELECT id, lifecycle FROM members WHERE id = ?").get(memberId) as {
        id: string;
        lifecycle: string;
      };

      expect(member.lifecycle).toBe("active");
    } finally {
      await app.close();
    }
  });
});
