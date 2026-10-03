import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — getEvents query/queryFields matching boundary test (RED first, turns green).
 * BLACK-BOX: buildApp + Fastify.inject only, GET /api/calendar/events.
 * Case- and diacritic-insensitive substring match over `queryFields` (default
 * [title, description]) —. Composes AFTER the assignedTo
 * exclusion built in 004 (CALENDAR-AC-06): a query-matching event still
 * drops out of an `assignedTo` read when it carries no assignment for that
 * member.
 */
describe("calendar-query-matching (research.md D2)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
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

  it("query matching is case-insensitive over the title", async () => {
    const deviceKey = insertDevice();
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=DENTIST",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).map((i: { id: string }) => i.id);
      expect(ids).toContain("dentist-evt");
    } finally {
      await app.close();
    }
  });

  it("query matching is diacritic-insensitive over the title (default queryFields)", async () => {
    const deviceKey = insertDevice();
    insertEvent("medico-evt", "Médico", "2026-08-17", "2026-08-18");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=medico",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).map((i: { id: string }) => i.id);
      expect(ids).toContain("medico-evt");
    } finally {
      await app.close();
    }
  });

  it("a non-matching query excludes the event, no error", async () => {
    const deviceKey = insertDevice();
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=excursion",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("queryFields outside {title, description, location} -> 400 ValidationError", async () => {
    const deviceKey = insertDevice();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=x&queryFields=notes",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("queryFields:['title'] matches a title substring (explicit field selection)", async () => {
    const deviceKey = insertDevice();
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=dentist&queryFields=title",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).map((i: { id: string }) => i.id);
      expect(ids).toContain("dentist-evt");
    } finally {
      await app.close();
    }
  });

  // Pins the CURRENT title-only calendar_events schema (004): description/location aren't
  // modeled yet, so eventFieldValue resolves them to "" — queryFields:['location'] can never
  // match, even against a title substring, because location isn't what gets searched. This
  // will need updating once a future slice adds real description/location columns.
  it("queryFields:['location'] does NOT match a query that only appears in the title (location resolves to \"\" — unmodeled field)", async () => {
    const deviceKey = insertDevice();
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=dentist&queryFields=location",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("assignedTo excludes a query-matching event with no assignment for that member (CALENDAR-AC-06 composes after matching)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    // no assignment row for dentist-evt

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=dentist&assignedTo=${memberA}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("assignedTo returns a query-matching event assigned to that member", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    insertEvent("dentist-evt", "dentist appointment", "2026-08-17", "2026-08-18");
    assign("dentist-evt", memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-08-17&to=2026-08-17&query=DENTIST&assignedTo=${memberA}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).map((i: { id: string }) => i.id);
      expect(ids).toContain("dentist-evt");
    } finally {
      await app.close();
    }
  });
});
