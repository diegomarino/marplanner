import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayAgenda } from "@/home/TodayAgenda";
import { householdDayRange, presentAgenda } from "@/home/agenda-presentation";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { Role, type FeedItem, type Member } from "../../src/shared";

const NOW = Date.parse("2026-09-22T10:00:00Z");
const members: Member[] = [
  {
    id: "a",
    displayName: "Alex",
    colorKey: "blue",
    role: Role.child,
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "b",
    displayName: "Blair",
    colorKey: "rose",
    role: Role.parent,
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "c",
    displayName: "Casey",
    colorKey: "green",
    role: Role.child,
    lifecycle: "archived",
    createdAt: 0,
    updatedAt: 0,
  },
];
function event(id: string, start: string, end?: string, extra: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    title: id,
    occurrenceStart: start,
    occurrenceEnd: end,
    allDay: false,
    source: "local",
    assignedTo: [],
    ...extra,
  };
}
const events = [
  event("Later", "2026-09-22T14:00:00Z", "2026-09-22T15:00:00Z"),
  event("First tie", "2026-09-22T09:30:00Z", "2026-09-22T11:00:00Z", {
    assignedTo: ["b", "a", "c", "missing"],
  }),
  event("Past", "2026-09-22T08:00:00Z", "2026-09-22T10:00:00Z"),
  event("All day", "2026-09-22", "2026-09-23", { allDay: true, assignedTo: ["a", "b"] }),
  event("Second tie", "2026-09-22T09:30:00Z", "2026-09-22T12:00:00Z"),
  event("Starting now", "2026-09-22T10:00:00Z", "2026-09-22T10:30:00Z", { assignedTo: ["a"] }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("household-day range and projection", () => {
  it.each([
    [
      "Pacific/Kiritimati",
      "2026-12-31T11:30:00Z",
      "2027-01-01",
      "2026-12-31T10:00:00.000Z",
      "2027-01-02T00:00:00.000Z",
    ],
    [
      "America/Los_Angeles",
      "2026-09-22T01:00:00Z",
      "2026-09-21",
      "2026-09-21T00:00:00.000Z",
      "2026-09-22T07:00:00.000Z",
    ],
    [
      "Europe/Madrid",
      "2026-03-29T12:00:00Z",
      "2026-03-29",
      "2026-03-28T23:00:00.000Z",
      "2026-03-30T00:00:00.000Z",
    ],
    [
      "America/New_York",
      "2026-11-01T12:00:00Z",
      "2026-11-01",
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    ],
  ])("covers timed and date-only anchors in %s at %s", (timezone, instant, date, from, to) => {
    expect(householdDayRange(timezone, Date.parse(instant))).toEqual({ date, from, to });
  });

  it("keeps read order for ties, all-day first, and emphasizes every current interval", () => {
    const input = structuredClone(events);
    const result = presentAgenda(input, members, "UTC", NOW);
    expect(result.map(({ event, temporalState }) => [event.title, temporalState])).toEqual([
      ["All day", "future"],
      ["Past", "past"],
      ["First tie", "in-progress"],
      ["Second tie", "in-progress"],
      ["Starting now", "in-progress"],
      ["Later", "future"],
    ]);
    expect(input).toEqual(events);
  });

  it("selects only the first future tie when none is in progress; all-day cannot steal next", () => {
    expect(
      presentAgenda(events, members, "UTC", Date.parse("2026-09-22T07:00:00Z")).map(
        ({ event, temporalState }) => [event.title, temporalState]
      )
    ).toEqual([
      ["All day", "future"],
      ["Past", "next"],
      ["First tie", "future"],
      ["Second tie", "future"],
      ["Starting now", "future"],
      ["Later", "future"],
    ]);
    const ties = presentAgenda(
      events.filter((item) => item.id !== "Past"),
      members,
      "UTC",
      Date.parse("2026-09-22T09:00:00Z")
    );
    expect(
      ties.filter((item) => item.temporalState === "next").map((item) => item.event.id)
    ).toEqual(["First tie"]);
    expect(
      presentAgenda(events, members, "UTC", Date.parse("2026-09-22T20:00:00Z")).filter(
        (item) => item.temporalState === "next"
      )
    ).toEqual([]);
  });

  it("retains assignment order and readable archived/missing references without active identity", () => {
    const item = presentAgenda([events[1]], members, "UTC", NOW)[0];
    expect(item.activeAssignees).toEqual([
      { memberId: "b", label: "Blair", colorKey: "rose" },
      { memberId: "a", label: "Alex", colorKey: "blue" },
    ]);
    expect(item.fallbackAssigneeLabels).toEqual(["Casey", "missing"]);
  });

  it("filters padded reads using literal all-day dates and half-open household timed boundaries", () => {
    const input = [
      event("Yesterday all day", "2026-09-21", undefined, { allDay: true }),
      event("Today all day", "2026-09-22", undefined, { allDay: true }),
      event("Tomorrow all day", "2026-09-23", undefined, { allDay: true }),
      event("Before day", "2026-09-22T06:59:59.999Z"),
      event("Day start", "2026-09-22T07:00:00Z"),
      event("Day end", "2026-09-23T06:59:59.999Z"),
      event("Next day", "2026-09-23T07:00:00Z"),
    ];
    expect(
      presentAgenda(input, [], "America/Los_Angeles", NOW).map((item) => item.event.id)
    ).toEqual(["Today all day", "Day start", "Day end"]);
  });

  it("does not invent a duration for a timed occurrence with no end", () => {
    expect(
      presentAgenda([event("Point", "2026-09-22T10:00:00Z")], [], "UTC", NOW)[0].temporalState
    ).toBe("past");
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function backend(
  options: {
    language?: string;
    timezone?: string;
    calendar?: () => Promise<Response>;
    profiles?: () => Promise<Response>;
    settings?: () => Promise<Response>;
  } = {}
) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/settings")
        return (
          options.settings?.() ??
          json({
            locale: {
              timezone: options.timezone ?? "Europe/Madrid",
              language: options.language ?? "en",
              weekStartDay: 1,
            },
            weather: { lat: null, lon: null, label: null },
          })
        );
      if (url === "/api/members?lifecycle=all") return options.profiles?.() ?? json(members);
      if (url.startsWith("/api/calendar/events?")) return options.calendar?.() ?? json(events);
      throw new Error(`Unexpected request: ${url}`);
    })
  );
  return requests;
}
function mount() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <TodayAgenda />
        <button>Independent sibling</button>
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}
function row(title: string): HTMLElement {
  const element = screen.getByRole("heading", { name: title, level: 3 }).closest("li");
  if (!element) throw new Error(`Missing agenda row: ${title}`);
  return element;
}

describe("TodayAgenda", () => {
  it("uses the response-time clock after a slow load crosses an event end", async () => {
    let resolve!: (response: Response) => void;
    backend({
      calendar: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    vi.setSystemTime("2026-09-22T13:00:00Z");
    await act(async () => {
      resolve(json(events));
    });
    expect(within(row("First tie")).getByText("Past")).toBeVisible();
    expect(within(row("Later")).getByText("Next")).toBeVisible();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
  });

  it("does not substitute the device timezone when settings lack a household timezone", async () => {
    let settingsAttempts = 0;
    const requests = backend({
      settings: async () => {
        settingsAttempts += 1;
        return settingsAttempts === 1
          ? json({ locale: { language: "en" } })
          : json({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } });
      },
    });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Today's agenda could not be loaded."
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry agenda" }));
    expect(await screen.findByText("First tie")).toBeVisible();
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(2);
  });

  it("retries settings when an invalid household timezone is corrected", async () => {
    let settingsAttempts = 0;
    const requests = backend({
      settings: async () => {
        settingsAttempts += 1;
        return settingsAttempts === 1
          ? json({ locale: { timezone: "Not/A-Real-Timezone", language: "en", weekStartDay: 1 } })
          : json({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } });
      },
    });
    mount();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Today's agenda could not be loaded."
    );
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(1);
    expect(requests.some((url) => url.startsWith("/api/calendar/events?"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retry agenda" }));
    expect(await screen.findByText("First tie")).toBeVisible();
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(2);
  });

  it("waits for the provider-owned settings read before loading the agenda", async () => {
    let resolveSettings!: (response: Response) => void;
    const requests = backend({
      settings: () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    });
    mount();

    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toEqual(["/api/settings"]);

    await act(async () => {
      resolveSettings(
        json({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } })
      );
    });
    expect(await screen.findByText("First tie")).toBeVisible();
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(1);
  });

  it("retries a failed shared settings read once before recovering the agenda", async () => {
    let settingsAttempts = 0;
    const requests = backend({
      settings: async () => {
        settingsAttempts += 1;
        return settingsAttempts === 1
          ? json({ error: "private diagnostic" }, 503)
          : json({ locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 } });
      },
    });
    mount();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Today's agenda could not be loaded."
    );
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry agenda" }));
    expect(await screen.findByText("First tie")).toBeVisible();
    expect(requests.filter((url) => url === "/api/settings")).toHaveLength(2);
  });

  it("updates current/next at event edges without polling the API", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime("2026-09-22T09:29:59Z");
    const requests = backend({
      calendar: async () => json(events.filter((item) => item.id !== "Past")),
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(row("First tie")).getByText("Next")).toBeVisible();
    const reads = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(within(row("First tie")).getByText("In progress")).toBeVisible();
    expect(within(row("Second tie")).getByText("In progress")).toBeVisible();
    expect(requests).toHaveLength(reads);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    });
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
    expect(within(row("Later")).getByText("Next")).toBeVisible();
    expect(requests).toHaveLength(reads);
  });

  it("refetches at household midnight using the next household day", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime("2026-09-22T21:59:59Z");
    const requests = backend({
      calendar: async () => json([event("Tomorrow", "2026-09-23", undefined, { allDay: true })]),
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Nothing scheduled today.")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("heading", { name: "Tomorrow" })).toBeVisible();
    const calendarRequests = requests.filter((url) => url.startsWith("/api/calendar/events?"));
    const last = new URL(calendarRequests.at(-1)!, "http://localhost");
    expect(last.searchParams.get("from")).toBe("2026-09-22T22:00:00.000Z");
    expect(last.searchParams.get("to")).toBe("2026-09-24T00:00:00.000Z");
  });

  it("renders sorted rows, temporal text/weight and all active identities with household times", async () => {
    const requests = backend();
    mount();
    await screen.findByText("First tie");
    const agenda = screen.getByRole("region", { name: "Today's agenda" });
    expect(agenda).toHaveClass("h-full", "rounded-3xl");
    expect(within(agenda).getByRole("link", { name: "Calendar" })).toHaveAttribute(
      "href",
      "/calendar"
    );
    expect(within(agenda).getByText("Tuesday, September 22")).toBeVisible();
    expect(within(agenda).getByRole("list")).toHaveClass("overflow-y-auto");
    expect(
      screen.getAllByRole("listitem").map((item) => item.querySelector("h3")?.textContent)
    ).toEqual(["All day", "Past", "First tie", "Second tie", "Starting now", "Later"]);
    expect(row("First tie")).toHaveClass("border-l-4", "border-l-member-rose-500");
    expect(row("First tie").style.getPropertyValue("--member-event-background")).toContain(
      "repeating-linear-gradient(135deg"
    );
    expect(row("First tie")).toHaveClass("member-event-surface");
    expect(row("First tie").style.getPropertyValue("--member-event-background")).toContain(
      "--color-member-rose-500"
    );
    expect(row("First tie").style.getPropertyValue("--member-event-background")).toContain(
      "--color-member-blue-500"
    );
    expect(within(row("First tie")).getByTestId("agenda-time")).toHaveClass("font-mono");
    expect(within(row("First tie")).getByText("11:30")).toBeVisible();
    for (const title of ["First tie", "Second tie", "Starting now"]) {
      expect(within(row(title)).getByText("In progress")).toBeVisible();
      expect(row(title)).toHaveClass("font-semibold");
    }
    expect(within(row("Past")).getAllByText("Past")).toHaveLength(2);
    expect(row("Past")).toHaveClass("text-muted-foreground");
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
    expect(within(row("First tie")).getByText("Blair")).toHaveClass("bg-member-rose-500");
    expect(within(row("First tie")).getByText("Alex")).toHaveClass("bg-member-blue-500");
    expect(within(row("First tie")).getByText("Casey")).not.toHaveClass("bg-member-green-500");
    expect(within(row("First tie")).getByText("missing")).toBeVisible();
    expect(within(row("All day")).getByText("Alex")).toHaveClass("bg-member-blue-500");
    expect(within(row("All day")).getByText("Blair")).toHaveClass("bg-member-rose-500");
    expect(within(row("Starting now")).getByText("Alex")).toHaveClass("bg-member-blue-500");
    const url = new URL(
      requests.find((url) => url.startsWith("/api/calendar/events?"))!,
      "http://localhost"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: "all",
      from: "2026-09-21T22:00:00.000Z",
      to: "2026-09-23T00:00:00.000Z",
    });
  });

  it("keeps a pending agenda local and shows an explicit empty state on success", async () => {
    let resolve!: (response: Response) => void;
    backend({
      calendar: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Loading today's agenda…");
    expect(screen.getByRole("button", { name: "Independent sibling" })).toBeEnabled();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      resolve(json([]));
    });
    expect(screen.getByText("Nothing scheduled today.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["calendar", "profiles"] as const)(
    "reports %s failure locally and retries without raw diagnostics",
    async (seam) => {
      let failing = true;
      const response = async () =>
        failing
          ? json({ error: "private diagnostic" }, 500)
          : json(
              seam === "calendar"
                ? events
                : seam === "profiles"
                  ? members
                  : { locale: { timezone: "UTC", language: "en" } }
            );
      const requests = backend({ [seam]: response });
      mount();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Today's agenda could not be loaded."
      );
      expect(screen.queryByText("Nothing scheduled today.")).not.toBeInTheDocument();
      expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Independent sibling" })).toBeEnabled();
      failing = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry agenda" }));
      expect(await screen.findByText("First tie")).toBeVisible();
      expect(requests.filter((url) => url === "/api/settings")).toHaveLength(1);
    }
  );

  it("renders Spanish structural copy and next-only fallback", async () => {
    vi.setSystemTime("2026-09-22T07:00:00Z");
    backend({ language: "es" });
    mount();
    await screen.findByText("First tie");
    expect(await screen.findByRole("region", { name: "Agenda de hoy" })).toBeVisible();
    expect(within(row("All day")).getByText("Todo el día")).toBeVisible();
    expect(within(row("Past")).getByText("A continuación")).toBeVisible();
    expect(row("Past")).toHaveClass("font-semibold");
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
  });
});
