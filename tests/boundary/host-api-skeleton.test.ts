import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import * as hostApi from "../../src/server/host-api";
import { useIsolatedDb } from "../helpers/db";

/** — host-API barrel skeleton (app.inject companion to the process-boot
 * e2e smoke). Proves daily-messages, retrofitted to import
 * assertActiveMember/memberExists/isStrictCalendarDate/getDb from
 *../../host-api instead of directly, still works end-to-end through the
 * real route (upsert + read, active-member gate) — behavior-preserving
 * (docs/features/plugin-system.md FR-004/FR-007).
 */
describe("host-api-skeleton — daily-messages wired through the barrel (T001)", () => {
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

  function putMessage(app: FastifyInstance, deviceKey: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: "/api/daily-messages",
      cookies: { mp_device_key: deviceKey },
      payload,
    });
  }

  it("upsert + current-read round-trips end-to-end through the barrel's assertActiveMember/getDb", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember();
    const date = "2026-08-22";
    const app = await buildApp();
    try {
      const putRes = await putMessage(app, deviceKey, { memberId, date, text: "barrel wired" });
      expect(putRes.statusCode).toBe(200);
      expect(JSON.parse(putRes.body).text).toBe("barrel wired");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/daily-messages/current?memberId=${memberId}&date=${date}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body).text).toBe("barrel wired");
    } finally {
      await app.close();
    }
  });

  it("PUT to an archived member still rejects via the barrel's assertActiveMember (behavior-preserving, DAILY-MESSAGES-AC-02)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember("archived");
    const date = "2026-08-22";
    const app = await buildApp();
    try {
      const res = await putMessage(app, deviceKey, { memberId, date, text: "should reject" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("GET current for an unknown member still 404s via the barrel's memberExists", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/daily-messages/current?memberId=nonexistent&date=2026-08-22",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // Closes: the host-api barrel's `writeClientLog` re-export had no
  // surface assertion anywhere in this suite — a straight named re-export can silently vanish on
  // a barrel refactor with nothing catching it.
  it("re-exports writeClientLog from the barrel surface (#632)", () => {
    expect(typeof hostApi.writeClientLog).toBe("function");
  });
});
