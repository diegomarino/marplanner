import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getEvents } from "../../src/server/modules/calendar/index";
import { startExternalSourceSynchronization } from "../../src/server/modules/calendar/sync-coordinator";
import { useIsolatedDb } from "../helpers/db";

const now = Date.parse("2026-10-10T12:00:00Z");
const range = { from: "2026-10-15", to: "2026-10-15" };

const ics = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:alex-appointment",
  "DTSTAMP:20261010T120000Z",
  "DTSTART;VALUE=DATE:20261015",
  "SUMMARY:Alex appointment",
  "DESCRIPTION:Private detail",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:household-event",
  "DTSTAMP:20261010T120000Z",
  "DTSTART;VALUE=DATE:20261015",
  "SUMMARY:Household event",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("synchronized Calendar merged feed", () => {
  useIsolatedDb();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("merges synchronized occurrences once with stable provenance and title-derived member scope", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at)
       VALUES ('alex', 'Alex', 'child', 'active', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO calendar_external_sources
       (id, name, provider, feed_url, created_at, updated_at)
       VALUES ('school', 'School', 'apple', 'https://calendar.example.test/private?token=secret', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO calendar_events
       (id, source, title, all_day, start_date, end_date, created_at, updated_at)
       VALUES ('local', 'local', 'Local event', 1, '2026-10-15', '2026-10-16', ?, ?)`
    ).run(now, now);

    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      transport: async () => ics,
    };
    await startExternalSourceSynchronization("school", dependencies);
    const first = getEvents({ source: "all", range });
    expect(first).toHaveLength(3);
    const assigned = first.find((item) => item.title === "Alex appointment");
    expect(assigned).toMatchObject({
      source: "external",
      assignedTo: ["alex"],
      provider: "apple",
      sourceRef: "https://calendar.example.test/***",
    });
    expect(first.find((item) => item.title === "Household event")?.assignedTo).toEqual([]);
    expect(getEvents({ source: "external", assignedTo: "alex", range })).toEqual([assigned]);

    await startExternalSourceSynchronization("school", dependencies);
    expect(getEvents({ source: "all", range })).toEqual(first);
    expect(new Set(first.map((item) => `${item.id}:${item.occurrenceStart}`)).size).toBe(3);
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(JSON.stringify(first)).not.toContain("Private detail");
  });

  it("keeps distinct recurrence IDs and event IDs across an unchanged synchronization", async () => {
    getDb()
      .prepare(
        `INSERT INTO calendar_external_sources
         (id, name, provider, feed_url, created_at, updated_at)
         VALUES ('series', 'Series', 'ics_generic', 'https://calendar.example.test/series', ?, ?)`
      )
      .run(now, now);
    const recurrenceIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:repeat-uid",
      "DTSTAMP:20261010T120000Z",
      "DTSTART;VALUE=DATE:20261015",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Repeated event",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      transport: async () => recurrenceIcs,
    };

    await startExternalSourceSynchronization("series", dependencies);
    const first = getEvents({
      source: "external",
      range: { from: "2026-10-15", to: "2026-10-16" },
    });
    expect(first.map((item) => item.occurrenceStart).sort()).toEqual(["2026-10-15", "2026-10-16"]);
    expect(new Set(first.map((item) => item.id)).size).toBe(2);
    expect(
      getDb()
        .prepare("SELECT recurrence_id FROM calendar_external_event_meta ORDER BY recurrence_id")
        .all()
    ).toEqual([{ recurrence_id: "2026-10-15" }, { recurrence_id: "2026-10-16" }]);

    await startExternalSourceSynchronization("series", dependencies);
    expect(
      getEvents({ source: "external", range: { from: "2026-10-15", to: "2026-10-16" } })
    ).toEqual(first);
  });
});
