import { describe, expect, it } from "vitest";

import {
  buildCalendarDays,
  buildWeekDays,
  dateTimeLocalToUtcInstant,
  filterCalendarEvents,
  formatInstantAsDateTimeLocal,
  getEventsForCalendarDay,
  getHouseholdCalendarDate,
  getHouseholdMinuteOfDay,
  presentationEventId,
  shiftCalendarPeriod,
  toScheduleXEvent,
} from "@/calendar/calendar-presentation";
import type { FeedItem } from "../../src/shared";

const EVENTS: FeedItem[] = [
  {
    id: "all-day-a",
    title: "All day for A",
    allDay: true,
    occurrenceStart: "2026-09-10",
    occurrenceEnd: "2026-09-11",
    source: "local",
    assignedTo: ["a"],
  },
  {
    id: "timed-a-b",
    title: "Timed for A and B",
    allDay: false,
    occurrenceStart: "2026-09-10T08:00:00.000Z",
    occurrenceEnd: "2026-09-10T09:00:00.000Z",
    source: "local",
    assignedTo: ["a", "b"],
  },
  {
    id: "timed-b",
    title: "Timed for B",
    allDay: false,
    occurrenceStart: "2026-09-10T10:00:00.000Z",
    occurrenceEnd: "2026-09-10T11:00:00.000Z",
    source: "local",
    assignedTo: ["b"],
  },
  {
    id: "unassigned",
    title: "Unassigned",
    allDay: false,
    occurrenceStart: "2026-09-10T12:00:00.000Z",
    occurrenceEnd: "2026-09-10T13:00:00.000Z",
    source: "external",
    assignedTo: [],
  },
];

function titles(events: readonly FeedItem[]): string[] {
  return events.map((event) => event.title);
}

describe("filterCalendarEvents", () => {
  const activeMemberIds = ["a", "b"];

  it("uses all-day enabled and zero selected members as the unfiltered defaults", () => {
    expect(titles(filterCalendarEvents(EVENTS, true, new Set(), activeMemberIds))).toEqual([
      "All day for A",
      "Timed for A and B",
      "Timed for B",
      "Unassigned",
    ]);
  });

  it("includes events assigned to any selected member and always includes unassigned events", () => {
    expect(titles(filterCalendarEvents(EVENTS, true, new Set(["a"]), activeMemberIds))).toEqual([
      "All day for A",
      "Timed for A and B",
      "Unassigned",
    ]);
    expect(
      titles(filterCalendarEvents(EVENTS, true, new Set(["a", "missing"]), activeMemberIds))
    ).toEqual(["All day for A", "Timed for A and B", "Unassigned"]);
  });

  it("treats all active members selected as equivalent to zero selected members", () => {
    const noneSelected = filterCalendarEvents(EVENTS, true, new Set(), activeMemberIds);
    const allSelected = filterCalendarEvents(
      EVENTS,
      true,
      new Set(activeMemberIds),
      activeMemberIds
    );
    expect(allSelected).toEqual(noneSelected);
  });

  it("hides all-day events independently while keeping matching timed and unassigned events", () => {
    expect(titles(filterCalendarEvents(EVENTS, false, new Set(), activeMemberIds))).toEqual([
      "Timed for A and B",
      "Timed for B",
      "Unassigned",
    ]);
    expect(titles(filterCalendarEvents(EVENTS, false, new Set(["a"]), activeMemberIds))).toEqual([
      "Timed for A and B",
      "Unassigned",
    ]);
  });
});

describe("Calendar date projection", () => {
  it("builds month and week grids from the configured Monday week start", () => {
    const monthDays = buildCalendarDays(2026, 8, 1);
    expect(monthDays[0]).toBe("2026-08-31");
    expect(monthDays.at(-1)).toBe("2026-10-04");

    const weekDays = buildWeekDays("2026-09-10", 1);
    expect(weekDays).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });

  it("derives the household date, week, period shift, and current minute without browser-local getters", () => {
    const instant = "2026-09-30T10:30:00.000Z";

    expect(getHouseholdCalendarDate(instant, "Pacific/Kiritimati")).toBe("2026-10-01");
    expect(getHouseholdCalendarDate(instant, "America/Los_Angeles")).toBe("2026-09-30");
    expect(buildWeekDays("2026-10-01", 1)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(shiftCalendarPeriod("2026-10-01", "month", -1)).toBe("2026-09-01");
    expect(shiftCalendarPeriod("2026-10-01", "week", 1)).toBe("2026-10-08");
    expect(getHouseholdMinuteOfDay("2026-10-01T01:30:00.000Z", "America/New_York")).toBe(
      21 * 60 + 30
    );
  });

  it("round-trips timed form values through the configured household timezone", () => {
    expect(formatInstantAsDateTimeLocal("2026-09-25T14:00:00.000Z", "America/New_York")).toBe(
      "2026-09-25T10:00"
    );
    expect(dateTimeLocalToUtcInstant("2026-09-25T10:00", "America/New_York")).toBe(
      "2026-09-25T14:00:00.000Z"
    );
  });

  it("places a multi-day all-day event on every included date but not its exclusive end", () => {
    const multiDay: FeedItem = {
      id: "trip",
      title: "Trip",
      allDay: true,
      occurrenceStart: "2026-09-10",
      occurrenceEnd: "2026-09-13",
      source: "local",
      assignedTo: [],
    };

    expect(getEventsForCalendarDay([multiDay], "2026-09-09", "Europe/Madrid")).toEqual([]);
    expect(getEventsForCalendarDay([multiDay], "2026-09-10", "Europe/Madrid")).toEqual([multiDay]);
    expect(getEventsForCalendarDay([multiDay], "2026-09-12", "Europe/Madrid")).toEqual([multiDay]);
    expect(getEventsForCalendarDay([multiDay], "2026-09-13", "Europe/Madrid")).toEqual([]);
  });

  it("treats an all-day occurrence without an explicit end as one calendar day", () => {
    const singleDay: FeedItem = {
      id: "single-day",
      title: "Single day",
      allDay: true,
      occurrenceStart: "2026-09-10",
      source: "local",
      assignedTo: [],
    };

    expect(getEventsForCalendarDay([singleDay], "2026-09-10", "Europe/Madrid")).toEqual([
      singleDay,
    ]);
    expect(getEventsForCalendarDay([singleDay], "2026-09-11", "Europe/Madrid")).toEqual([]);
  });

  it("places timed instants by household timezone", () => {
    const lateUtc: FeedItem = {
      id: "late",
      title: "Late UTC",
      allDay: false,
      occurrenceStart: "2026-09-10T23:30:00.000Z",
      occurrenceEnd: "2026-09-11T00:30:00.000Z",
      source: "local",
      assignedTo: [],
    };

    expect(getEventsForCalendarDay([lateUtc], "2026-09-11", "Europe/Madrid")).toEqual([lateUtc]);
    expect(getEventsForCalendarDay([lateUtc], "2026-09-10", "Europe/Madrid")).toEqual([]);
  });

  it("orders all-day events before timed events, then orders each group deterministically", () => {
    const timedLate = {
      ...EVENTS[2],
      id: "timed-late",
      title: "Later timed",
      occurrenceStart: "2026-09-10T16:00:00.000Z",
      occurrenceEnd: "2026-09-10T17:00:00.000Z",
    };
    const allDayLater = {
      ...EVENTS[0],
      id: "all-day-later",
      title: "Later all day",
      occurrenceStart: "2026-09-10",
      occurrenceEnd: "2026-09-11",
    };
    const allDayEarlier = {
      ...EVENTS[0],
      id: "all-day-earlier",
      title: "Earlier all day",
      occurrenceStart: "2026-09-09",
      occurrenceEnd: "2026-09-11",
    };

    expect(
      titles(
        getEventsForCalendarDay(
          [timedLate, allDayLater, EVENTS[1], allDayEarlier],
          "2026-09-10",
          "Europe/Madrid"
        )
      )
    ).toEqual(["Earlier all day", "Later all day", "Timed for A and B", "Later timed"]);
  });

  it("gives recurrence occurrences unique presentation ids and Schedule-X ids", () => {
    const first = EVENTS[1];
    const second = {
      ...first,
      occurrenceStart: "2026-09-17T08:00:00.000Z",
      occurrenceEnd: "2026-09-17T09:00:00.000Z",
    };

    expect(presentationEventId(first)).not.toBe(presentationEventId(second));
    expect(toScheduleXEvent(first, "Europe/Madrid").id).not.toBe(
      toScheduleXEvent(second, "Europe/Madrid").id
    );
  });

  it("projects all-day Schedule-X ranges with an inclusive displayed end", () => {
    const multiDay: FeedItem = {
      id: "trip",
      title: "Trip",
      allDay: true,
      occurrenceStart: "2026-09-10",
      occurrenceEnd: "2026-09-13",
      source: "local",
      assignedTo: [],
    };

    const projected = toScheduleXEvent(multiDay, "Europe/Madrid");
    expect(projected.start.toString()).toBe("2026-09-10");
    expect(projected.end.toString()).toBe("2026-09-12");
  });
});
