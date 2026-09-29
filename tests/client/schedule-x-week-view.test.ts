import { describe, expect, it } from "vitest";

import { formatWeekEventTime } from "@/calendar/ScheduleXWeekView";
import type { FeedItem } from "../../src/shared";

describe("ScheduleXWeekView event projection", () => {
  it("does not format a stale portal after its event has been filtered out", () => {
    expect(formatWeekEventTime(undefined, "Europe/Madrid")).toBeNull();
  });

  it("formats a retained timed event in the household timezone", () => {
    const event: FeedItem = {
      id: "timed-event",
      title: "Dentist",
      allDay: false,
      occurrenceStart: "2026-09-25T08:00:00.000Z",
      occurrenceEnd: "2026-09-25T09:00:00.000Z",
      source: "local",
      assignedTo: [],
    };

    expect(formatWeekEventTime(event, "Europe/Madrid")).toBe("10:00");
  });
});
