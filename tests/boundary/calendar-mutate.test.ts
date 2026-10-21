import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — Calendar atomic edit/delete boundary tests (RED-first, turns green).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Test cases:
 * - DELETE /api/calendar/events/:id → 204, event + assignments gone (zero orphans).
 * - PATCH /api/calendar/events/:id editing title/date → 200 single-row (untouched fields unchanged).
 * - PATCH editing the rrule PRESERVES the event's exdates.
 * - Unknown id → 404 (both DELETE and PATCH).
 */

describe("calendar-mutate (RED by design, turns green)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function insertDevice() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`${now}-device`, deviceHash, now);
    return deviceKey;
  }

  function insertMember(name: string, lifecycle: "active" | "archived" = "active") {
    const now = Date.now();
    const id = `${now}-${name}`;
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at, birth_month, birth_day, birth_year) VALUES (?, ?, 'parent', ?, ?, ?, null, null, null)"
      )
      .run(id, name, lifecycle, now, now);
    return id;
  }

  function insertEvent(
    id: string,
    title: string,
    startUtc: string,
    endUtc: string,
    rrule: string | null = null,
    exdatesJson = "[]"
  ) {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_utc, end_utc, tzid, rrule, exdates, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, "local", title, 0, startUtc, endUtc, "Europe/Madrid", rrule, exdatesJson, now, now);
  }

  function insertAssignment(eventId: string, memberId: string) {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${eventId}-${memberId}-assign`, eventId, memberId, now);
  }

  it("rejects malformed create and partial-edit fields without changing stored state", async () => {
    const deviceKey = insertDevice();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const cookies = { mp_device_key: deviceKey };
    const valid = {
      title: "Original",
      allDay: true,
      startDate: "2026-07-15",
      endDate: "2026-07-16",
    };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies,
        payload: valid,
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      const before = getDb().prepare("SELECT * FROM calendar_events WHERE id = ?").get(id);
      for (const fields of [
        { title: 42 },
        { allDay: "true" },
        { unexpected: true },
        { exdates: null },
        { startDate: "2026-02-31" },
      ]) {
        const create = await app.inject({
          method: "POST",
          url: "/api/calendar/events",
          cookies,
          payload: { ...valid, ...fields },
        });
        expect(create.statusCode).toBe(400);
        const edit = await app.inject({
          method: "PATCH",
          url: `/api/calendar/events/${id}`,
          cookies,
          payload: fields,
        });
        expect(edit.statusCode).toBe(400);
        expect(getDb().prepare("SELECT * FROM calendar_events WHERE id = ?").get(id)).toEqual(
          before
        );
        expect(getDb().prepare("SELECT COUNT(*) AS count FROM calendar_events").get()).toEqual({
          count: 1,
        });
      }
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${id}`,
        cookies,
        payload: { title: "Changed" },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().title).toBe("Changed");
    } finally {
      await app.close();
    }
  });

  it("PATCH updates timed instants and timezone while preserving recurrence and assignments", async () => {
    const cookies = { mp_device_key: insertDevice() };
    const member = insertMember("Alice");
    const id = "rescheduled-event";
    const exdates = '["2026-07-22T09:00:00.000Z"]';
    insertEvent(
      id,
      "Appointment",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      "FREQ=WEEKLY;BYDAY=WE",
      exdates
    );
    insertAssignment(id, member);
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${id}`,
        cookies,
        payload: {
          startUtc: "2026-07-15T11:00:00.000Z",
          endUtc: "2026-07-15T12:30:00.000Z",
          tzid: "Europe/London",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        title: "Appointment",
        allDay: false,
        occurrenceStart: "2026-07-15T11:00:00.000Z",
        occurrenceEnd: "2026-07-15T12:30:00.000Z",
        tzid: "Europe/London",
        assignedTo: [member],
      });
      expect(
        getDb()
          .prepare(
            "SELECT start_utc, end_utc, tzid, rrule, exdates FROM calendar_events WHERE id = ?"
          )
          .get(id)
      ).toEqual({
        start_utc: "2026-07-15T11:00:00.000Z",
        end_utc: "2026-07-15T12:30:00.000Z",
        tzid: "Europe/London",
        rrule: "FREQ=WEEKLY;BYDAY=WE",
        exdates,
      });
    } finally {
      await app.close();
    }
  });

  it("PATCH validates all-day dates against merged state before rescheduling", async () => {
    const cookies = { mp_device_key: insertDevice() };
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies,
        payload: { title: "Holiday", allDay: true, startDate: "2026-07-15", endDate: "2026-07-16" },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      const before = getDb().prepare("SELECT * FROM calendar_events WHERE id = ?").get(id);
      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${id}`,
        cookies,
        payload: { startDate: "2026-07-17" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(getDb().prepare("SELECT * FROM calendar_events WHERE id = ?").get(id)).toEqual(before);
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${id}`,
        cookies,
        payload: { allDay: true, startDate: "2026-07-17", endDate: "2026-07-20" },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({
        id,
        title: "Holiday",
        allDay: true,
        occurrenceStart: "2026-07-17",
        occurrenceEnd: "2026-07-20",
      });
      expect(
        getDb()
          .prepare(
            "SELECT all_day, start_date, end_date, start_utc, end_utc, tzid FROM calendar_events WHERE id = ?"
          )
          .get(id)
      ).toEqual({
        all_day: 1,
        start_date: "2026-07-17",
        end_date: "2026-07-20",
        start_utc: null,
        end_utc: null,
        tzid: null,
      });
    } finally {
      await app.close();
    }
  });

  // Test 1: DELETE /api/calendar/events/:id → 204, event and assignments gone
  it("DELETE /api/calendar/events/:id returns 204 and removes event + assignments", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const eventId = "delete-test-event";

    // Create event with assignment
    insertEvent(
      eventId,
      "Event to delete",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    insertAssignment(eventId, memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // Verify pre-delete state
      const eventBefore = getDb()
        .prepare("SELECT COUNT(*) AS cnt FROM calendar_events WHERE id = ?")
        .get(eventId) as { cnt: number };
      expect(eventBefore.cnt).toBe(1);

      const assignBefore = getDb()
        .prepare("SELECT COUNT(*) AS cnt FROM calendar_assignments WHERE event_id = ?")
        .get(eventId) as { cnt: number };
      expect(assignBefore.cnt).toBe(1);

      // DELETE the event
      const res = await app.inject({
        method: "DELETE",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(204);

      // Verify event is gone
      const eventAfter = getDb()
        .prepare("SELECT COUNT(*) AS cnt FROM calendar_events WHERE id = ?")
        .get(eventId) as { cnt: number };
      expect(eventAfter.cnt).toBe(0);

      // Verify assignments are also gone (no orphans)
      const assignAfter = getDb()
        .prepare("SELECT COUNT(*) AS cnt FROM calendar_assignments WHERE event_id = ?")
        .get(eventId) as { cnt: number };
      expect(assignAfter.cnt).toBe(0);
    } finally {
      await app.close();
    }
  });

  // Test 2: PATCH editing title → 200 single-row, untouched fields unchanged
  it("PATCH /api/calendar/events/:id editing title returns 200 with single-row update", async () => {
    const deviceKey = insertDevice();
    const eventId = "patch-test-event";

    // Create initial non-recurring event to test single-row update cleanly
    insertEvent(
      eventId,
      "Original title",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // PATCH to edit title only (simpler test for single-row update)
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Updated title",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(eventId);
      expect(body.title).toBe("Updated title");
      // occurrenceStart stays the same for non-recurring event
      expect(body.occurrenceStart).toBe("2026-07-15T09:00:00.000Z");

      // Verify rrule is preserved (single-row update)
      const row = getDb()
        .prepare("SELECT rrule FROM calendar_events WHERE id = ?")
        .get(eventId) as { rrule: string };
      expect(row.rrule).toBe(null);
    } finally {
      await app.close();
    }
  });

  // Test 3: PATCH editing rrule PRESERVES exdates
  it("PATCH /api/calendar/events/:id editing rrule preserves existing exdates", async () => {
    const deviceKey = insertDevice();
    const eventId = "exdate-preserve-test-event";

    // Create event with rrule and exdates
    const exdates = ["2026-07-19T09:00:00.000Z", "2026-07-26T09:00:00.000Z"];
    insertEvent(
      eventId,
      "Recurring with exceptions",
      "2026-07-12T09:00:00.000Z",
      "2026-07-12T10:00:00.000Z",
      "FREQ=WEEKLY;BYDAY=MO",
      JSON.stringify(exdates)
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // PATCH to edit rrule (change frequency)
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          rrule: "FREQ=WEEKLY;BYDAY=WE",
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify exdates are preserved
      const row = getDb()
        .prepare("SELECT exdates FROM calendar_events WHERE id = ?")
        .get(eventId) as { exdates: string };
      expect(row.exdates).toBe(JSON.stringify(exdates));
    } finally {
      await app.close();
    }
  });

  // Test 4: DELETE unknown id → 404
  it("DELETE /api/calendar/events/:id returns 404 for unknown id", async () => {
    const deviceKey = insertDevice();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/calendar/events/nonexistent-id",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");
    } finally {
      await app.close();
    }
  });

  // Test 5: PATCH unknown id → 404
  it("PATCH /api/calendar/events/:id returns 404 for unknown id", async () => {
    const deviceKey = insertDevice();

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/calendar/events/nonexistent-id",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Should fail",
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");
    } finally {
      await app.close();
    }
  });

  // Test 6: PATCH with invalid rrule → 400, prior state intact
  it("PATCH /api/calendar/events/:id with invalid rrule returns 400 and preserves prior state", async () => {
    const deviceKey = insertDevice();
    const eventId = "invalid-rrule-test-event";

    insertEvent(
      eventId,
      "Valid recurring event",
      "2026-07-12T09:00:00.000Z",
      "2026-07-12T10:00:00.000Z",
      "FREQ=WEEKLY;BYDAY=MO",
      "[]"
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          rrule: "FREQ=NOPE",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");

      const row = getDb()
        .prepare("SELECT rrule FROM calendar_events WHERE id = ?")
        .get(eventId) as { rrule: string };
      expect(row.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    } finally {
      await app.close();
    }
  });

  it("PATCH switches a weekly series to YEARLY (numeric zero frequency) and refuses MINUTELY", async () => {
    const deviceKey = insertDevice();
    const eventId = "yearly-switch-test-event";
    insertEvent(
      eventId,
      "Anniversary",
      "2026-07-12T09:00:00.000Z",
      "2026-07-12T10:00:00.000Z",
      "FREQ=WEEKLY;BYDAY=MO"
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const storedRrule = () =>
      (
        getDb().prepare("SELECT rrule FROM calendar_events WHERE id = ?").get(eventId) as {
          rrule: string;
        }
      ).rrule;

    try {
      const yearly = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { rrule: "FREQ=YEARLY" },
      });
      expect(yearly.statusCode).toBe(200);
      expect(storedRrule()).toBe("FREQ=YEARLY");

      const minutely = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: { rrule: "FREQ=MINUTELY" },
      });
      expect(minutely.statusCode).toBe(400);
      expect(storedRrule()).toBe("FREQ=YEARLY");
    } finally {
      await app.close();
    }
  });

  // Test 7: PATCH on event with assignment returns real assignedTo
  it("PATCH /api/calendar/events/:id on an assigned event returns real assignedTo", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const eventId = "assigned-edit-test-event";

    insertEvent(
      eventId,
      "Assigned event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    insertAssignment(eventId, memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Updated title",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assignedTo).toEqual([memberA]);
    } finally {
      await app.close();
    }
  });

  // Test 8: PATCH {startUtc: null} → 400 with prior state intact
  it("PATCH /api/calendar/events/:id with explicit-null non-nullable field returns 400 and preserves prior state", async () => {
    const deviceKey = insertDevice();
    const eventId = "null-nonnullable-test-event";

    insertEvent(
      eventId,
      "Original event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // PATCH with explicit-null for a non-nullable field
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          startUtc: null,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");

      // Verify prior state is intact
      const row = getDb()
        .prepare("SELECT start_utc FROM calendar_events WHERE id = ?")
        .get(eventId) as { start_utc: string };
      expect(row.start_utc).toBe("2026-07-15T09:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  // Test 9: PATCH {title: null} → 400
  it("PATCH /api/calendar/events/:id with title=null returns 400", async () => {
    const deviceKey = insertDevice();
    const eventId = "null-title-test-event";

    insertEvent(
      eventId,
      "Original title",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: null,
        },
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // Test 10: PATCH {exdates: null} → 400 with prior state intact
  it("PATCH /api/calendar/events/:id with exdates=null returns 400 and preserves prior state", async () => {
    const deviceKey = insertDevice();
    const eventId = "null-exdates-test-event";

    insertEvent(
      eventId,
      "Original event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          exdates: null,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");

      const row = getDb()
        .prepare("SELECT exdates FROM calendar_events WHERE id = ?")
        .get(eventId) as { exdates: string };
      expect(row.exdates).toBe("[]");
    } finally {
      await app.close();
    }
  });

  // Test 11: PATCH {rrule: null} → 200 (nullable, legit clear)
  it("PATCH /api/calendar/events/:id with rrule=null clears recurrence and returns 200", async () => {
    const deviceKey = insertDevice();
    const eventId = "null-rrule-test-event";

    // Create event with rrule
    insertEvent(
      eventId,
      "Recurring event",
      "2026-07-12T09:00:00.000Z",
      "2026-07-12T10:00:00.000Z",
      "FREQ=WEEKLY;BYDAY=MO",
      "[]"
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // PATCH rrule=null to clear recurrence (valid)
      const res = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${eventId}`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          rrule: null,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(eventId);

      // Verify rrule is cleared in DB
      const row = getDb()
        .prepare("SELECT rrule FROM calendar_events WHERE id = ?")
        .get(eventId) as { rrule: string };
      expect(row.rrule).toBe(null);
    } finally {
      await app.close();
    }
  });

  it("stores a local event's description and location, serves them, and clears them when blanked", async () => {
    const deviceKey = insertDevice();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const feed = async () =>
      (
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/calendar/events?source=local&from=2026-07-14&to=2026-07-16",
              cookies: { mp_device_key: deviceKey },
            })
          ).body
        ) as { id: string; description?: string; location?: string }[]
      ).find((item) => item.id === id);
    let id = "";

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: {
          title: "Dentist",
          allDay: true,
          startDate: "2026-07-15",
          endDate: "2026-07-16",
          description: "  Bring the insurance card  ",
          location: "Clinic, 2nd floor",
        },
      });
      expect(created.statusCode).toBe(201);
      id = (JSON.parse(created.body) as { id: string }).id;
      expect(await feed()).toMatchObject({
        description: "Bring the insurance card",
        location: "Clinic, 2nd floor",
      });

      const edited = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { description: "Fasting required", location: "   " },
      });
      expect(edited.statusCode).toBe(200);
      expect(JSON.parse(edited.body)).toMatchObject({ description: "Fasting required" });
      const after = await feed();
      expect(after).toMatchObject({ title: "Dentist", description: "Fasting required" });
      expect(after).not.toHaveProperty("location");

      const tooLong = await app.inject({
        method: "PATCH",
        url: `/api/calendar/events/${id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { location: "x".repeat(301) },
      });
      expect(tooLong.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH switches an all-day event to timed and back, dropping the other shape's dates", async () => {
    const deviceKey = insertDevice();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const stored = (id: string) =>
      getDb()
        .prepare(
          "SELECT all_day, start_date, end_date, start_utc, end_utc, tzid FROM calendar_events WHERE id = ?"
        )
        .get(id);

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/calendar/events",
        cookies: { mp_device_key: deviceKey },
        payload: { title: "Visit", allDay: true, startDate: "2026-07-15", endDate: "2026-07-18" },
      });
      const { id } = JSON.parse(created.body) as { id: string };
      const patch = (payload: Record<string, unknown>) =>
        app.inject({
          method: "PATCH",
          url: `/api/calendar/events/${id}`,
          cookies: { mp_device_key: deviceKey },
          payload,
        });

      // A bare flag flip has no dates for the new shape, so nothing is written.
      expect((await patch({ allDay: false })).statusCode).toBe(400);
      expect(stored(id)).toMatchObject({ all_day: 1, start_date: "2026-07-15" });

      const timed = await patch({
        allDay: false,
        startUtc: "2026-07-15T09:00:00.000Z",
        endUtc: "2026-07-15T10:00:00.000Z",
        tzid: "Europe/Madrid",
      });
      expect(timed.statusCode).toBe(200);
      expect(JSON.parse(timed.body)).toMatchObject({
        allDay: false,
        occurrenceStart: "2026-07-15T09:00:00.000Z",
      });
      expect(stored(id)).toEqual({
        all_day: 0,
        start_date: null,
        end_date: null,
        start_utc: "2026-07-15T09:00:00.000Z",
        end_utc: "2026-07-15T10:00:00.000Z",
        tzid: "Europe/Madrid",
      });

      const back = await patch({ allDay: true, startDate: "2026-07-20", endDate: "2026-07-21" });
      expect(back.statusCode).toBe(200);
      expect(stored(id)).toEqual({
        all_day: 1,
        start_date: "2026-07-20",
        end_date: "2026-07-21",
        start_utc: null,
        end_utc: null,
        tzid: null,
      });
    } finally {
      await app.close();
    }
  });
});
