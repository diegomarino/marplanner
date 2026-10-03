import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import type { FastifyInstance } from "fastify";
import type { DailyMessage } from "../../src/shared";

/** Daily Messages assembly smoke (— ADR-059 / Constitution XIII).
 * REAL-PROCESS proof, not `app.inject`: boots the app with a real listening
 * socket (`app.listen({ port: 0 })`) and drives Quickstart Scenario A over
 * actual HTTP against that port, with the device-key cookie set the same way
 * a real client would send it.
 * RED until: /api/daily-messages and /api/daily-messages/current don't exist yet.
 */
describe("daily-messages-assembly (real-process smoke, Scenario A)", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let baseUrl: string;
  let deviceKey: string;
  let memberId: string;

  beforeEach(async () => {
    deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, deviceHash, now);

    memberId = `${now}-member`;
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(memberId, "Pablo", now, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a real TCP address from app.listen({ port: 0 })");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("Scenario A: upsert a message, then read it (and its absence) over real HTTP", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;
    const messageDate = "2026-08-17";
    const otherDate = "2026-08-18";
    const text = "lleva el chubasquero";

    // 1. PUT /api/daily-messages {memberId, date, text} -> 200
    const putRes = await fetch(`${baseUrl}/api/daily-messages`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ memberId, date: messageDate, text }),
    });
    expect(putRes.status).toBe(200);
    const upserted = (await putRes.json()) as DailyMessage;
    expect(upserted.id).toBeTypeOf("string");
    expect(upserted.memberId).toBe(memberId);
    expect(upserted.date).toBe(messageDate);
    expect(upserted.text).toBe(text);

    // 2. GET /api/daily-messages/current?memberId=&date=<messageDate> -> 200, the text
    const currentRes = await fetch(
      `${baseUrl}/api/daily-messages/current?memberId=${memberId}&date=${messageDate}`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(currentRes.status).toBe(200);
    const current = (await currentRes.json()) as DailyMessage;
    expect(current.text).toBe(text);
    expect(current.memberId).toBe(memberId);

    // 3. GET /api/daily-messages/current?memberId=&date=<otherDate> -> 200, absence (null)
    const absentRes = await fetch(
      `${baseUrl}/api/daily-messages/current?memberId=${memberId}&date=${otherDate}`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(absentRes.status).toBe(200);
    const absent = await absentRes.json();
    expect(absent).toBeNull();
  });
});
