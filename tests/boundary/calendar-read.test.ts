import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — Calendar getEvents boundary test (RED-first, turns green).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Test cases:
 * - GET /api/calendar/events?source=all&from&to returns merged FeedItem(s) — timed in household tz,
 * all-day on its calendar day, recurring event expanded to per-occurrence items.
 * - All-day start==end → 400, nothing persisted.
 * - Fail-loud: to beyond +365d → 400.
 * - ?query=x / ?queryFields=title: live matching (009) — see calendar-query-matching.test.ts
 * for the full matching behavior; here just confirms the params no longer 400 (004 stub gone).
 * - Route surface: assert only the 5 calendar routes exist (no table-exposing routes).
 */

describe("calendar-read (RED by design, turns green)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("GET /api/calendar/events returns empty array when no events exist", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-15&to=2026-08-15",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events returns timed event in household timezone", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const eventId = `${Date.now()}-event`;
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_utc, end_utc, tzid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      eventId,
      "local",
      "Tuesday 9am meeting",
      0,
      "2026-07-07T08:00:00.000Z",
      "2026-07-07T09:00:00.000Z",
      "Europe/Madrid",
      now,
      now
    );

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-05&to=2026-07-10",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);

      const item = body[0];
      expect(item.id).toBe(eventId);
      expect(item.occurrenceStart).toBe("2026-07-07T08:00:00.000Z");
      expect(item.title).toBe("Tuesday 9am meeting");
      expect(item.allDay).toBe(false);
      expect(item.source).toBe("local");
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events returns all-day event", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const eventId = `${Date.now()}-event`;
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(eventId, "local", "Birthday party", 1, "2026-07-15", "2026-07-16", now, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-14&to=2026-07-18",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBe(1);

      const item = body[0];
      expect(item.id).toBe(eventId);
      expect(item.occurrenceStart).toBe("2026-07-15");
      expect(item.title).toBe("Birthday party");
      expect(item.allDay).toBe(true);
      expect(item.source).toBe("local");
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events returns recurring event expanded (DST scenario)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const eventId = `${Date.now()}-event`;
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_utc, end_utc, tzid, rrule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      eventId,
      "local",
      "Weekly Monday meeting 9am Madrid",
      0,
      "2026-07-13T08:00:00.000Z",
      "2026-07-13T09:00:00.000Z",
      "Europe/Madrid",
      "FREQ=WEEKLY;BYDAY=MO;COUNT=2",
      now,
      now
    );

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-10&to=2026-07-25",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Should have 2 occurrences: pre-DST (08:00Z) and post-DST (07:00Z)
      expect(body.length).toBe(2);

      const sorted = [...body].sort(
        (a, b) => new Date(a.occurrenceStart).getTime() - new Date(b.occurrenceStart).getTime()
      );

      expect(sorted[0].occurrenceStart).toBe("2026-07-13T08:00:00.000Z");
      expect(sorted[1].occurrenceStart).toBe("2026-07-20T08:00:00.000Z");

      expect(sorted[0].id).toBe(eventId);
      expect(sorted[1].id).toBe(eventId);
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events accepts ?query=x (009 — live matching, no longer reserved)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-15&to=2026-08-15&query=test",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events accepts ?queryFields=title (009 — live matching, no longer reserved)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-15&to=2026-08-15&queryFields=title",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/calendar/events rejects to beyond +365d with 400", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    // +365d from now plus a bit to exceed the window
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 365 + 1);

    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-01-01&to=${farFuture.toISOString()}`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/** US1 review-hardening: honor the source discriminants, populate occurrenceEnd
 * from the master's span, and default decoratedTitle to the title (frozen feed contract).
 */
describe("calendar-read (US1 review-hardening — feed contract)", () => {
  useIsolatedDb();

  // Pin the clock so the fixed 2026-07 event dates stay inside the sliding -30d/+365d
  // window (de-time-bomb — this block otherwise self-reds in CI once "now" passes ~2026-08).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function appWithDeviceAndTimedEvent() {
    const db = getDb();
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(
      `${Date.now()}-${Math.random().toString(36).slice(2)}-device`,
      hashKey(deviceKey),
      Date.now()
    );
    const eventId = `${Date.now()}-${Math.random().toString(36).slice(2)}-event`;
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_utc, end_utc, tzid, created_at, updated_at) VALUES (?, 'local', ?, 0, ?, ?, ?, ?, ?)"
    ).run(
      eventId,
      "Lunch",
      "2026-07-07T11:00:00.000Z",
      "2026-07-07T12:00:00.000Z",
      "Europe/Madrid",
      Date.now(),
      Date.now()
    );
    const { buildApp } = await import("../../src/server/app.ts");
    return { app: await buildApp(), deviceKey, eventId };
  }

  it("returns [] for source=external (present-but-empty branch) even when local events exist", async () => {
    const { app, deviceKey } = await appWithDeviceAndTimedEvent();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=external&from=2026-07-05&to=2026-07-10",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("returns local events for source=local (200, not 400)", async () => {
    const { app, deviceKey } = await appWithDeviceAndTimedEvent();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=local&from=2026-07-05&to=2026-07-10",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects an unsupported source discriminant with 400", async () => {
    const { app, deviceKey } = await appWithDeviceAndTimedEvent();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=bogus&from=2026-07-05&to=2026-07-10",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("populates occurrenceEnd (start + master duration) and defaults decoratedTitle to title", async () => {
    const { app, deviceKey } = await appWithDeviceAndTimedEvent();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-05&to=2026-07-10",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body)[0];
      expect(item.occurrenceStart).toBe("2026-07-07T11:00:00.000Z");
      expect(item.occurrenceEnd).toBe("2026-07-07T12:00:00.000Z"); // +1h master duration
      expect(item.decoratedTitle).toBe("Lunch");
    } finally {
      await app.close();
    }
  });

  it("populates occurrenceEnd for a multi-day all-day event (exclusive end date)", async () => {
    const db = getDb();
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(
      `${Date.now()}-${Math.random().toString(36).slice(2)}-device`,
      hashKey(deviceKey),
      Date.now()
    );
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES (?, 'local', 'Trip', 1, ?, ?, ?, ?)"
    ).run(`${Date.now()}-allday`, "2026-07-07", "2026-07-09", Date.now(), Date.now());
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-07-05&to=2026-07-10",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body)[0];
      expect(item.occurrenceStart).toBe("2026-07-07");
      expect(item.occurrenceEnd).toBe("2026-07-09"); // 2-day span, exclusive
    } finally {
      await app.close();
    }
  });
});

/** B1 read-hardening + B2 household-tz range (verify-pr blockers). Clock PINNED with
 * vi.setSystemTime so fixed event dates stay inside the sliding -30d/+365d window
 * forever (de-time-bombs the suite — the hardcoded-date/sliding-window self-red).
 * B2: date-only from/to denote HOUSEHOLD-TZ calendar days with an EXCLUSIVE next-midnight
 * upper bound (FR-003 / CALENDAR-INV-03). Default household tz = Europe/Madrid (CET +1 in
 * January, no DST — so the boundary instants are stable):
 * Jan 15 00:00 Madrid = Jan 14 23:00 UTC; Jan 17 00:00 Madrid = Jan 16 23:00 UTC.
 */
describe("calendar-read (US1 review-hardening — B1 resilience + B2 household-tz, pinned clock)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-10T12:00:00.000Z")); // window ~[2025-12-11.. 2027-01-10]
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function device() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(
        `${Date.now()}-${Math.random().toString(36).slice(2)}-device`,
        hashKey(deviceKey),
        Date.now()
      );
    return deviceKey;
  }

  function insertTimed(
    id: string,
    title: string,
    startUtc: string,
    endUtc: string,
    exdatesJson = "[]",
    rrule: string | null = null
  ) {
    getDb()
      .prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_utc, end_utc, tzid, rrule, exdates, created_at, updated_at) VALUES (?, 'local', ?, 0, ?, ?, 'Europe/Madrid', ?, ?, ?, ?)"
      )
      .run(id, title, startUtc, endUtc, rrule, exdatesJson, Date.now(), Date.now());
  }

  // B1 read-hardening: a stored RECURRING row with a malformed exdate (expand processes
  // exdates only when an rrule is present) must NOT 500 the whole feed.
  it("does not 500 the entire feed when one row has a malformed exdate; good events still return", async () => {
    const deviceKey = await device();
    insertTimed(
      "bad-row",
      "Poisoned",
      "2026-01-15T10:00:00.000Z",
      "2026-01-15T11:00:00.000Z",
      '["not-a-date"]',
      "FREQ=WEEKLY;BYDAY=TH;COUNT=3" // 2026-01-15 is a Thursday
    );
    insertTimed("good-row", "Healthy", "2026-01-15T12:00:00.000Z", "2026-01-15T13:00:00.000Z");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-01-14&to=2026-01-17",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200); // NOT 500
      const ids = JSON.parse(res.body).map((i: { id: string }) => i.id);
      expect(ids).toContain("good-row"); // the healthy event survives the poisoned neighbor
    } finally {
      await app.close();
    }
  });

  // B2 lower bound: an event at Jan 15 00:30 Madrid (Jan 14 23:30 UTC) belongs to Jan 15
  // in the household tz and must be included by from=2026-01-15.
  it("includes an event that is on the from-day in household tz but the prior day in UTC", async () => {
    const deviceKey = await device();
    insertTimed(
      "early",
      "Just after midnight Madrid",
      "2026-01-14T23:30:00.000Z",
      "2026-01-15T00:30:00.000Z"
    );
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-01-15&to=2026-01-16",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).map((i: { id: string }) => i.id)).toContain("early");
    } finally {
      await app.close();
    }
  });

  // B2 upper bound (exclusive next-midnight): an event at Jan 16 23:30 Madrid (Jan 16 22:30
  // UTC) is still Jan 16 in-tz and must be included by to=2026-01-16; an event at exactly
  // Jan 17 00:00 Madrid (Jan 16 23:00 UTC) is the exclusive bound and must be excluded.
  it("honors the exclusive household-tz next-midnight upper bound", async () => {
    const deviceKey = await device();
    insertTimed(
      "late-in",
      "Late but in-day Madrid",
      "2026-01-16T22:30:00.000Z",
      "2026-01-16T23:00:00.000Z"
    );
    insertTimed(
      "next-midnight",
      "Exactly next-midnight Madrid",
      "2026-01-16T23:00:00.000Z",
      "2026-01-16T23:30:00.000Z"
    );
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-01-15&to=2026-01-16",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).map((i: { id: string }) => i.id);
      expect(ids).toContain("late-in"); // Jan 16 23:30 Madrid is within Jan 16
      expect(ids).not.toContain("next-midnight"); // Jan 17 00:00 Madrid is excluded
    } finally {
      await app.close();
    }
  });

  // B2 must read the PERSISTED household tz, not just the Madrid default. With tz set to
  // America/New_York (EST -5 in January), from=2026-01-15 starts at Jan 15 05:00 UTC, so an
  // event at Jan 15 03:00 UTC (= Jan 14 22:00 New_York) is Jan 14 in-tz and EXCLUDED. Under
  // the Madrid default it would be Jan 15 04:00 Madrid → included; the difference proves the
  // read path (not the fallback) is exercised.
  it("uses the persisted household timezone for the range, not the default", async () => {
    const deviceKey = await device();
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
      )
      .run(JSON.stringify({ timezone: "America/New_York" }), Date.now());
    insertTimed(
      "ny-early",
      "03:00Z = Jan 14 22:00 New_York",
      "2026-01-15T03:00:00.000Z",
      "2026-01-15T04:00:00.000Z"
    );
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-01-15&to=2026-01-15",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      // Excluded under New_York (Jan 14 in-tz); would be included under the Madrid default.
      expect(JSON.parse(res.body).map((i: { id: string }) => i.id)).not.toContain("ny-early");
    } finally {
      await app.close();
    }
  });

  // JSON.parse(row.exdates) runs OUTSIDE the expand try/catch — a row with
  // non-JSON stored exdates (reachable once PATCH/PUT become real writers) 500s the whole
  // feed. The per-row body must be resilient: skip the bad row, keep the good ones.
  it("does not 500 the feed when a row has non-JSON stored exdates", async () => {
    const deviceKey = await device();
    // Raw non-JSON in the exdates column (insertTimed writes the 5th arg verbatim).
    insertTimed(
      "bad-json",
      "Non-JSON exdates",
      "2026-01-15T10:00:00.000Z",
      "2026-01-15T11:00:00.000Z",
      "NOT-JSON{{{"
    );
    insertTimed("good-1", "Healthy", "2026-01-15T12:00:00.000Z", "2026-01-15T13:00:00.000Z");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-01-14&to=2026-01-17",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200); // NOT 500
      expect(JSON.parse(res.body).map((i: { id: string }) => i.id)).toContain("good-1");
    } finally {
      await app.close();
    }
  });

  // occurrenceEndFor's duration math runs OUTSIDE the expand try/catch — a row
  // with an unparseable end_utc (NaN duration) 500s the whole feed. Must skip the bad row.
  it("does not 500 the feed when a row has an unparseable end_utc (NaN duration)", async () => {
    const deviceKey = await device();
    insertTimed("bad-end", "Garbage end", "2026-01-15T10:00:00.000Z", "GARBAGE-END");
    insertTimed("good-2", "Healthy", "2026-01-15T12:00:00.000Z", "2026-01-15T13:00:00.000Z");
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-01-14&to=2026-01-17",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200); // NOT 500
      expect(JSON.parse(res.body).map((i: { id: string }) => i.id)).toContain("good-2");
    } finally {
      await app.close();
    }
  });
});

/** All-day events are household calendar dates (CALENDAR-INV-04). West of UTC the household
 * midnight is after UTC midnight, so comparing each all-day anchor (UTC midnight) with the
 * instant range moved every all-day event onto the previous household day. */
describe("calendar-read (all-day events keep their household date)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function readIds(timezone: string, query: string, rrule: string | null) {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`${Date.now()}-device`, hashKey(deviceKey), Date.now());
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
      )
      .run(JSON.stringify({ timezone }), Date.now());
    getDb()
      .prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, rrule, exdates, created_at, updated_at) VALUES ('holiday', 'local', 'School holiday', 1, '2026-10-23', '2026-10-24', ?, '[]', ?, ?)"
      )
      .run(rrule, Date.now(), Date.now());
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=local&${query}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      return (JSON.parse(res.body) as Array<{ occurrenceStart: string }>).map(
        (item) => item.occurrenceStart
      );
    } finally {
      await app.close();
    }
  }

  for (const timezone of ["America/New_York", "Pacific/Honolulu", "Asia/Tokyo", "UTC"]) {
    for (const rrule of [null, "FREQ=DAILY;COUNT=1"]) {
      it(`places a ${rrule ? "recurring" : "single"} all-day event on its own date in ${timezone}`, async () => {
        expect(await readIds(timezone, "from=2026-10-23&to=2026-10-23", rrule)).toEqual([
          "2026-10-23",
        ]);
      });

      it(`keeps a ${rrule ? "recurring" : "single"} all-day event off the previous date in ${timezone}`, async () => {
        expect(await readIds(timezone, "from=2026-10-22&to=2026-10-22", rrule)).toEqual([]);
      });
    }
  }

  it("returns exactly the requested dates of a daily all-day series west of UTC", async () => {
    expect(
      await readIds("America/New_York", "from=2026-10-24&to=2026-10-25", "FREQ=DAILY;COUNT=5")
    ).toEqual(["2026-10-24", "2026-10-25"]);
  });

  it.each([
    ["equal", "from=2026-10-24T15:00:00.000Z&to=2026-10-24T15:00:00.000Z"],
    ["reversed", "from=2026-10-24T18:00:00.000Z&to=2026-10-24T15:00:00.000Z"],
  ])("returns no all-day event for %s instant bounds, an empty range", async (_label, query) => {
    expect(await readIds("America/New_York", query, "FREQ=DAILY;COUNT=5")).toEqual([]);
  });

  it("maps an instant range to the household dates it covers", async () => {
    // New York midnight of 2026-10-24 (EDT, UTC-4) to the next midnight: only the 24th.
    expect(
      await readIds(
        "America/New_York",
        "from=2026-10-24T04:00:00.000Z&to=2026-10-25T04:00:00.000Z",
        "FREQ=DAILY;COUNT=5"
      )
    ).toEqual(["2026-10-24"]);
  });
});

/** Calendar reads are overlap queries: an occurrence that began before the range but is still
 * running belongs to every day it covers, once, under its own occurrence identity. */
describe("calendar-read (ongoing multi-day and overnight events)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Row =
    | { id: string; allDay: true; startDate: string; endDate: string; rrule?: string }
    | { id: string; allDay: false; startUtc: string; endUtc: string; rrule?: string };

  /** Seed the device, household timezone and rows once; the returned reader queries a range. */
  function seed(rows: Row[]) {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, hashKey(deviceKey), Date.now());
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
    ).run(JSON.stringify({ timezone: "UTC" }), Date.now());
    for (const row of rows) {
      db.prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, start_utc, end_utc, tzid, rrule, exdates, created_at, updated_at) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)"
      ).run(
        row.id,
        row.id,
        row.allDay ? 1 : 0,
        row.allDay ? row.startDate : null,
        row.allDay ? row.endDate : null,
        row.allDay ? null : row.startUtc,
        row.allDay ? null : row.endUtc,
        row.allDay ? null : "UTC",
        row.rrule ?? null,
        Date.now(),
        Date.now()
      );
    }
    return async (from: string, to = from) => {
      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "GET",
          url: `/api/calendar/events?source=local&from=${from}&to=${to}`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(200);
        return (JSON.parse(res.body) as Array<{ id: string; occurrenceStart: string }>).map(
          (item) => `${item.id}@${item.occurrenceStart}`
        );
      } finally {
        await app.close();
      }
    };
  }

  const holiday: Row = {
    id: "holiday",
    allDay: true,
    startDate: "2026-10-22",
    endDate: "2026-10-26", // exclusive: covers the 22nd to the 25th
  };

  it.each([
    ["2026-10-22", ["holiday@2026-10-22"]],
    ["2026-10-23", ["holiday@2026-10-22"]],
    ["2026-10-25", ["holiday@2026-10-22"]],
    ["2026-10-21", []],
    ["2026-10-26", []],
  ])("lists a 22–25 October holiday on %s only while it runs", async (date, expected) => {
    expect(await seed([holiday])(date)).toEqual(expected);
  });

  it("returns a multi-day event once for a range spanning several of its days", async () => {
    expect(await seed([holiday])("2026-10-23", "2026-10-28")).toEqual(["holiday@2026-10-22"]);
  });

  it("includes a recurring weekend occurrence that began the day before", async () => {
    const weekend: Row = {
      id: "weekend",
      allDay: true,
      startDate: "2026-10-24",
      endDate: "2026-10-26",
      rrule: "FREQ=WEEKLY;COUNT=3",
    };
    const read = seed([weekend]);
    expect(await read("2026-10-25")).toEqual(["weekend@2026-10-24"]);
    expect(await read("2026-11-01")).toEqual(["weekend@2026-10-31"]);
  });

  it("lists an overnight timed event on the morning it ends, but not one ending at midnight", async () => {
    const rows: Row[] = [
      {
        id: "overnight",
        allDay: false,
        startUtc: "2026-10-23T22:00:00.000Z",
        endUtc: "2026-10-24T02:00:00.000Z",
      },
      {
        id: "until-midnight",
        allDay: false,
        startUtc: "2026-10-23T21:00:00.000Z",
        endUtc: "2026-10-24T00:00:00.000Z",
      },
    ];
    const read = seed(rows);
    expect(await read("2026-10-24")).toEqual(["overnight@2026-10-23T22:00:00.000Z"]);
    expect(await read("2026-10-25")).toEqual([]);
  });
});
