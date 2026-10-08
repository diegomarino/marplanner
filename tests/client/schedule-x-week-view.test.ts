import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScheduleXWeekView, formatWeekEventTime } from "@/calendar/ScheduleXWeekView";
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

const localeState = vi.hoisted(() => ({ language: "en" }));
vi.mock("@/i18n", () => ({ useTranslation: () => localeState }));
afterEach(() => {
  cleanup();
  localeState.language = "en";
});

it("updates actual week headings when the household language changes", async () => {
  const props = {
    selectedDate: "2026-09-21",
    timezone: "Europe/Madrid",
    weekStartDay: 1 as const,
    events: [],
    members: [],
    onEventClick: vi.fn(),
    scrollToNowKey: 0,
  };
  const { rerender } = render(createElement(ScheduleXWeekView, props));
  await waitFor(() => expect(screen.getByTestId("calendar-week-grid")).toHaveTextContent("Mon"));
  localeState.language = "es";
  rerender(createElement(ScheduleXWeekView, props));
  await waitFor(() => expect(screen.getByTestId("calendar-week-grid")).toHaveTextContent("lun"));
  expect(screen.getByTestId("calendar-week-grid")).not.toHaveTextContent("Mon");
});
