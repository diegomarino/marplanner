import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { listExternalSources } from "../../src/server/modules/calendar/external-sources";
import {
  reconcileExternalCalendar,
  recordUnchangedSynchronization,
} from "../../src/server/modules/calendar/reconcile";
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
  // Keep fixed Calendar fixtures inside the production rolling window; leave async timers real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

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

  function assignedByTitle(memberNames: string[], titles: string[]): Record<string, string[]> {
    insertSource();
    memberNames.forEach((name, index) => {
      getDb()
        .prepare(
          "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'child', ?, ?)"
        )
        .run(`member-${index}`, name, index, index);
    });
    reconcileExternalCalendar(
      sourceId,
      parsed(...titles.map((title, index) => occurrence(`uid-${index}`, title)))
    );
    const rows = getDb()
      .prepare(
        `SELECT events.title, members.display_name FROM calendar_events events
         LEFT JOIN calendar_assignments assignments ON assignments.event_id = events.id
         LEFT JOIN members ON members.id = assignments.member_id
         ORDER BY members.created_at`
      )
      .all() as Array<{ title: string; display_name: string | null }>;
    const result: Record<string, string[]> = {};
    for (const row of rows) {
      result[row.title] ??= [];
      if (row.display_name) result[row.title].push(row.display_name);
    }
    return result;
  }

  it("assigns members named anywhere in the title, by first name unless it is shared", () => {
    expect(
      assignedByTitle(
        ["Lucas García", "Nico", "María", "Pablo Ruiz", "Pablo Sanz"],
        [
          "⚽️ Lucas: Fútbol",
          "Cumple de maria",
          "Coro con Nico y Lucas",
          "Pablo: Trompeta",
          "Pablo Sanz: Trompeta",
          "Nicolas: dentista",
        ]
      )
    ).toEqual({
      "⚽️ Lucas: Fútbol": ["Lucas García"],
      "Cumple de maria": ["María"],
      "Coro con Nico y Lucas": ["Lucas García", "Nico"],
      "Pablo: Trompeta": [],
      "Pablo Sanz: Trompeta": ["Pablo Sanz"],
      "Nicolas: dentista": [],
    });
  });

  it("assigns initials only as an uppercase title prefix or dash suffix", () => {
    expect(
      assignedByTitle(
        ["Pablo", "Nico", "Lucas", "María"],
        [
          "NL: Lenguaje Musical",
          "🎺 PNLM: Concierto",
          "P, N: Dentista",
          "N y L - Coro",
          "Concierto - PN",
          "Partido NL en casa",
          "nl: minúsculas",
          "ITV: revisión",
          "PE: gimnasia",
          "AFC Bournemouth 0:1 Liverpool FC",
        ]
      )
    ).toEqual({
      "NL: Lenguaje Musical": ["Nico", "Lucas"],
      "🎺 PNLM: Concierto": ["Pablo", "Nico", "Lucas", "María"],
      "P, N: Dentista": ["Pablo", "Nico"],
      "N y L - Coro": ["Nico", "Lucas"],
      "Concierto - PN": ["Pablo", "Nico"],
      "Partido NL en casa": [],
      "nl: minúsculas": [],
      "ITV: revisión": [],
      "PE: gimnasia": [],
      "AFC Bournemouth 0:1 Liverpool FC": [],
    });
  });

  it("leaves a shared initial unassigned unless it is repeated once per member", () => {
    expect(
      assignedByTitle(
        ["Marge", "Maggie", "Bart"],
        ["M: Check-up", "MM: Check-up", "MB: Bowling", "MMB: Bowling", "BB: Skate", "MMM: Party"]
      )
    ).toEqual({
      "M: Check-up": [],
      "MM: Check-up": ["Marge", "Maggie"],
      "MB: Bowling": [],
      "MMB: Bowling": ["Marge", "Maggie", "Bart"],
      "BB: Skate": [],
      "MMM: Party": [],
    });
  });

  it("re-derives title assignments on an unchanged feed and keeps manual ones", () => {
    insertSource();
    reconcileExternalCalendar(
      sourceId,
      parsed(
        occurrence("one", "Bart school"),
        occurrence("two", "Lisa: Coro"),
        occurrence("gone", "Bart: Skate", "cancelled")
      )
    );
    expect(getDb().prepare("SELECT id FROM calendar_assignments").all()).toEqual([]);

    for (const [id, name] of [
      ["member-bart", "Bart"],
      ["member-lisa", "Lisa"],
    ]) {
      getDb()
        .prepare(
          "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'child', ?, ?)"
        )
        .run(id, name, Date.now(), Date.now());
    }
    const lisaEvent = getDb()
      .prepare("SELECT id FROM calendar_events WHERE title = 'Lisa: Coro'")
      .get() as { id: string };
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('manual-uuid', ?, 'member-bart', 1)"
      )
      .run(lisaEvent.id);

    recordUnchangedSynchronization(sourceId);

    expect(
      getDb()
        .prepare(
          `SELECT events.title, assignments.member_id, assignments.id LIKE 'ext:%' AS derived
           FROM calendar_assignments assignments
           JOIN calendar_events events ON events.id = assignments.event_id
           ORDER BY events.title, assignments.member_id`
        )
        .all()
    ).toEqual([
      { title: "Bart school", member_id: "member-bart", derived: 1 },
      { title: "Lisa: Coro", member_id: "member-bart", derived: 0 },
      { title: "Lisa: Coro", member_id: "member-lisa", derived: 1 },
    ]);
  });

  it("leaves title assignments untouched on an unchanged feed while the household is unchanged", () => {
    insertSource();
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('member-bart', 'Bart', 'child', 1, 1)"
      )
      .run();
    reconcileExternalCalendar(sourceId, parsed(occurrence("one", "Bart school")));
    const derivedRows = () =>
      getDb()
        .prepare("SELECT member_id, created_at FROM calendar_assignments WHERE id LIKE 'ext:%'")
        .all();
    const published = derivedRows();
    expect(published).toHaveLength(1);

    vi.setSystemTime(new Date("2026-09-28T12:05:00Z"));
    recordUnchangedSynchronization(sourceId);
    expect(derivedRows()).toEqual(published);

    getDb()
      .prepare("UPDATE members SET display_name = 'Bartholomew', updated_at = ? WHERE id = ?")
      .run(Date.now(), "member-bart");
    vi.setSystemTime(new Date("2026-09-28T12:10:00Z"));
    recordUnchangedSynchronization(sourceId);
    expect(derivedRows()).toEqual([]);
  });
});
