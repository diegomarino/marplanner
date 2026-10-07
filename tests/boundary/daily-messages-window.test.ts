import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** / — US2 window-list + idempotent delete + missing-vs-empty boundary tests (RED first).
 * Drives the real route via app.inject and asserts the HTTP status, per the
 * daily-messages-crud.test.ts precedent (RED until adds the routes + module functions).
 */
describe("daily-messages-window (US2 window list + delete + missing-vs-empty)", () => {
  useIsolatedDb();

  function seedKeys(): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return deviceKey;
  }

  function seedMember(lifecycle: "active" | "archived" = "active"): string {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', ?, ?, ?)"
    ).run(id, `Member ${id.slice(0, 6)}`, lifecycle, now, now);
    return id;
  }

  function archiveMember(id: string): void {
    const db = getDb();
    db.prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(id);
  }

  function seedMessage(memberId: string, date: string, text: string): void {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO daily_messages (id, member_id, date, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(`${now}-${Math.random().toString(36).slice(2)}`, memberId, date, text, now, now);
  }

  function countMessageRows(memberId: string, date: string): number {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM daily_messages WHERE member_id = ? AND date = ?")
      .get(memberId, date) as { count: number };
    return row.count;
  }

  function listWindow(
    app: FastifyInstance,
    deviceKey: string,
    memberId: string,
    from: string,
    days: number | string
  ) {
    return app.inject({
      method: "GET",
      url: `/api/daily-messages?memberId=${memberId}&from=${from}&days=${days}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function getCurrent(app: FastifyInstance, deviceKey: string, memberId: string, date: string) {
    return app.inject({
      method: "GET",
      url: `/api/daily-messages/current?memberId=${memberId}&date=${date}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function deleteMessage(app: FastifyInstance, deviceKey: string, memberId: string, date: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/daily-messages?memberId=${memberId}&date=${date}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  it("window list is date-ascending over [from, from+days), missing dates absent (DAILY-MESSAGES-INV-08)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    seedMessage(memberId, "2026-08-01", "day one");
    // 2026-08-02 intentionally has no message (missing date absent).
    seedMessage(memberId, "2026-08-03", "day three");
    seedMessage(memberId, "2026-08-04", "outside the window"); // days=3 -> window excludes this
    seedMessage(memberId, "2026-07-31", "before the window");

    const app = await buildApp();
    try {
      const res = await listWindow(app, deviceKey, memberId, "2026-08-01", 3);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ date: string; text: string }>;
      expect(body.map((m) => m.date)).toEqual(["2026-08-01", "2026-08-03"]);
      expect(body[0].text).toBe("day one");
      expect(body[1].text).toBe("day three");
    } finally {
      await app.close();
    }
  });

  it("days <= 0 -> 400 (DAILY-MESSAGES-AC-05)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const res = await listWindow(app, deviceKey, memberId, "2026-08-01", 0);
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("days > 60 -> 400 (DAILY-MESSAGES-AC-05)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const res = await listWindow(app, deviceKey, memberId, "2026-08-01", 61);
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("window list: unknown member -> 404, valid member with no messages -> 200 empty list (DAILY-MESSAGES-AC-04/FR-011)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const unknownRes = await listWindow(app, deviceKey, "nonexistent-member-id", "2026-08-01", 7);
      expect(unknownRes.statusCode).toBe(404);

      const emptyRes = await listWindow(app, deviceKey, memberId, "2026-08-01", 7);
      expect(emptyRes.statusCode).toBe(200);
      expect(JSON.parse(emptyRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET /current: unknown member -> 404, valid member with no message that date -> 200 null (DAILY-MESSAGES-AC-04/FR-016)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const unknownRes = await getCurrent(app, deviceKey, "nonexistent-member-id", "2026-08-01");
      expect(unknownRes.statusCode).toBe(404);

      const absentRes = await getCurrent(app, deviceKey, memberId, "2026-08-01");
      expect(absentRes.statusCode).toBe(200);
      expect(JSON.parse(absentRes.body)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("tolerant read: window list still returns an archived member's historical row (P2-B, DAILY-MESSAGES-FR-004)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember("active");
    seedMessage(memberId, "2026-08-01", "lleva el paraguas");
    archiveMember(memberId);

    const app = await buildApp();
    try {
      const res = await listWindow(app, deviceKey, memberId, "2026-08-01", 1);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ date: string; text: string }>;
      expect(body).toHaveLength(1);
      expect(body[0].text).toBe("lleva el paraguas");
    } finally {
      await app.close();
    }
  });

  it("tolerant read: GET /current still returns an archived member's historical row (P2-B, DAILY-MESSAGES-FR-004)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember("active");
    seedMessage(memberId, "2026-08-01", "lleva el paraguas");
    archiveMember(memberId);

    const app = await buildApp();
    try {
      const res = await getCurrent(app, deviceKey, memberId, "2026-08-01");
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { text: string };
      expect(body.text).toBe("lleva el paraguas");
    } finally {
      await app.close();
    }
  });

  it("idempotent delete: deleting a missing message -> 204 no-op (DAILY-MESSAGES-FR-006)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const res = await deleteMessage(app, deviceKey, memberId, "2026-08-01");
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("idempotent delete: deleting for an unknown member -> 204 no-op, NOT 404 (DAILY-MESSAGES-FR-006)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const app = await buildApp();
    try {
      const res = await deleteMessage(app, deviceKey, "nonexistent-member-id", "2026-08-01");
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("GET /current with a malformed date -> 400 (DAILY-MESSAGES-INV-03 binds every endpoint)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const res = await getCurrent(app, deviceKey, memberId, "2026-02-30");
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("validation_error");
    } finally {
      await app.close();
    }
  });

  it("delete with a malformed date -> 400, not a 204 no-op (DAILY-MESSAGES-INV-03)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const app = await buildApp();
    try {
      const res = await deleteMessage(app, deviceKey, memberId, "2026-02-30");
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("delete removes an existing message (204), leaving it absent on subsequent reads", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-01";
    seedMessage(memberId, date, "lleva el chubasquero");
    expect(countMessageRows(memberId, date)).toBe(1);

    const app = await buildApp();
    try {
      const res = await deleteMessage(app, deviceKey, memberId, date);
      expect(res.statusCode).toBe(204);
      expect(countMessageRows(memberId, date)).toBe(0);

      const readRes = await getCurrent(app, deviceKey, memberId, date);
      expect(readRes.statusCode).toBe(200);
      expect(JSON.parse(readRes.body)).toBeNull();
    } finally {
      await app.close();
    }
  });
});
