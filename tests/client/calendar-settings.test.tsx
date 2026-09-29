import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarView } from "@/calendar/CalendarView";
import { LanguageProvider } from "@/i18n";

const household = vi.hoisted(() => ({
  timezone: "America/New_York",
  weekStartDay: 0,
}));

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => ({
    status: "ready",
    timezone: household.timezone,
    language: "en",
    weekStartDay: household.weekStartDay,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
    retry: vi.fn(),
  }),
  useHouseholdSettingsContext: () => undefined,
}));

const originalTz = process.env.TZ;

afterEach(() => {
  household.timezone = "America/New_York";
  household.weekStartDay = 0;
  process.env.TZ = originalTz;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

describe("CalendarView — household Calendar settings", () => {
  it("uses Sunday-first headers and places timed events in the household timezone", async () => {
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.includes("/api/calendar/events") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "evt-timezone",
                title: "New York evening",
                allDay: false,
                occurrenceStart: "2026-09-26T01:30:00.000Z",
                occurrenceEnd: "2026-09-26T02:00:00.000Z",
                source: "local",
                assignedTo: [],
              },
            ]),
            { status: 200 }
          )
        );
      }
      if (url.includes("/api/members")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      if (url.endsWith("/api/calendar/events") && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    const { container } = render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    const headers = await screen.findAllByRole("columnheader");
    expect(headers[0]).toHaveTextContent("Sun");
    await waitFor(() => {
      expect(container.querySelector('[data-date="2026-09-25"]')).toHaveTextContent(
        "New York evening"
      );
    });
    expect(container.querySelector('[data-date="2026-09-26"]')).not.toHaveTextContent(
      "New York evening"
    );

    fireEvent.click(screen.getByTestId("calendar-create-btn"));
    const title = screen.getByTestId("calendar-create-title-input");
    const form = title.closest("form");
    if (!form) throw new Error("create form missing");
    fireEvent.change(title, { target: { value: "Household time" } });
    fireEvent.click(form.querySelector('input[type="checkbox"]') as HTMLInputElement);
    const dateTimes = form.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(dateTimes[0], { target: { value: "2026-09-25T10:00" } });
    fireEvent.change(dateTimes[1], { target: { value: "2026-09-25T11:00" } });
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([input, init]) => String(input).endsWith("/api/calendar/events") && init?.method === "POST"
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        allDay: false,
        tzid: "America/New_York",
        startUtc: "2026-09-25T14:00:00.000Z",
        endUtc: "2026-09-25T15:00:00.000Z",
      });
    });
  });

  it("selects the household calendar date near midnight when the browser is on another day", async () => {
    process.env.TZ = "America/Los_Angeles";
    household.timezone = "Asia/Tokyo";
    household.weekStartDay = 1;
    vi.setSystemTime(new Date("2026-09-30T23:30:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/api/calendar/events") || url.includes("/api/members")) {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { container } = render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    expect(await screen.findByTestId("calendar-period-title")).toHaveTextContent("October 2026");
    expect(container.querySelector('[data-date="2026-10-01"]')).toHaveAttribute(
      "data-today",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByTestId("calendar-period-title")).toHaveTextContent("28 Sept – 4 Oct 2026");
  });

  it("opens timed edits in household wall time and submits no time shift when unchanged", async () => {
    process.env.TZ = "Europe/Madrid";
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/calendar/events") && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "evt-edit-timezone",
                title: "Household edit",
                allDay: false,
                occurrenceStart: "2026-09-25T14:00:00.000Z",
                occurrenceEnd: "2026-09-25T15:00:00.000Z",
                source: "local",
                assignedTo: [],
              },
            ]),
            { status: 200 }
          )
        );
      }
      if (url.includes("/api/members")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      if (/\/api\/calendar\/events\/[^/]+$/.test(url) && method === "PATCH") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url} (${method})`);
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    fireEvent.click(await screen.findByTestId("calendar-event-row"));
    fireEvent.click(screen.getByTestId("calendar-edit-btn"));
    const dateTimes = screen
      .getByTestId("calendar-event-detail")
      .querySelectorAll('input[type="datetime-local"]');
    expect(dateTimes[0]).toHaveValue("2026-09-25T10:00");
    expect(dateTimes[1]).toHaveValue("2026-09-25T11:00");
    fireEvent.click(screen.getByTestId("calendar-edit-save-btn"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({});
    });
  });
});
