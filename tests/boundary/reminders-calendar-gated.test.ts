import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — reminders calendar_gated emission boundary test (RED first, turns green).
 * BLACK-BOX: buildApp + Fastify.inject only — POST /api/reminders +
 * GET /api/reminders/emissions, with calendar events/assignments seeded
 * directly via DB rows (mirrors calendar-assign.test.ts's convention).
 * A calendar_gated rule emits for a member on `date` IFF an event ASSIGNED
 * to that member on `date` matches the rule's query (case+diacritic-
 * insensitive substring). The gate is a SINGLE-DAY
 * window (`range:{from:date,to:date}`) —: the literal
 * `to:nextDay(date)` documented in /is a 2-day-
 * window bug (`getEvents`'s date-only `to` is inclusive, +1 day internally),
 * corrected here and already in the merged gate.
 */
describe("reminders-calendar-gated (T004/T005 — research.md D3, issue #496 single-day window)", () => {
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

  it("emits for a member on date when an assigned event that day matches the query (case+diacritic-insensitive)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    insertEvent("medico-evt", "Médico", "2026-08-17", "2026-08-18");
    assign("medico-evt", memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "prepara la cartilla",
          query: "medico",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([{ id: created.id, text: "prepara la cartilla" }]);
    } finally {
      await app.close();
    }
  });

  it("a matching event NOT assigned to the member -> no emission (AC-05, membership-only identification)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const memberB = insertMember("Bruno");
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    assign("dentist-evt", memberB); // assigned to someone else, not Alice

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "cepíllate los dientes antes",
          query: "dentist",
        },
      });
      expect(createRes.statusCode).toBe(201);

      const res = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("a non-matching query -> no emission, even though an assigned event exists that day", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    assign("dentist-evt", memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "lleva la mochila",
          query: "excursion",
        },
      });
      expect(createRes.statusCode).toBe(201);

      const res = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // Pins the CURRENT title-only calendar_events schema (004): description/location aren't
  // modeled yet, so a rule scoped to queryFields:['location'] can never match, even against an
  // assigned event whose TITLE contains the query — because location resolves to "" (unmodeled
  // field), not because of a member/date mismatch. Will need updating once a future slice adds
  // real description/location columns.
  it("a rule scoped to queryFields:['location'] does NOT emit even though the assigned event's TITLE matches the query (unmodeled field)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    assign("dentist-evt", memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "lleva la ficha del dentista",
          query: "dentist",
          queryFields: ["location"],
        },
      });
      expect(createRes.statusCode).toBe(201);

      const res = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("single-day window (#496): a matching event that only occurs the NEXT day does not emit for today, but does emit on its own day (AC-02, evaluated every day)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    // Occurs ONLY on 2026-08-18 (all-day start=end+1day exclusive).
    insertEvent("excursion-evt", "Excursión al museo", "2026-08-18", "2026-08-19");
    assign("excursion-evt", memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "lleva la mochila",
          query: "excursión",
        },
      });
      expect(createRes.statusCode).toBe(201);

      // Today (2026-08-17): the event does NOT occur today — a `to:nextDay(date)` (2-day
      // window) bug would wrongly emit here since 2026-08-18 falls inside that window.
      const todayRes = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(todayRes.statusCode).toBe(200);
      expect(JSON.parse(todayRes.body)).toEqual([]);

      // Its own day (2026-08-18): matches.
      const created = JSON.parse(createRes.body);
      const ownDayRes = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-18`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(ownDayRes.statusCode).toBe(200);
      expect(JSON.parse(ownDayRes.body)).toEqual([{ id: created.id, text: "lleva la mochila" }]);
    } finally {
      await app.close();
    }
  });
});
