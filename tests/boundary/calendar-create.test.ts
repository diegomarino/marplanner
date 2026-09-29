import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — Calendar createEvent boundary test (RED-first, turns green).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Test cases:
 * - POST /api/calendar/events: timed w/ tzid → 201; all-day → 201; weekly recurring → 201.
 * - All-day start==end → 400, nothing persisted.
 * - Route surface: assert only the 5 calendar routes exist (no table-exposing routes).
 */

describe("calendar-create (T006 — RED by design, T007 turns green)", () => {
  useIsolatedDb();

  it("POST /api/calendar/events creates timed event with tzid (201)", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Morning standup",
          allDay: false,
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
          tzid: "Europe/Madrid",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events creates all-day event (201)", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Company holiday",
          allDay: true,
          startDate: "2026-01-15",
          endDate: "2026-01-16",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events creates weekly recurring event (201)", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Weekly team sync",
          allDay: false,
          startUtc: "2026-01-05T08:00:00.000Z",
          endUtc: "2026-01-05T09:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=MO",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events rejects all-day start==end with 400 and persists nothing", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Invalid all-day",
          allDay: true,
          startDate: "2026-01-15",
          endDate: "2026-01-15",
        },
      });

      expect(res.statusCode).toBe(400);

      const eventCount = db.prepare("SELECT COUNT(*) AS cnt FROM calendar_events").get() as {
        cnt: number;
      };
      expect(eventCount.cnt).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events rejects missing required fields with 400", async () => {
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
      // Missing all required fields
      let res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {},
      });
      expect(res.statusCode).toBe(400);

      // Missing title
      res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          allDay: false,
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
          tzid: "Europe/Madrid",
        },
      });
      expect(res.statusCode).toBe(400);

      // Missing allDay
      res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Test event",
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
          tzid: "Europe/Madrid",
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events rejects timed event missing tzid with 400", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Missing tzid",
          allDay: false,
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
        },
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events rejects all-day event with start_utc fields with 400", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Mixed fields",
          allDay: true,
          startDate: "2026-01-15",
          endDate: "2026-01-16",
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
          tzid: "Europe/Madrid",
        },
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /api/calendar/events rejects invalid rrule with 400", async () => {
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
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Bad rrule",
          allDay: false,
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "INVALID_RRULE_SYNTAX",
        },
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/** US1 review-hardening: createEvent must reject reversed all-day intervals and
 * validate timed instants + the IANA timezone — not merely check non-emptiness / equality.
 */
describe("calendar-create (US1 review-hardening — P1 validation)", () => {
  useIsolatedDb();

  async function appWithDevice() {
    const { buildApp } = await import("../../src/server/app.ts");
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
    return { app: await buildApp(), deviceKey };
  }

  it("rejects a reversed all-day interval (end before start) with 400 and persists nothing", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Reversed",
          allDay: true,
          startDate: "2026-02-10",
          endDate: "2026-02-08",
        },
      });
      expect(res.statusCode).toBe(400);
      const cnt = getDb().prepare("SELECT COUNT(*) AS c FROM calendar_events").get() as {
        c: number;
      };
      expect(cnt.c).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid IANA tzid with 400", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Bad tz",
          allDay: false,
          startUtc: "2026-02-10T09:00:00.000Z",
          endUtc: "2026-02-10T10:00:00.000Z",
          tzid: "Mars/Olympus_Mons",
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an unparseable timed instant with 400", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Bad instant",
          allDay: false,
          startUtc: "not-a-real-instant",
          endUtc: "2026-02-10T10:00:00.000Z",
          tzid: "Europe/Madrid",
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects a timed event whose end_utc precedes start_utc with 400", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Backwards",
          allDay: false,
          startUtc: "2026-02-10T10:00:00.000Z",
          endUtc: "2026-02-10T09:00:00.000Z",
          tzid: "Europe/Madrid",
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/** B1 (critical, security) — createEvent MUST validate exdates. An unvalidated malformed
 * exdate is stored, then throws inside expand on EVERY subsequent getEvents call — a
 * feed-wide 500 reachable via the write path (stored DoS). data-model: "exdates entries
 * are valid date/instant strings consistent with all_day".
 */
describe("calendar-create (US1 review-hardening — B1 exdate validation)", () => {
  useIsolatedDb();

  async function appWithDevice() {
    const { buildApp } = await import("../../src/server/app.ts");
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
    return { app: await buildApp(), deviceKey };
  }

  it("rejects a timed event with a malformed exdate (400, nothing persisted)", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Poison",
          allDay: false,
          startUtc: "2026-02-10T09:00:00.000Z",
          endUtc: "2026-02-10T10:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3",
          exdates: ["not-a-date"],
        },
      });
      expect(res.statusCode).toBe(400);
      const cnt = getDb().prepare("SELECT COUNT(*) AS c FROM calendar_events").get() as {
        c: number;
      };
      expect(cnt.c).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an all-day event whose exdate is not a valid YYYY-MM-DD (400)", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Poison all-day",
          allDay: true,
          startDate: "2026-02-10",
          endDate: "2026-02-12",
          rrule: "FREQ=DAILY;COUNT=3",
          exdates: ["garbage"],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an exdate whose shape is inconsistent with all_day (timed event, date-only exdate) (400)", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Inconsistent",
          allDay: false,
          startUtc: "2026-02-10T09:00:00.000Z",
          endUtc: "2026-02-10T10:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3",
          exdates: ["2026-02-17"], // date-only on a timed event — must be an instant
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/** US1 hardening : the exdate validation must check that exdates
 * is actually an ARRAY OF STRINGS (not merely truthy-with-length), and date fields must be
 * STRICT calendar-valid (JS `Date` rolls 2026-02-30 to Mar 2 instead of rejecting it). These
 * currently persist and then silently vanish from the feed on read (validation-that-lies).
 */
describe("calendar-create (US1 hardening — Codex: exdates shape + strict dates)", () => {
  useIsolatedDb();

  async function appWithDevice() {
    const { buildApp } = await import("../../src/server/app.ts");
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
    return { app: await buildApp(), deviceKey };
  }

  it("rejects exdates that is not an array (object) with 400", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Object exdates",
          allDay: false,
          startUtc: "2026-02-10T09:00:00.000Z",
          endUtc: "2026-02-10T10:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3",
          exdates: { foo: "bar" } as unknown as string[],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects exdates that is a bare string with 400", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "String exdates",
          allDay: false,
          startUtc: "2026-02-10T09:00:00.000Z",
          endUtc: "2026-02-10T10:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3",
          exdates: "2026" as unknown as string[],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an all-day event whose startDate is not a valid date with 400", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: { title: "Bad startDate", allDay: true, startDate: "not-a-date", endDate: "zzzz" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects a non-existent calendar date (2026-02-30) rather than rolling it over", async () => {
    const { app, deviceKey } = await appWithDevice();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Feb 30",
          allDay: true,
          startDate: "2026-02-10",
          endDate: "2026-02-12",
          rrule: "FREQ=DAILY;COUNT=3",
          exdates: ["2026-02-30"], // does not exist — must be rejected, not rolled to Mar 2
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
