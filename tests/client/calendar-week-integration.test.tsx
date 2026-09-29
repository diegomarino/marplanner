import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { presentationEventId } from "@/calendar/calendar-presentation";
import type { FeedItem } from "../../src/shared";

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

vi.mock("@/calendar/ScheduleXWeekView", () => ({
  ScheduleXWeekView: ({
    events,
    onEventClick,
  }: {
    events: readonly FeedItem[];
    onEventClick: (event: FeedItem) => void;
  }) => (
    <div data-testid="calendar-week-grid">
      {events.map((event) => (
        <button
          key={presentationEventId(event)}
          type="button"
          data-testid="calendar-event-row"
          data-presentation-id={presentationEventId(event)}
          data-all-day={String(event.allDay)}
          onClick={() => onEventClick(event)}
        >
          {event.title}
        </button>
      ))}
    </div>
  ),
}));

import { CalendarView } from "@/calendar/CalendarView";
import { LanguageProvider } from "@/i18n";

const TODAY = "2026-09-25";
const MEMBERS = [
  { id: "m1", displayName: "Alice", lifecycle: "active", colorKey: "blue" },
  { id: "m2", displayName: "Bob", lifecycle: "active", colorKey: "violet" },
];

function event(overrides: Partial<FeedItem> & Pick<FeedItem, "id" | "title">): FeedItem {
  return {
    allDay: false,
    occurrenceStart: `${TODAY}T08:00:00.000Z`,
    occurrenceEnd: `${TODAY}T09:00:00.000Z`,
    source: "local",
    assignedTo: [],
    ...overrides,
  };
}

function mockBackend(events: readonly FeedItem[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/calendar/events")) {
        return Promise.resolve(new Response(JSON.stringify(events), { status: 200 }));
      }
      if (url.includes("/api/members")) {
        return Promise.resolve(new Response(JSON.stringify(MEMBERS), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

function renderSurface() {
  return render(
    <LanguageProvider>
      <CalendarView />
    </LanguageProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

describe("CalendarView — Week integration", () => {
  it("keeps recurrence occurrences distinct and activates local/external and all-day events", async () => {
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    mockBackend([
      event({ id: "recurring-master", title: "Recurring week" }),
      event({
        id: "recurring-master",
        title: "Recurring week",
        occurrenceStart: "2026-09-26T08:00:00.000Z",
        occurrenceEnd: "2026-09-26T09:00:00.000Z",
      }),
      event({
        id: "all-day-week",
        title: "All-day week",
        allDay: true,
        occurrenceStart: TODAY,
        occurrenceEnd: "2026-09-26",
      }),
      event({ id: "external-week", title: "External week", source: "external" }),
    ]);
    renderSurface();

    await screen.findByTestId("calendar-month-grid");
    fireEvent.click(screen.getByRole("button", { name: "Week" }));

    const recurring = screen.getAllByText("Recurring week");
    expect(recurring).toHaveLength(2);
    expect(new Set(recurring.map((row) => row.getAttribute("data-presentation-id"))).size).toBe(2);
    expect(screen.getByText("All-day week")).toHaveAttribute("data-all-day", "true");

    fireEvent.click(screen.getByText("External week"));
    expect(await screen.findByText("External event — read only")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-edit-btn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(recurring[0]);
    expect(await screen.findByTestId("calendar-edit-btn")).toBeInTheDocument();
  });

  it("passes member and all-day filter changes to the Week collection", async () => {
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    mockBackend([
      event({ id: "alice-week", title: "Alice week", assignedTo: ["m1"] }),
      event({ id: "bob-week", title: "Bob week", assignedTo: ["m2"] }),
      event({
        id: "alice-all-day-week",
        title: "Alice all-day week",
        allDay: true,
        occurrenceStart: TODAY,
        occurrenceEnd: "2026-09-26",
        assignedTo: ["m1"],
      }),
      event({ id: "unassigned-week", title: "Unassigned week" }),
    ]);
    renderSurface();

    await screen.findByTestId("calendar-month-grid");
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByText("Bob week")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    await waitFor(() => expect(screen.queryByText("Bob week")).not.toBeInTheDocument());
    expect(screen.getByText("Alice week")).toBeInTheDocument();
    expect(screen.getByText("Alice all-day week")).toBeInTheDocument();
    expect(screen.getByText("Unassigned week")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "All-day events" }));
    await waitFor(() => expect(screen.queryByText("Alice all-day week")).not.toBeInTheDocument());
    expect(screen.getByText("Alice week")).toBeInTheDocument();
    expect(screen.getByText("Unassigned week")).toBeInTheDocument();
  });
});
