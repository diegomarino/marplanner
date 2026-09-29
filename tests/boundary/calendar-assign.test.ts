import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — Calendar member-scope assignments boundary test (RED-first, turns green).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Original test cases (1-5):
 * - PUT /api/calendar/events/:id/assignments {memberIds:[M]} → 200.
 * - GET ?assignedTo=M returns ONLY the assigned event.
 * - GET with no assignedTo returns both (unassigned matches only when assignedTo is omitted).
 * - Target member that is archived → 400 (strict-on-write).
 * - After archiving M, the event drops from active assignedTo reads
 * while its historical assignment row is still readable.
 * Added test cases (6-11) for Steer 2:
 * 6. Multi-assignee filtered read: assignedTo M+N, GET ?assignedTo=M returns BOTH M and N.
 * 7. PUT response is a real FeedItem: real title, occurrenceStart, allDay.
 * 8. PUT {memberIds: null}/{}/null → 400 (body validation).
 * 9. PUT {memberIds: [M, M]} → 200 with exactly ONE assignment to M (dedup).
 * 10. PUT {memberIds: []} → 200 clears all assignments.
 * 11. PUT to unknown event → 404.
 */

describe("calendar-assign (T009 — RED by design, T010 turns green)", () => {
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

  // Test 1: PUT /api/calendar/events/:id/assignments → 200
  it("PUT /api/calendar/events/:id/assignments returns 200 with valid memberIds", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const eventId = "assign-test-event";
    insertEvent(
      eventId,
      "Team standup",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: [memberA] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assignedTo).toContain(memberA);
    } finally {
      await app.close();
    }
  });

  // Test 2: GET ?assignedTo=M returns ONLY the assigned event
  it("GET ?assignedTo=M returns only the assigned event", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const now = Date.now();

    // Event assigned to Alice
    const assignedId = "assigned-event";
    insertEvent(
      assignedId,
      "Assigned event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${assignedId}-assign`, assignedId, memberA, now);

    // Unassigned event
    const unassignedId = "unassigned-event";
    insertEvent(
      unassignedId,
      "Household event",
      "2026-07-16T10:00:00.000Z",
      "2026-07-16T10:30:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-07-15&to=2026-07-17&assignedTo=${memberA}`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(assignedId);
    } finally {
      await app.close();
    }
  });

  // Test 3: GET with no assignedTo returns both (assigned + unassigned)
  it("GET with no assignedTo returns both assigned and unassigned events", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const now = Date.now();

    // Assigned event
    const assignedId = "both-assigned";
    insertEvent(
      assignedId,
      "Assigned in both",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${assignedId}-assign`, assignedId, memberA, now);

    // Unassigned event
    const unassignedId = "both-unassigned";
    insertEvent(
      unassignedId,
      "Unassigned in both",
      "2026-07-16T10:00:00.000Z",
      "2026-07-16T10:30:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-07-15&to=2026-07-17`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBe(2);
      const ids = body.map((i: { id: string }) => i.id);
      expect(ids).toContain(assignedId);
      expect(ids).toContain(unassignedId);
    } finally {
      await app.close();
    }
  });

  // Test 4: Target member that is archived → 400 (strict-on-write)
  it("PUT /api/calendar/events/:id/assignments returns 400 for archived member", async () => {
    const deviceKey = insertDevice();
    const archivedMember = insertMember("Bob", "archived");
    const eventId = "archived-assign-event";
    insertEvent(
      eventId,
      "Archived assignment test",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: [archivedMember] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");
    } finally {
      await app.close();
    }
  });

  // Test 5: After archiving M, the event drops from active assignedTo reads
  // while its historical assignment row is still readable
  it("After archiving M, event drops from assignedTo reads but historical row remains", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const now = Date.now();

    // Create event and assign to Alice
    const eventId = "archive-test-event";
    insertEvent(
      eventId,
      "Archive test",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${eventId}-assign`, eventId, memberA, now);

    // Archive Alice
    getDb()
      .prepare("UPDATE members SET lifecycle = 'archived', updated_at = ? WHERE id = ?")
      .run(now, memberA);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // Read with assignedTo=archived member — event should NOT appear
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-07-15&to=2026-07-17&assignedTo=${memberA}`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBe(0);

      // Read without assignedTo — event should still appear (unscoped read includes unassigned)
      const resAll = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-07-15&to=2026-07-17`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(resAll.statusCode).toBe(200);
      const allBody = JSON.parse(resAll.body);
      expect(allBody.length).toBe(1);
      expect(allBody[0].id).toBe(eventId);
    } finally {
      await app.close();
    }
  });

  // Test 6: Multi-assignee filtered read — GET ?assignedTo=M returns event with assignedTo
  // containing BOTH M and N (Fix 1: assignedTo must be the full set, not a singleton).
  it("Multi-assignee: GET ?assignedTo=M returns event with assignedTo containing both M and N", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const memberN = insertMember("Ned");
    const now = Date.now();

    // Event assigned to both Alice and Ned
    const eventId = "multi-assign-event";
    insertEvent(
      eventId,
      "Multi assignee",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${eventId}-assign-a`, eventId, memberA, now);
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${eventId}-assign-n`, eventId, memberN, now);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/calendar/events?source=all&from=2026-07-15&to=2026-07-17&assignedTo=${memberA}`,
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(eventId);
      // Fix 1: assignedTo must be the FULL set, not just the filter member.
      expect(body[0].assignedTo).toContain(memberA);
      expect(body[0].assignedTo).toContain(memberN);
    } finally {
      await app.close();
    }
  });

  // Test 7: PUT response is a real FeedItem — real title, occurrenceStart, allDay (Fix 2).
  it("PUT response is a real FeedItem with title, occurrenceStart, allDay", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const eventId = "feeditem-response-event";
    insertEvent(
      eventId,
      "Real feed event",
      "2026-07-15T14:00:00.000Z",
      "2026-07-15T15:00:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: [memberA] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Fix 2: response must be a real FeedItem, not a blank placeholder.
      expect(body.title).toBe("Real feed event");
      expect(typeof body.occurrenceStart).toBe("string");
      expect(body.occurrenceStart).not.toBe("");
      expect(body.allDay).toBe(false);
      expect(body.id).toBe(eventId);
    } finally {
      await app.close();
    }
  });

  // Test 8: PUT {memberIds: null}/{}/null → 400 (Fix 3: body validation).
  it("PUT {memberIds: null} and {} → 400 (body validation)", async () => {
    const deviceKey = insertDevice();
    const eventId = "validation-test-event";
    insertEvent(
      eventId,
      "Validation event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      // {memberIds: null}
      const resNull = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: null },
      });
      expect(resNull.statusCode).toBe(400);

      // {}
      const resEmpty = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: {},
      });
      expect(resEmpty.statusCode).toBe(400);

      // null body
      const resNullBody = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(resNullBody.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // Test 9: PUT {memberIds: [M, M]} → 200 with exactly ONE assignment to M (Fix 4: dedup).
  it("PUT {memberIds: [M, M]} → 200 with exactly ONE assignment to M (dedup)", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const eventId = "dedup-test-event";
    insertEvent(
      eventId,
      "Dedup event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: [memberA, memberA] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assignedTo).toEqual([memberA]);

      // Verify exactly one row in calendar_assignments for this event.
      const count = getDb()
        .prepare("SELECT COUNT(*) AS cnt FROM calendar_assignments WHERE event_id = ?")
        .get(eventId) as { cnt: number };
      expect(count.cnt).toBe(1);
    } finally {
      await app.close();
    }
  });

  // Test 10: PUT {memberIds: []} → 200 clears all assignments.
  it("PUT {memberIds: []} → 200 clears all assignments", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");
    const now = Date.now();
    const eventId = "clear-test-event";
    insertEvent(
      eventId,
      "Clear event",
      "2026-07-15T09:00:00.000Z",
      "2026-07-15T09:30:00.000Z",
      null
    );
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(`${eventId}-assign`, eventId, memberA, now);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/${eventId}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: [] },
      });

      expect(res.statusCode).toBe(200);

      // Verify all assignments for this event are gone.
      const count = getDb()
        .prepare("SELECT COUNT(*) AS cnt FROM calendar_assignments WHERE event_id = ?")
        .get(eventId) as { cnt: number };
      expect(count.cnt).toBe(0);
    } finally {
      await app.close();
    }
  });

  // Test 11: PUT to an unknown event id → 404 (Fix: NotFoundError → 404).
  it("PUT to unknown event → 404", async () => {
    const deviceKey = insertDevice();
    const memberA = insertMember("Alice");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/calendar/events/nonexistent-id/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { memberIds: [memberA] },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(typeof body.error).toBe("string");
    } finally {
      await app.close();
    }
  });
});
