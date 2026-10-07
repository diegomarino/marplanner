import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { listExternalSources } from "../../src/server/modules/calendar/external-sources";
import { reconcileExternalCalendar } from "../../src/server/modules/calendar/reconcile";
import type {
  ParsedCalendar,
  ParsedExternalOccurrence,
} from "../../src/server/modules/calendar/parse-ics";
import { calendarRoutes } from "../../src/server/routes/calendar";
import { useIsolatedDb } from "../helpers/db";

const sourceId = "source-one";

function occurrence(
  uid: string,
  title: string,
  status: "active" | "cancelled" = "active"
): ParsedExternalOccurrence {
  return {
    externalUid: uid,
    recurrenceId: "",
    title,
    allDay: true,
    startDate: "2026-09-28",
    endDate: "2026-09-29",
    status,
    rawHash: createHash("sha256").update(`${uid}:${title}:${status}`).digest("hex"),
  };
}

function parsed(...occurrences: ParsedExternalOccurrence[]): ParsedCalendar {
  return { occurrences, skippedCount: 0 };
}

describe("calendar sync publication", () => {
  useIsolatedDb();

  function insertSource(): void {
    getDb()
      .prepare(
        "INSERT INTO calendar_external_sources (id, name, provider, feed_url, created_at, updated_at) VALUES (?, 'Source', 'ics_generic', 'https://calendar.example.test/feed', 1, 1)"
      )
      .run(sourceId);
  }

  it("repeats without duplicates, replaces title assignments, and cancels missing occurrences", () => {
    insertSource();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('member-bart', 'Bart', 'child', 1, 1)"
      )
      .run();

    reconcileExternalCalendar(
      sourceId,
      parsed(occurrence("one", "Bart school"), occurrence("two", "Family trip"))
    );
    reconcileExternalCalendar(
      sourceId,
      parsed(occurrence("one", "Bart school"), occurrence("two", "Family trip"))
    );
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM calendar_external_event_meta WHERE source_id = ?")
        .get(sourceId)
    ).toEqual({ count: 2 });
    expect(
      getDb().prepare("SELECT member_id FROM calendar_assignments WHERE id LIKE 'ext:%'").all()
    ).toEqual([{ member_id: "member-bart" }]);

    reconcileExternalCalendar(sourceId, parsed(occurrence("one", "Family school")));
    expect(
      getDb()
        .prepare(
          "SELECT external_uid, status FROM calendar_external_event_meta WHERE source_id = ? ORDER BY external_uid"
        )
        .all(sourceId)
    ).toEqual([
      { external_uid: "one", status: "active" },
      { external_uid: "two", status: "cancelled" },
    ]);
    expect(
      getDb().prepare("SELECT id FROM calendar_assignments WHERE id LIKE 'ext:%'").all()
    ).toEqual([]);
  });

  it("rolls back every event, assignment, and success-health write when publication fails", () => {
    insertSource();
    reconcileExternalCalendar(sourceId, parsed(occurrence("one", "Original")));
    const before = {
      events: getDb().prepare("SELECT * FROM calendar_events").all(),
      meta: getDb().prepare("SELECT * FROM calendar_external_event_meta").all(),
      source: getDb().prepare("SELECT * FROM calendar_external_sources").all(),
    };
    getDb().exec(
      "CREATE TRIGGER fail_calendar_publication BEFORE INSERT ON calendar_external_event_meta WHEN NEW.external_uid = 'two' BEGIN SELECT RAISE(ABORT, 'forced publication failure'); END"
    );

    expect(() =>
      reconcileExternalCalendar(
        sourceId,
        parsed(occurrence("one", "Changed"), occurrence("two", "New"))
      )
    ).toThrow("forced publication failure");
    expect(getDb().prepare("SELECT * FROM calendar_events").all()).toEqual(before.events);
    expect(getDb().prepare("SELECT * FROM calendar_external_event_meta").all()).toEqual(
      before.meta
    );
    expect(getDb().prepare("SELECT * FROM calendar_external_sources").all()).toEqual(before.source);
  });

  it("purges a cancelled occurrence after it leaves the supported retention window", () => {
    insertSource();
    reconcileExternalCalendar(sourceId, parsed(occurrence("old", "Past event")));
    getDb()
      .prepare("UPDATE calendar_events SET start_date = '2020-01-01', end_date = '2020-01-02'")
      .run();

    reconcileExternalCalendar(sourceId, parsed());
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM calendar_external_event_meta").get()
    ).toEqual({ count: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM calendar_events").get()).toEqual({
      count: 0,
    });
  });

  it("keeps a manual non-ext assignment when title-derived would claim the same member", () => {
    insertSource();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('member-bart', 'Bart', 'child', 1, 1)"
      )
      .run();

    reconcileExternalCalendar(sourceId, parsed(occurrence("one", "Bart school")));
    const eventId = (
      getDb()
        .prepare(
          "SELECT event_id AS id FROM calendar_external_event_meta WHERE external_uid = 'one'"
        )
        .get() as { id: string }
    ).id;

    getDb().prepare("DELETE FROM calendar_assignments WHERE event_id = ?").run(eventId);
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('manual-uuid', ?, 'member-bart', 1)"
      )
      .run(eventId);

    expect(() =>
      reconcileExternalCalendar(sourceId, parsed(occurrence("one", "Bart school")))
    ).not.toThrow();

    expect(
      getDb()
        .prepare("SELECT id, member_id FROM calendar_assignments WHERE event_id = ? ORDER BY id")
        .all(eventId)
    ).toEqual([{ id: "manual-uuid", member_id: "member-bart" }]);
    expect(
      getDb()
        .prepare("SELECT last_error_code FROM calendar_external_sources WHERE id = ?")
        .get(sourceId)
    ).toEqual({ last_error_code: null });
  });

  it("starts manual sync for an enabled source and rejects missing or disabled sources", async () => {
    insertSource();
    const app = Fastify();
    await calendarRoutes(app, {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR",
    });
    try {
      const started = await app.inject({
        method: "POST",
        url: `/api/calendar/external-sources/${sourceId}/sync`,
      });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({ id: sourceId, phase: expect.any(String) });
      expect(started.body).not.toContain("calendar.example.test/feed");
      expect(
        (await app.inject({ method: "POST", url: "/api/calendar/external-sources/missing/sync" }))
          .statusCode
      ).toBe(404);
      getDb()
        .prepare("UPDATE calendar_external_sources SET enabled = 0 WHERE id = ?")
        .run(sourceId);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/calendar/external-sources/${sourceId}/sync`,
          })
        ).statusCode
      ).toBe(409);
      expect(listExternalSources()[0].enabled).toBe(false);
    } finally {
      await app.close();
    }
  });
});
