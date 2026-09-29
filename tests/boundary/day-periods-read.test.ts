import { afterEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { useIsolatedDb } from "../helpers/db";
import { resetDb } from "../../src/server/db/client";

/** / — Day Periods read boundary test (RED first, before implementation).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Asserts behavior after implementation:
 * 1. GET /api/day-periods with device cookie → 200, returns exactly 4 DayPeriodDTO ordered by start
 * 2. No device cookie → 401
 * 3. NO add/delete route is registered (app.hasRoute === false)
 * 4. Re-read after simulated restart returns identical data
 */
describe("day-periods-read (T006 — RED boundary test)", () => {
  useIsolatedDb();

  async function insertActiveKey(): Promise<string> {
    const { randomBytes } = await import("node:crypto");
    const { generateKey, hashKey } = await import("../../src/server/auth/credentials");
    const { getDb } = await import("../../src/server/db/client");

    const rawKey = generateKey();
    const keyHash = hashKey(rawKey);
    const keyId = randomBytes(16).toString("hex");
    const now = Date.now();

    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)`
    ).run(keyId, keyHash, now);

    return rawKey;
  }

  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("GET /api/day-periods returns 4 DayPeriodDTO ordered by start (05:00,12:00,18:00,21:00)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const rawKey = await insertActiveKey();
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/day-periods",
      cookies: { mp_device_key: rawKey },
    });

    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(4);

    const expectedOrder = [
      { id: "morning", start: "05:00", labelKey: "dayPeriod.morning" },
      { id: "afternoon", start: "12:00", labelKey: "dayPeriod.afternoon" },
      { id: "evening", start: "18:00", labelKey: "dayPeriod.evening" },
      { id: "night", start: "21:00", labelKey: "dayPeriod.night" },
    ];

    for (let i = 0; i < expectedOrder.length; i++) {
      expect(body[i]).toEqual({
        id: expectedOrder[i].id,
        start: expectedOrder[i].start,
        labelKey: expectedOrder[i].labelKey,
        sortOrder: i,
      });
    }
  });

  it("GET /api/day-periods requires device cookie (401 without auth)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/day-periods",
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /api/day-periods is NOT registered (no add route)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();

    expect(app.hasRoute({ method: "POST", url: "/api/day-periods" })).toBe(false);
  });

  it("DELETE /api/day-periods is NOT registered (no delete route)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();

    expect(app.hasRoute({ method: "DELETE", url: "/api/day-periods" })).toBe(false);
  });

  it("GET /api/day-periods is identical after simulated restart (rebuild app)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const rawKey = await insertActiveKey();

    app = await buildApp();
    const res1 = await app.inject({
      method: "GET",
      url: "/api/day-periods",
      cookies: { mp_device_key: rawKey },
    });

    await app.close();
    resetDb(); // drop the connection so buildApp reopens the SQLite file (real restart)

    const app2 = await buildApp();
    const res2 = await app2.inject({
      method: "GET",
      url: "/api/day-periods",
      cookies: { mp_device_key: rawKey },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const body1 = JSON.parse(res1.payload);
    const body2 = JSON.parse(res2.payload);

    expect(body1).toEqual(body2);
  });
});
