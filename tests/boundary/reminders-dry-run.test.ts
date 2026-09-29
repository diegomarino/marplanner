import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — reminders dry-run/explain boundary test (RED first, turns green).
 * BLACK-BOX: buildApp + Fastify.inject only — POST /api/reminders (seed the rule) +
 * POST /api/reminders/:id/dry-run, with calendar events/assignments seeded directly via DB rows
 * (mirrors reminders-calendar-gated.test.ts's convention).
 * FR-008: `POST /api/reminders/:id/dry-run {memberId,date}` returns `{wouldEmit,reason?}`,
 * computed via up to 3 `getEvents` probes — A = the member's assigned events (no query), B = the
 * gate (member's assigned events matching query), C = any query-matching event that day
 * (regardless of assignee). B non-empty -> wouldEmit:true. Else the reason, in this CORRECTED,
 * mutually-exclusive precedence (finding — matched_but_unassigned MUST be checked before
 * query_miss, else it is unreachable):
 * 1. no_assigned_events — A empty (member has no assigned events that day at all).
 * 2. matched_but_unassigned — A non-empty, C non-empty (a query-matching event exists that day,
 * assigned to someone else, while the member holds a non-matching assigned event).
 * 3. query_miss — A non-empty, C empty (member has assigned events, none match anywhere).
 * All probes use range:{from:date,to:date} — a single-day window (the docs'
 * `to:nextDay` is a 2-day-window bug; corrected here per, already fixed in the live gate).
 */
describe("reminders-dry-run (T008/T009 — spec FR-008, research.md D4, issue #496 single-day window)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z")); // Monday
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function insertDevice() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`${Date.now()}-device`, hashKey(deviceKey), Date.now());
    return deviceKey;
  }

  function insertMember(name: string) {
    const now = Date.now();
    const id = `${now}-${name}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
      )
      .run(id, name, now, now);
    return id;
  }

  function insertEvent(id: string, title: string, startDate: string, endDate: string) {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES (?, 'local', ?, 1, ?, ?, ?, ?)"
      )
      .run(id, title, startDate, endDate, now, now);
  }

  function assign(eventId: string, memberId: string) {
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${eventId}-${memberId}`, eventId, memberId, Date.now());
  }

  async function createCalendarGatedRule(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    deviceKey: string,
    query: string
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "lleva la mochila de la excursión",
        query,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { id: string };
  }

  async function buildTestApp() {
    const { buildApp } = await import("../../src/server/app.ts");
    return buildApp();
  }

  it("would emit: a query-matching event assigned to the member that day -> {wouldEmit:true}", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    insertEvent("excursion-evt", "Excursión al museo", "2026-08-17", "2026-08-18");
    assign("excursion-evt", memberA);

    const app = await buildTestApp();
    try {
      const rule = await createCalendarGatedRule(app, deviceKey, "excursión");

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${rule.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ wouldEmit: true });
    } finally {
      await app.close();
    }
  });

  it('no_assigned_events: the member has NO assigned events that day -> reason "no_assigned_events" (probe A empty)', async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    // No events at all for Alice on 2026-08-17.

    const app = await buildTestApp();
    try {
      const rule = await createCalendarGatedRule(app, deviceKey, "excursión");

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${rule.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ wouldEmit: false, reason: "no_assigned_events" });
    } finally {
      await app.close();
    }
  });

  it('matched_but_unassigned: a matching event exists that day but is assigned to someone else, while the member holds a non-matching assigned event -> reason "matched_but_unassigned" (checked BEFORE query_miss, finding #2)', async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const memberB = insertMember("Bruno");
    // Matches the query, assigned to Bruno (not Alice).
    insertEvent("excursion-evt", "Excursión al museo", "2026-08-17", "2026-08-18");
    assign("excursion-evt", memberB);
    // Does NOT match the query, assigned to Alice (so probe A is non-empty for Alice).
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    assign("dentist-evt", memberA);

    const app = await buildTestApp();
    try {
      const rule = await createCalendarGatedRule(app, deviceKey, "excursión");

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${rule.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        wouldEmit: false,
        reason: "matched_but_unassigned",
      });
    } finally {
      await app.close();
    }
  });

  it('query_miss: the member has assigned events that day but none match the query anywhere -> reason "query_miss"', async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    // Assigned to Alice, does NOT match the query. No other event exists anywhere that matches.
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    assign("dentist-evt", memberA);

    const app = await buildTestApp();
    try {
      const rule = await createCalendarGatedRule(app, deviceKey, "excursión");

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${rule.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ wouldEmit: false, reason: "query_miss" });
    } finally {
      await app.close();
    }
  });

  it("single-day window (#496): probes use range:{from:date,to:date} — a query-matching event the NEXT day does not count as 'that day' (no_assigned_events, not matched_but_unassigned/wouldEmit)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    // Occurs ONLY on 2026-08-18 (all-day start=end+1day exclusive) — not "today" (2026-08-17).
    insertEvent("excursion-evt", "Excursión al museo", "2026-08-18", "2026-08-19");
    assign("excursion-evt", memberA);

    const app = await buildTestApp();
    try {
      const rule = await createCalendarGatedRule(app, deviceKey, "excursión");

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${rule.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(200);
      // A `to:nextDay(date)` (2-day window) bug would wrongly probe-A-match here.
      expect(JSON.parse(res.body)).toEqual({ wouldEmit: false, reason: "no_assigned_events" });
    } finally {
      await app.close();
    }
  });

  it("a scheduled (non-calendar_gated) rule -> 400 (dry-run is calendar_gated-only)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");

    const app = await buildTestApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "scheduled",
          targetingMode: "apply_to_all",
          text: "cepíllate los dientes",
          weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const scheduled = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${scheduled.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("an unknown ruleId -> 404", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");

    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders/does-not-exist/dry-run",
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("an unknown key in the dry-run body -> 400 (handler allow-list)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");

    const app = await buildTestApp();
    try {
      const rule = await createCalendarGatedRule(app, deviceKey, "excursión");

      const res = await app.inject({
        method: "POST",
        url: `/api/reminders/${rule.id}/dry-run`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: memberA, date: "2026-08-17", extra: "nope" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
