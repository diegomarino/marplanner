import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** / — US1 upsert + validation boundary tests (RED first).
 * REWORK 2: drives the real route via app.inject and asserts the HTTP
 * status, per the reminders-crud.test.ts precedent — the assembly
 * route now maps DailyMessageValidationError/MemberReferenceError -> 400
 * (added to the scope alongside the module hardening). The monotonic
 * same-ms carry-in stays module-level (it exercises DB timing, not the
 * HTTP boundary).
 */
describe("daily-messages-crud (T004/T005 — US1 upsert + validation)", () => {
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

  function countMessageRows(memberId: string, date: string): number {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM daily_messages WHERE member_id = ? AND date = ?")
      .get(memberId, date) as { count: number };
    return row.count;
  }

  function putMessage(app: FastifyInstance, deviceKey: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: "/api/daily-messages",
      cookies: { mp_device_key: deviceKey },
      payload,
    });
  }

  it("PUT replaces the message for (member, date) — second text wins, updatedAt advances, no second row (DAILY-MESSAGES-INV-01/AC-01)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      const firstRes = await putMessage(app, deviceKey, {
        memberId,
        date,
        text: "lleva el paraguas",
      });
      expect(firstRes.statusCode).toBe(200);
      const first = JSON.parse(firstRes.body);

      await new Promise((resolve) => setTimeout(resolve, 5));

      const secondRes = await putMessage(app, deviceKey, {
        memberId,
        date,
        text: "lleva el chubasquero",
      });
      expect(secondRes.statusCode).toBe(200);
      const second = JSON.parse(secondRes.body);

      expect(second.id).toBe(first.id);
      expect(second.text).toBe("lleva el chubasquero");
      expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
      expect(countMessageRows(memberId, date)).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("bumps updated_at strictly even when two replaces land in the SAME millisecond (Codex P2 — monotonic carry-in)", async () => {
    // Module-level per REWORK 2: exercises DB-side timing, not the HTTP boundary.
    const { upsertMessage } = await import("../../src/server/modules/daily-messages/index");
    const memberId = seedMember();
    const date = "2026-08-17";

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
      const first = upsertMessage(memberId, date, "first");
      // Clock is frozen: Date.now returns the identical value for this second
      // call, so the DB-side MAX(excluded.updated_at, stored+1) bump is what
      // must advance updatedAt, not wall-clock drift between the two calls.
      const second = upsertMessage(memberId, date, "second");

      expect(second.updatedAt).toBe(first.updatedAt + 1);
      expect(second.text).toBe("second");
      expect(countMessageRows(memberId, date)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PUT with whitespace-only text -> 400, nothing written, no existing message deleted (DAILY-MESSAGES-AC-03)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      const seedRes = await putMessage(app, deviceKey, { memberId, date, text: "existing text" });
      expect(seedRes.statusCode).toBe(200);

      const res = await putMessage(app, deviceKey, { memberId, date, text: "   \n\t  " });
      expect(res.statusCode).toBe(400);

      expect(countMessageRows(memberId, date)).toBe(1);
      const db = getDb();
      const row = db
        .prepare("SELECT text FROM daily_messages WHERE member_id = ? AND date = ?")
        .get(memberId, date) as { text: string };
      expect(row.text).toBe("existing text");
    } finally {
      await app.close();
    }
  });

  it("PUT with non-string text -> 400, not 500 (Codex P2)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, { memberId, date, text: 123 });
      expect(res.statusCode).toBe(400);
      expect(countMessageRows(memberId, date)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("PUT with verbatim text over the 500-char cap -> 400, never truncated (DAILY-MESSAGES-FR-005)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const overCap = "a".repeat(501);
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, { memberId, date, text: overCap });
      expect(res.statusCode).toBe(400);
      expect(countMessageRows(memberId, date)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("PUT with the boundary case: exactly-500 non-space chars wrapped in surrounding whitespace -> 400 (verbatim >500, trimmed=500 — P2-A)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const trimmedAt500 = "a".repeat(500);
    const verbatimOverCap = ` ${trimmedAt500} `;

    expect(verbatimOverCap.trim().length).toBe(500);
    expect(verbatimOverCap.length).toBeGreaterThan(500);

    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, { memberId, date, text: verbatimOverCap });
      expect(res.statusCode).toBe(400);
      expect(countMessageRows(memberId, date)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("PUT accepts verbatim text at exactly the 500-char cap -> 200", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const exactCap = "a".repeat(500);
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, { memberId, date, text: exactCap });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.text).toBe(exactCap);
      expect(body.text.length).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("PUT to an archived member -> 400 (DAILY-MESSAGES-AC-02/FR-004)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember("archived");
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, {
        memberId,
        date,
        text: "no olvides la mochila",
      });
      expect(res.statusCode).toBe(400);
      expect(countMessageRows(memberId, date)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("PUT to an unknown member -> 400 (DAILY-MESSAGES-AC-02/FR-004)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, {
        memberId: "nonexistent-member-id",
        date,
        text: "no olvides la mochila",
      });
      expect(res.statusCode).toBe(400);
      expect(countMessageRows("nonexistent-member-id", date)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("stores text verbatim byte-for-byte, including surrounding whitespace within the cap (DAILY-MESSAGES-AC-07)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const verbatimText = "  lleva el chubasquero  \n";
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, { memberId, date, text: verbatimText });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.text).toBe(verbatimText);

      const db = getDb();
      const row = db
        .prepare("SELECT text FROM daily_messages WHERE member_id = ? AND date = ?")
        .get(memberId, date) as { text: string };
      expect(row.text).toBe(verbatimText);
    } finally {
      await app.close();
    }
  });

  it("is last-write-wins per (member, date), no etag/version (DAILY-MESSAGES-FR-010)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      await putMessage(app, deviceKey, { memberId, date, text: "first" });
      await putMessage(app, deviceKey, { memberId, date, text: "second" });
      const thirdRes = await putMessage(app, deviceKey, { memberId, date, text: "third" });

      expect(thirdRes.statusCode).toBe(200);
      const third = JSON.parse(thirdRes.body);
      expect(third.text).toBe("third");
      expect(countMessageRows(memberId, date)).toBe(1);
    } finally {
      await app.close();
    }
  });
});
