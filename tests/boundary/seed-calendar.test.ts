import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { createEvent, getEvents } from "../../src/server/modules/calendar";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;
const RAW_URLS = [
  "https://web-api.worldpublicholiday.com/v1/holidays/calendar.ics?country=ES&year=2026",
  "https://cantonbecker.com/astronomy-calendar/astrocal.ics",
  "https://cdn.celtics.com/schedule/ics/2026_celtics_schedule.ics",
  "https://api.sports-calendar.com/ics/soccer/english-premier-league/2026-2027/matches.ics",
];

describe("Calendar demo seed boundary", () => {
  useIsolatedDb();
  // Keep fixed Calendar fixtures inside the production rolling window; leave async timers real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("creates four enabled normalized source configurations without fetching or external events", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const report = await runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
      });

      expect(report.moduleIds).toEqual([
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
      ]);
      expect(
        getDb()
          .prepare(
            "SELECT id, name, provider, enabled, poll_interval_min FROM calendar_external_sources ORDER BY id"
          )
          .all()
      ).toEqual([
        {
          id: "demo:calendar:source:astronomy",
          name: "Astronomy calendar",
          provider: "ics_generic",
          enabled: 1,
          poll_interval_min: 60,
        },
        {
          id: "demo:calendar:source:boston-celtics",
          name: "Boston Celtics 2026 season",
          provider: "ics_generic",
          enabled: 1,
          poll_interval_min: 60,
        },
        {
          id: "demo:calendar:source:english-premier-league",
          name: "English Premier League 2026-2027",
          provider: "ics_generic",
          enabled: 1,
          poll_interval_min: 60,
        },
        {
          id: "demo:calendar:source:spain-holidays",
          name: "Spain public holidays (2026)",
          provider: "ics_generic",
          enabled: 1,
          poll_interval_min: 60,
        },
      ]);
      expect(
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE source = 'external'")
          .get()
      ).toEqual({ count: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("upserts a validated seed-owned local event without altering an ordinary event", async () => {
    const calendar = await import("../../src/server/modules/calendar");
    const upsertSeedEvent = (calendar as typeof calendar & { upsertSeedEvent?: SeedEventUpsert })
      .upsertSeedEvent;
    expect(upsertSeedEvent).toBeTypeOf("function");
    if (!upsertSeedEvent) throw new Error("Missing seed-owned Calendar event upsert");

    const ordinary = createEvent({
      title: "Ordinary household event",
      allDay: true,
      startDate: "2026-09-23",
      endDate: "2026-09-24",
    });

    upsertSeedEvent({
      id: "demo:calendar:event:lisas-science-fair",
      title: "Outdated science fair",
      allDay: true,
      startDate: "2026-09-24",
      endDate: "2026-09-25",
      nowMs: NOW,
    });
    upsertSeedEvent({
      id: "demo:calendar:event:lisas-science-fair",
      title: "Lisa's science fair",
      allDay: true,
      startDate: "2026-09-24",
      endDate: "2026-09-25",
      nowMs: NOW + 1,
    });

    await expect(() =>
      upsertSeedEvent({
        id: ordinary.id,
        title: "Attempted overwrite",
        allDay: true,
        startDate: "2026-09-23",
        endDate: "2026-09-24",
        nowMs: NOW + 2,
      })
    ).toThrow(/seed-owned/i);
    await expect(() =>
      upsertSeedEvent({
        id: "demo:calendar:event:invalid",
        title: "Invalid event",
        allDay: true,
        startDate: "2026-09-24",
        endDate: "2026-09-24",
        nowMs: NOW + 2,
      })
    ).toThrow(/end_date/i);

    const publicEvents = getEvents({
      source: "all",
      range: { from: "2026-09-23", to: "2026-09-25" },
    }).map((event) => ({
      id: event.id,
      title: event.title,
      source: event.source,
      allDay: event.allDay,
    }));
    expect(publicEvents).toHaveLength(2);
    expect(publicEvents).toEqual(
      expect.arrayContaining([
        {
          id: "demo:calendar:event:lisas-science-fair",
          title: "Lisa's science fair",
          source: "local",
          allDay: true,
        },
        {
          id: ordinary.id,
          title: "Ordinary household event",
          source: "local",
          allDay: true,
        },
      ])
    );
    expect(
      getDb()
        .prepare("SELECT created_at, updated_at FROM calendar_events WHERE id = ?")
        .get("demo:calendar:event:lisas-science-fair")
    ).toEqual({ created_at: NOW, updated_at: NOW + 1 });
  });

  it("keeps the relative ordering-demo event matrix stable across a changed-clock rerun", async () => {
    const request = {
      mode: "public" as const,
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
    };

    await runSeedProfile(request);
    const first = seededLocalEvents();
    await runSeedProfile({ ...request, nowMs: NOW + 1 });

    expect(seededLocalEvents()).toEqual(first);
    expect(first).toEqual([
      {
        id: "demo:calendar:event:bart-dentist",
        title: "Bart dentist appointment",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-22T14:00:00.000Z",
        occurrenceEnd: "2026-09-22T15:00:00.000Z",
        assignedTo: ["demo:member:bart"],
      },
      {
        id: "demo:calendar:event:family-afternoon",
        title: "Family afternoon",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-23T13:00:00.000Z",
        occurrenceEnd: "2026-09-23T16:00:00.000Z",
        assignedTo: ["demo:member:bart", "demo:member:lisa", "demo:member:maggie"],
      },
      {
        id: "demo:calendar:event:family-bowling",
        title: "Family bowling night",
        source: "local",
        allDay: true,
        occurrenceStart: "2026-09-23",
        occurrenceEnd: "2026-09-24",
        assignedTo: ["demo:member:bart", "demo:member:lisa", "demo:member:maggie"],
      },
      {
        id: "demo:calendar:event:grandparents-visiting",
        title: "Grandparents visiting",
        source: "local",
        allDay: true,
        occurrenceStart: "2026-09-22",
        occurrenceEnd: "2026-09-26",
        assignedTo: ["demo:member:bart", "demo:member:lisa"],
      },
      {
        id: "demo:calendar:event:lisa-homework-club",
        title: "Lisa homework club",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-23T14:30:00.000Z",
        occurrenceEnd: "2026-09-23T16:00:00.000Z",
        assignedTo: ["demo:member:lisa"],
      },
      {
        id: "demo:calendar:event:lisa-music-lesson",
        title: "Lisa music lesson",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-22T14:00:00.000Z",
        occurrenceEnd: "2026-09-22T16:00:00.000Z",
        assignedTo: ["demo:member:lisa"],
      },
      {
        id: "demo:calendar:event:lisas-science-fair",
        title: "Lisa's science fair",
        source: "local",
        allDay: true,
        occurrenceStart: "2026-09-22",
        occurrenceEnd: "2026-09-23",
        assignedTo: ["demo:member:lisa"],
      },
      {
        id: "demo:calendar:event:maggie-checkup",
        title: "Maggie's check-up",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-24T13:45:00.000Z",
        occurrenceEnd: "2026-09-24T14:00:00.000Z",
        assignedTo: ["demo:member:maggie"],
      },
      {
        id: "demo:calendar:event:pharmacy-stop",
        title: "Bart pharmacy stop",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-23T14:00:00.000Z",
        occurrenceEnd: "2026-09-23T14:20:00.000Z",
        assignedTo: ["demo:member:bart"],
      },
      {
        id: "demo:calendar:event:school-pickup",
        title: "School pickup",
        source: "local",
        allDay: false,
        occurrenceStart: "2026-09-24T13:30:00.000Z",
        occurrenceEnd: "2026-09-24T14:00:00.000Z",
        assignedTo: ["demo:member:bart", "demo:member:lisa"],
      },
    ]);
    expect(
      getDb()
        .prepare("SELECT feed_url FROM calendar_external_sources ORDER BY feed_url")
        .all()
        .map((row) => (row as { feed_url: string }).feed_url)
    ).toEqual(RAW_URLS.sort());
  });
});

type SeedEventUpsert = (input: {
  id: string;
  title: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  nowMs: number;
}) => { id: string };

function seededLocalEvents() {
  return getEvents({ source: "all", range: { from: "2026-09-22", to: "2026-09-25" } })
    .filter((event) => event.id.startsWith("demo:calendar:event:"))
    .map((event) => ({
      id: event.id,
      title: event.title,
      source: event.source,
      allDay: event.allDay,
      occurrenceStart: event.occurrenceStart,
      occurrenceEnd: event.occurrenceEnd,
      assignedTo: event.assignedTo,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
