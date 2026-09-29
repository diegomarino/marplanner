import { afterEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { useIsolatedDb } from "../helpers/db";

/** / — Day Periods edit boundary test (RED first, before implementation).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Asserts behavior after implementation:
 * 1. PATCH /api/day-periods/afternoon {start:'11:30'} → 200, persists; re-GET shows morning's derived end = '11:30'
 * 2. PATCH /api/day-periods/afternoon {start:'18:00'} → 400 uniqueness; value unchanged
 * 3. PATCH /api/day-periods/afternoon {start:'04:00'} → 400 reorder; value unchanged
 * 4. PATCH /api/day-periods/teatime → 404 unknown id
 * 5. malformed body → 400; re-GET after each 400 asserts stored value intact
 */
describe("day-periods-edit (T008 — RED boundary test)", () => {
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

  async function buildAppAndInsertKey() {
    const { buildApp } = await import("../../src/server/app.ts");
    const rawKey = await insertActiveKey();
    const app = await buildApp();
    return { app, rawKey };
  }

  async function getDayPeriods(app: FastifyInstance, rawKey: string) {
    const res = await app.inject({
      method: "GET",
      url: "/api/day-periods",
      cookies: { mp_device_key: rawKey },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload) as Array<{ id: string; start: string }>;
  }

  let app: FastifyInstance | undefined;
  let rawKey = "";

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("PATCH /api/day-periods/afternoon {start:'11:30'} → 200, persists; re-GET shows morning's derived end = '11:30'", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const before = await getDayPeriods(app, rawKey);
    const afternoonBefore = before.find((p) => p.id === "afternoon");
    expect(afternoonBefore?.start).toBe("12:00");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/afternoon",
      cookies: { mp_device_key: rawKey },
      payload: { start: "11:30" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe("afternoon");
    expect(body.start).toBe("11:30");

    const after = await getDayPeriods(app, rawKey);
    const afternoonAfter = after.find((p) => p.id === "afternoon");
    expect(afternoonAfter?.start).toBe("11:30");

    const morningAfter = after.find((p) => p.id === "morning");
    expect(morningAfter?.start).toBe("05:00");

    const { derivedEndMinutes } = await import("../../src/shared/dayPeriods");
    const morningEnd = derivedEndMinutes(after as any, "morning");
    expect(morningEnd).toBe(hhmmToMinutes("11:30"));
  });

  it("PATCH /api/day-periods/afternoon {start:'18:00'} (equals evening's start) → 400 uniqueness; re-GET shows value UNCHANGED", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const before = await getDayPeriods(app, rawKey);
    const afternoonBefore = before.find((p) => p.id === "afternoon");
    expect(afternoonBefore?.start).toBe("12:00");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/afternoon",
      cookies: { mp_device_key: rawKey },
      payload: { start: "18:00" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("validation_error");

    const after = await getDayPeriods(app, rawKey);
    const afternoonAfter = after.find((p) => p.id === "afternoon");
    expect(afternoonAfter?.start).toBe("12:00");
  });

  it("PATCH /api/day-periods/afternoon {start:'04:00'} (crosses morning — would reorder) → 400 reorder; re-GET shows value UNCHANGED", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const before = await getDayPeriods(app, rawKey);
    const afternoonBefore = before.find((p) => p.id === "afternoon");
    expect(afternoonBefore?.start).toBe("12:00");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/afternoon",
      cookies: { mp_device_key: rawKey },
      payload: { start: "04:00" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("validation_error");

    const after = await getDayPeriods(app, rawKey);
    const afternoonAfter = after.find((p) => p.id === "afternoon");
    expect(afternoonAfter?.start).toBe("12:00");
  });

  it("PATCH /api/day-periods/teatime (unknown id) → 404", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/teatime",
      cookies: { mp_device_key: rawKey },
      payload: { start: "15:00" },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("not_found");
  });

  it("PATCH malformed body {start:'99:99'} → 400; re-GET shows value UNCHANGED", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const before = await getDayPeriods(app, rawKey);
    const afternoonBefore = before.find((p) => p.id === "afternoon");
    expect(afternoonBefore?.start).toBe("12:00");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/afternoon",
      cookies: { mp_device_key: rawKey },
      payload: { start: "99:99" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("validation_error");

    const after = await getDayPeriods(app, rawKey);
    const afternoonAfter = after.find((p) => p.id === "afternoon");
    expect(afternoonAfter?.start).toBe("12:00");
  });

  it("PATCH afternoon with {start:'11:30',bogus:'x'} → 400; value UNCHANGED (strict schema)", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const before = await getDayPeriods(app, rawKey);
    const afternoonBefore = before.find((p) => p.id === "afternoon");
    expect(afternoonBefore?.start).toBe("12:00");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/afternoon",
      cookies: { mp_device_key: rawKey },
      payload: { start: "11:30", bogus: "x" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("validation_error");

    const after = await getDayPeriods(app, rawKey);
    const afternoonAfter = after.find((p) => p.id === "afternoon");
    expect(afternoonAfter?.start).toBe("12:00");
  });

  it("PATCH missing start field → 400; re-GET shows value UNCHANGED", async () => {
    const result = await buildAppAndInsertKey();
    app = result.app;
    rawKey = result.rawKey;

    const before = await getDayPeriods(app, rawKey);
    const afternoonBefore = before.find((p) => p.id === "afternoon");
    expect(afternoonBefore?.start).toBe("12:00");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/day-periods/afternoon",
      cookies: { mp_device_key: rawKey },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("validation_error");

    const after = await getDayPeriods(app, rawKey);
    const afternoonAfter = after.find((p) => p.id === "afternoon");
    expect(afternoonAfter?.start).toBe("12:00");
  });
});

function hhmmToMinutes(hhmm: string): number {
  const match = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid time format: "${hhmm}". Expected "HH:MM".`);
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23) {
    throw new Error(`Hour out of range: ${hour}. Must be 0..23.`);
  }
  if (minute < 0 || minute > 59) {
    throw new Error(`Minute out of range: ${minute}. Must be 0..59.`);
  }
  return hour * 60 + minute;
}
