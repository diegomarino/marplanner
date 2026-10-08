import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BlockInstance, Briefing, BriefingReadResult, OptInState } from "../../src/shared";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { deriveStatus } from "../../src/server/modules/daily-briefing";
import { useIsolatedDb } from "../helpers/db";

/** RED contract for. Every assertion is through the registered HTTP
 * surface; source data is seeded in the real isolated SQLite database.
 */
describe("daily-briefing generate + read boundary", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let memberId: string;
  const date = "2026-08-21"; // Friday

  beforeEach(async () => {
    // Calendar accepts a sliding read window; keep the fixed fixture date inside it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
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
    vi.useRealTimers();
    await app?.close();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  function seedOptIn(id = memberId) {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
      )
      .run(id, now, now);
  }

  function seedAllFourBlocks(targetDate = date) {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES ('calendar-t006', 'local', 'Household event', 1, ?, ?, ?, ?)"
    ).run(targetDate, "2026-08-22", now, now);
    //: "today" (blocks/today.ts) queries getEvents with `assignedTo: memberId` —
    // stricter than 010's own unfiltered "all events" query — so the event needs an explicit
    // assignment row to surface in THIS member's "today" block.
    db.prepare(
      "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('assignment-calendar-t006', 'calendar-t006', ?, ?)"
    ).run(memberId, now);
    db.prepare(
      `INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at) VALUES ('reminder-t006', 'scheduled', 'apply_to_all', 'Pack bag', '["fri"]', 1, ?, ?)`
    ).run(now, now);
    db.prepare(
      "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES ('routine-t006', 'morning', 'Morning jobs', 1, ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES ('chore-t006', 'routine-t006', 'Make bed', 0, 1, ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES ('assignment-t006', 'routine-t006', ?, '[\"fri\"]', 1, ?, ?)"
    ).run(memberId, now, now);
    db.prepare(
      "INSERT INTO meal_entries (id, meal_plan_id, weekday, entry_date, slot, recipe_id, note, created_at) VALUES ('meal-t006', NULL, NULL, ?, 'lunch', NULL, 'Soup', ?)"
    ).run(targetDate, now);
  }

  async function generate(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      cookies: auth(),
      payload: body,
    });
  }

  // note: `generateBriefing` now assembles the FULL 21-block registry
  // (envelope v2), replacing 010's four merged domains (calendar/reminders/chores/meals) with
  // the v1-ported registry types — `today` (was `calendar`, getEvents-backed), `streak` (a
  // DERIVED chore-completion summary, replacing the raw board `chores` block — the registry has
  // no "raw chore list" type), `reminders` (unchanged type name/shape) and `meals` (unchanged).
  // The seeded fixtures below feed the SAME underlying tables 010 used; only the block TYPE names
  // and a couple of shapes changed. These tests now assert per-type PRESENCE/content via `.find`
  // rather than an exact ordered array, since the full registry also emits deterministic
  // corpus-backed content (dadJoke, wordSearch, …) and (for this seeded active member) a
  // `shotgun` ranking alongside the four domain blocks under test.
  it("gathers the domain sources (today/reminders/streak/meals) with the correct member/shared scopes", async () => {
    seedOptIn();
    seedAllFourBlocks();

    const response = await generate({ memberId, date });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.status).toBe("ready");
    expect(briefing.payload.blocks.every((block) => block.status === "ok")).toBe(true);

    const byType = (type: string) => briefing.payload.blocks.find((block) => block.type === type);
    expect(byType("today")).toMatchObject({ scope: "member", status: "ok" });
    expect((byType("today")?.data as { bullets: string[] }).bullets).toEqual(
      expect.arrayContaining([expect.stringContaining("Household event")])
    );
    expect(byType("reminders")).toMatchObject({
      scope: "member",
      status: "ok",
      data: { groups: [{ items: [{ value: "Pack bag" }] }] },
    });
    // "streak" replaces 010's raw "chores" block — it derives a completion SUMMARY (days/label/
    // last7) rather than surfacing the routine/chore rows directly; its mere PRESENCE proves the
    // seeded routine/chore/assignment fixture reached the routines domain read (`getBoard`).
    expect(byType("streak")).toMatchObject({ scope: "member", status: "ok" });
    expect(byType("meals")).toMatchObject({
      scope: "shared",
      status: "ok",
      data: { lunch: [{ kind: "note", label: "Soup" }] },
    });
  });

  it("omits empty domain blocks on a quiet day (still ready via corpus content), and reads the frozen payload without writes", async () => {
    seedOptIn();

    const response = await generate({ memberId, date: "2026-08-22" });
    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.status).toBe("ready");
    // No calendar/reminders/routines/meals data was seeded for this date — those four domain
    // block types are correctly OMITTED (never a third "empty" state); the full registry's
    // deterministic corpus-backed blocks still populate the briefing (never `blocks: []` once
    // lands — see the comment above this describe block's first test).
    const types = briefing.payload.blocks.map((block) => block.type);
    expect(types).not.toContain("today");
    expect(types).not.toContain("reminders");
    expect(types).not.toContain("meals");
    expect(briefing.payload.blocks.length).toBeGreaterThan(0);
    expect(briefing.payload).not.toHaveProperty("raster");
    expect(briefing).not.toHaveProperty("printedStatus");

    const read = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/2026-08-22`,
      cookies: auth(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<BriefingReadResult>()).toEqual({
      generated: true,
      briefing,
      printedStatus: "none",
    });

    const before = getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing").get();
    const missing = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/2026-08-23`,
      cookies: auth(),
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json<BriefingReadResult>()).toEqual({ generated: false });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing").get()).toEqual(before);
  });

  it("records an isolated gather failure (today, was calendar) as gather_failed while other domain blocks still render", async () => {
    const staleCalendarDate = "2026-07-03"; // Friday, outside Calendar's fixed -30d window.
    seedOptIn();
    seedAllFourBlocks(staleCalendarDate);

    const response = await generate({ memberId, date: staleCalendarDate });

    expect(response.statusCode).toBe(200);
    const briefing = response.json<Briefing>();
    expect(briefing.status).toBe("partial");
    // "today" reads through the SAME getEvents fixed -30d/+365d window as 010's "calendar" did
    // (`blocks/today.ts` — host-api-barrel-exported `getEvents`), so the identical stale date
    // still throws `WindowError`, isolated here exactly like 010's own gather-failure isolation.
    expect(briefing.payload.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "today",
          scope: "member",
          status: "failed",
          error: "gather_failed",
        }),
        expect.objectContaining({ type: "reminders", status: "ok" }),
        expect.objectContaining({ type: "streak", status: "ok" }),
        expect.objectContaining({ type: "meals", status: "ok" }),
      ])
    );
  });

  it("uses the household timezone when date is omitted", async () => {
    seedOptIn();
    vi.setSystemTime(new Date("2026-08-21T00:30:00.000Z"));
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
      )
      .run(JSON.stringify({ timezone: "America/Los_Angeles" }), Date.now());

    const response = await generate({ memberId });

    expect(response.statusCode).toBe(200);
    expect(response.json<Briefing>().date).toBe("2026-08-20");
  });

  it("enforces opt-in and active lifecycle before any generation write", async () => {
    const nonOpted = await generate({ memberId, date });
    expect(nonOpted.statusCode).toBe(400);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?")
        .get(memberId)
    ).toEqual({ count: 0 });

    seedOptIn();
    getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberId);
    const archived = await generate({ memberId, date });
    expect(archived.statusCode).toBe(400);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?")
        .get(memberId)
    ).toEqual({ count: 0 });
  });

  it("rejects unknown generate fields and strict-invalid dates on both write and read paths", async () => {
    seedOptIn();

    expect((await generate({ memberId, date, extra: true })).statusCode).toBe(400);
    const invalidWrite = await generate({ memberId, date: "2026-02-31" });
    expect(invalidWrite.statusCode).toBe(400);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ? AND date = ?")
        .get(memberId, "2026-02-31")
    ).toEqual({ count: 0 });

    const invalidRead = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/2026-02-31`,
      cookies: auth(),
    });
    expect(invalidRead.statusCode).toBe(400);
  });

  it("lets an admin enable opt-in for an active member through the US1 PUT route", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/opt-in/${memberId}`,
      cookies: auth(),
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<OptInState>()).toEqual({ memberId, enabled: true });
    expect(
      getDb().prepare("SELECT enabled FROM daily_briefing_optin WHERE member_id = ?").get(memberId)
    ).toEqual({ enabled: 1 });
  });
});

describe("daily-briefing derived status", () => {
  const ok = (type: BlockInstance["type"]): BlockInstance => ({
    type,
    scope: type === "calendar" || type === "meals" ? "shared" : "member",
    status: "ok",
    data: {},
  });
  const failed = (type: BlockInstance["type"]): BlockInstance => ({
    type,
    scope: type === "calendar" || type === "meals" ? "shared" : "member",
    status: "failed",
    error: "gather_failed",
  });

  it.each([
    { case: "an empty included set", blocks: [], expected: "ready" },
    {
      case: "all included gathers succeed",
      blocks: [ok("calendar"), ok("reminders")],
      expected: "ready",
    },
    {
      case: "successful and failed gathers are mixed",
      blocks: [ok("calendar"), failed("reminders")],
      expected: "partial",
    },
    {
      case: "every included gather fails",
      blocks: [failed("calendar"), failed("reminders")],
      expected: "failed",
    },
  ] satisfies Array<{ case: string; blocks: BlockInstance[]; expected: Briefing["status"] }>)(
    "returns $expected for $case",
    ({ blocks, expected }) => {
      expect(deriveStatus(blocks)).toBe(expected);
    }
  );
});
