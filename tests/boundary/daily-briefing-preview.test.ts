import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PNG } from "pngjs";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/daily-briefing.md (admin PNG preview, promoted from
 * contracts/openapi.planned.yaml). The route serves the SAME `png` column pressedslip wrote at
 * generation time (schema.ts: "admin/preview surface only") — never re-decodes the packed 1-bit
 * raster, never re-renders. 404 when no briefing row exists at all; 409
 * `printable_raster_missing` when the row exists but `png` is NULL (Printing inactive at
 * generation, or a catastrophic render — D5).
 */
describe("daily-briefing admin preview.png boundary", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let memberId: string;

  beforeEach(async () => {
    const now = Date.now();
    const db = getDb();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    memberId = `member-${now}`;

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`device-${now}`, hashKey(deviceKey), now);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(memberId, "Ada", now, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  function insertBriefing(date: string, png: Buffer | null) {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO daily_briefing
           (id, member_id, date, status, payload, failed_render_blocks, raster_bits, raster_height,
            png, created_at, updated_at)
         VALUES (?, ?, ?, 'ready', '{}', '[]', NULL, NULL, ?, ?, ?)`
      )
      .run(`briefing-${now}-${Math.random().toString(36).slice(2)}`, memberId, date, png, now, now);
  }

  it("404s when no briefing exists for the member/date", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/2026-09-07/preview.png`,
      cookies: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
  });

  it("409 printable_raster_missing when the briefing has no stored png", async () => {
    insertBriefing("2026-09-07", null);

    const res = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/2026-09-07/preview.png`,
      cookies: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "printable_raster_missing" });
  });

  it("200s with the stored PNG bytes verbatim, image/png content-type", async () => {
    const png = new PNG({ width: 2, height: 2 });
    const pngBytes = PNG.sync.write(png);
    insertBriefing("2026-09-07", Buffer.from(pngBytes));

    const res = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/2026-09-07/preview.png`,
      cookies: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(res.rawPayload)).toEqual(Buffer.from(pngBytes));
  });

  it("400s on an invalid date", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/not-a-date/preview.png`,
      cookies: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });
  });
});
