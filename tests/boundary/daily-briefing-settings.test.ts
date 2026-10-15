import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { resolveMemberBlockSettings } from "../../src/server/modules/daily-briefing/settings";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/daily-briefing.md ( contracts/
 * openapi.planned.yaml). Every write-path assertion goes through the registered HTTP surface
 * (deviceKeyCookie auth, matching every other daily-briefing route); `resolveMemberBlockSettings`
 * is exercised directly ONLY for the FR-013 default-resolution rule, which has no dedicated read
 * route (the generation is its only other caller).
 */
describe("daily-briefing settings boundary", () => {
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

  // ── GET/PUT /api/daily-briefing/settings ─────────────────────────────────────────────────

  it("GET settings returns documented defaults when no row exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      generationTime: "06:00",
      autoPrintTrigger: null,
      blockOrder: [],
      memberBlockSettings: [],
      memberSchedules: [],
    });
  });

  it("PUT settings updates generationTime and autoPrintTrigger, then GET reflects it", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "07:30", autoPrintTrigger: "morning_complete" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      generationTime: "07:30",
      autoPrintTrigger: "morning_complete",
    });

    const get = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
    });
    expect(get.json()).toMatchObject({
      generationTime: "07:30",
      autoPrintTrigger: "morning_complete",
    });
  });

  it("PUT settings with autoPrintTrigger: null explicitly clears an existing binding", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { autoPrintTrigger: "morning_complete" },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { autoPrintTrigger: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ autoPrintTrigger: null });
  });

  it("PUT settings is partial: omitting a field keeps its current value", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "08:15" },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { autoPrintTrigger: "morning_complete" },
    });
    expect(res.json()).toMatchObject({
      generationTime: "08:15",
      autoPrintTrigger: "morning_complete",
    });
  });

  it("rejects a bad HH:MM generationTime with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "7:30" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });
  });

  it("rejects an out-of-range HH:MM generationTime with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "24:00" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown trigger kind with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { autoPrintTrigger: "always" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });
  });

  it("rejects an unsupported field in the settings body", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "07:00", nonsense: true },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── PUT /api/daily-briefing/block-order ──────────────────────────────────────────────────

  it("PUT block-order accepts a valid ordered list, including a repeated type with distinct params", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-order",
      cookies: auth(),
      payload: [
        { type: "message" },
        { type: "trivia", params: { difficulty: "easy" } },
        { type: "trivia", params: { difficulty: "hard" } },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      blockOrder: [
        { type: "message" },
        { type: "trivia", params: { difficulty: "easy" } },
        { type: "trivia", params: { difficulty: "hard" } },
      ],
    });

    const get = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
    });
    expect(get.json()).toMatchObject({
      blockOrder: [
        { type: "message" },
        { type: "trivia", params: { difficulty: "easy" } },
        { type: "trivia", params: { difficulty: "hard" } },
      ],
    });
  });

  it("rejects an unknown block type in block-order with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-order",
      cookies: auth(),
      payload: [{ type: "not-a-real-block" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });
  });

  it("rejects a non-array block-order body with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-order",
      cookies: auth(),
      payload: { type: "message" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── PUT /api/daily-briefing/block-settings/:memberId/:blockType ─────────────────────────

  it("PUT block-settings sets enabled/weekdays/params for a member+block, then lists it via GET", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/trivia`,
      cookies: auth(),
      payload: { enabled: false, weekdays: ["wed", "mon"], params: { difficulty: "hard" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      memberId,
      blockType: "trivia",
      enabled: false,
      weekdays: ["mon", "wed"], // canonical order
      params: { difficulty: "hard" },
    });

    const get = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
    });
    expect(get.json()).toMatchObject({
      memberBlockSettings: [
        {
          memberId,
          blockType: "trivia",
          enabled: false,
          weekdays: ["mon", "wed"],
          params: { difficulty: "hard" },
        },
      ],
    });
  });

  it("PUT block-settings is partial: omitting a field keeps its current persisted value", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { weekdays: ["fri"] },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { enabled: false },
    });
    expect(res.json()).toMatchObject({ enabled: false, weekdays: ["fri"] });
  });

  it("weekdays: null explicitly clears back to 'all days'", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { weekdays: ["fri"] },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { weekdays: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ weekdays: null });
  });

  it("rejects an unknown block type in the URL with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/not-a-real-block`,
      cookies: auth(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });
  });

  it("rejects a bad weekday value with 400", async () => {
    for (const weekdays of [["funday"], [1], ["mon", 1], 1, "mon", {}]) {
      const res = await app.inject({
        method: "PUT",
        url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
        cookies: auth(),
        payload: { weekdays },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation_error" });
      expect(
        getDb()
          .prepare("SELECT * FROM daily_briefing_member_block_settings WHERE member_id = ?")
          .all(memberId)
      ).toEqual([]);
    }
  });

  it("rejects a MIXED valid+invalid weekday array with 400, persisting NOTHING from it (P2-2 batch-B review)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { weekdays: ["monday", "fri"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });

    // The whole write must have been rejected — "fri" (the one valid entry) must NOT have been
    // silently accepted while "monday" was dropped (the exact accept-then-discard bug this test
    // guards against).
    const row = getDb()
      .prepare(
        "SELECT * FROM daily_briefing_member_block_settings WHERE member_id = ? AND block_type = ?"
      )
      .get(memberId, "dadJoke");
    expect(row).toBeUndefined();
  });

  it("weekdays round-trips to EXACTLY the 7 canonical values, deduplicated and canonically ordered (P2-2 batch-B review)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      // Scrambled order + a duplicate — every one of the 7 canonical values, no more, no less.
      payload: { weekdays: ["sun", "wed", "mon", "fri", "tue", "sat", "thu", "sun"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    });
  });

  it("weekdays: [] is accepted and is a DISTINCT state from null — 'never runs', not 'all days' (P2-3 batch-B review)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { weekdays: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ weekdays: [] });

    const get = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
    });
    expect(get.json()).toMatchObject({
      memberBlockSettings: [{ memberId, blockType: "dadJoke", weekdays: [] }],
    });
  });

  it("rejects a nonexistent member with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-settings/no-such-member/dadJoke",
      cookies: auth(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── FR-009: language validation against corpus availability ─────────────────────────────

  it("rejects a language param on a non-corpus block type (400 corpus_language_unavailable)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/message`,
      cookies: auth(),
      payload: { params: { language: "en" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "corpus_language_unavailable" });
  });

  it("rejects a language with no on-disk corpus for that type (riddle is EN-only) with 400 corpus_language_unavailable", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/riddle`,
      cookies: auth(),
      payload: { params: { language: "es" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "corpus_language_unavailable" });
  });

  it("accepts a language with an available corpus", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/animalFact`,
      cookies: auth(),
      payload: { params: { language: "es" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ params: { language: "es" } });
  });

  it("also rejects an unavailable block-order instance language (params validated the same way)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-order",
      cookies: auth(),
      payload: [{ type: "riddle", params: { language: "es" } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "corpus_language_unavailable" });
  });

  // ── FR-013: onThisDay default-disabled bootstrap ─────────────────────────────────────────

  it("onThisDay resolves disabled by default with no persisted row (no seed write)", () => {
    const resolved = resolveMemberBlockSettings(memberId, "onThisDay");
    expect(resolved).toMatchObject({ enabled: false, weekdays: null, params: null });

    // No seed write: the aggregate settings read stays empty for this member+type.
    const row = getDb()
      .prepare(
        "SELECT * FROM daily_briefing_member_block_settings WHERE member_id = ? AND block_type = ?"
      )
      .get(memberId, "onThisDay");
    expect(row).toBeUndefined();
  });

  it("every other block type resolves enabled by default with no persisted row", () => {
    expect(resolveMemberBlockSettings(memberId, "dadJoke")).toMatchObject({ enabled: true });
    expect(resolveMemberBlockSettings(memberId, "trivia")).toMatchObject({ enabled: true });
  });

  it("an explicit write can still enable onThisDay for one member", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/onThisDay`,
      cookies: auth(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(resolveMemberBlockSettings(memberId, "onThisDay")).toMatchObject({ enabled: true });
  });

  // ── FR-022: settings writes NEVER regenerate/invalidate existing briefings ──────────────

  it("settings writes never mutate an existing briefing row's updated_at", async () => {
    const now = Date.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at)
       VALUES ('briefing-fence', ?, '2026-09-08', 'ready', '{}', ?, ?)`
    ).run(memberId, now, now);

    await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/settings",
      cookies: auth(),
      payload: { generationTime: "09:00", autoPrintTrigger: "morning_complete" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/daily-briefing/block-order",
      cookies: auth(),
      payload: [{ type: "message" }],
    });
    await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/block-settings/${memberId}/dadJoke`,
      cookies: auth(),
      payload: { enabled: false },
    });

    const row = db
      .prepare("SELECT updated_at, status, payload FROM daily_briefing WHERE id = 'briefing-fence'")
      .get() as { updated_at: number; status: string; payload: string };
    expect(row.updated_at).toBe(now);
    expect(row.status).toBe("ready");
    expect(row.payload).toBe("{}");
  });
});
