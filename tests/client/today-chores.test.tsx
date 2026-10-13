import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodayChores } from "@/home/TodayChores";
import { LanguageProvider } from "@/i18n";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import type { BoardChore } from "../../src/shared";

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

const PERIODS = [
  { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
  { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
  { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
];

function column(
  memberId: string,
  displayName: string,
  chores: Array<Omit<BoardChore, "icon"> & { icon?: string | null }> = [],
  streak: number | null = null,
  todayProgress: { completed: number; total: number } | null = null
) {
  return {
    memberId,
    displayName,
    streak,
    todayProgress,
    dayPeriods: [
      {
        id: "morning",
        labelKey: "dayPeriod.morning",
        chores: chores.map((chore) => ({ icon: null, ...chore })),
      },
      { id: "afternoon", labelKey: "dayPeriod.afternoon", chores: [] },
      { id: "evening", labelKey: "dayPeriod.evening", chores: [] },
      { id: "night", labelKey: "dayPeriod.night", chores: [] },
    ],
  };
}

function renderToday(
  columns: unknown[],
  periods: unknown = PERIODS,
  toggle = () => json(null, 204),
  timezone = "UTC"
) {
  const fetch = vi.fn((input: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = String(input);
    if (url.includes("/api/settings"))
      return Promise.resolve(json({ locale: { timezone, language: "en" } }));
    if (url.startsWith("/api/chores/board")) return Promise.resolve(json(columns));
    if (url.includes("/api/day-periods"))
      return Promise.resolve(periods instanceof Response ? periods : json(periods));
    if (url.includes("/completions")) return Promise.resolve(toggle());
    throw new Error(`unexpected fetch: ${url} (${init?.method ?? "GET"})`);
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <TodayChores />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

describe("TodayChores behavior", () => {
  it("keeps each child's selected period through a server-authoritative refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
    const beaColumn = column("bea", "Bea");
    beaColumn.dayPeriods[1].chores = [
      { id: "bea-brush", name: "Bea brush", icon: null, completed: false },
    ];
    const columns = [column("ari", "Ari"), beaColumn];
    let boardReads = 0;
    const fetch = vi.fn((input: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
      const url = String(input);
      if (url.includes("/api/settings"))
        return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
      if (url.startsWith("/api/chores/board")) return Promise.resolve(json(columns));
      if (url.includes("/api/day-periods")) return Promise.resolve(json(PERIODS));
      if (url.includes("/completions") && init?.method === "POST") {
        boardReads += 1;
        return Promise.resolve(json(null, 204));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <TodayChores />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const ari = screen.getByTestId("today-chores-column-ari");
    const bea = screen.getByTestId("today-chores-column-bea");
    fireEvent.click(within(ari).getByRole("button", { name: "Show next period" }));
    expect(within(ari).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "evening"
    );

    fireEvent.click(within(bea).getByRole("button", { name: "Bea brush" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(boardReads).toBe(1);
    expect(within(ari).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "evening"
    );
    expect(within(bea).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "afternoon"
    );
  });

  it("shows one current period with previous and next jump controls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
    renderToday([column("ari", "Ari")]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const child = screen.getByTestId("today-chores-column-ari");
    expect(child).toHaveTextContent("Afternoon");
    expect(child).not.toHaveTextContent("Morning");
    expect(child).not.toHaveTextContent("Evening");

    fireEvent.click(within(child).getByRole("button", { name: "Show next period" }));
    expect(child).toHaveTextContent("Evening");
    fireEvent.click(within(child).getByRole("button", { name: "Show next period" }));
    expect(child).toHaveTextContent("Night");
    expect(within(child).queryByRole("button", { name: "Show next period" })).toBeNull();
    expect(screen.getByText("No chores in this period.")).toBeInTheDocument();
  });

  it("shows the local board error while the independent day-period request still succeeds", async () => {
    let periodReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/api/settings"))
          return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
        if (url.startsWith("/api/chores/board")) return Promise.resolve(json(null, 500));
        if (url.includes("/api/day-periods")) {
          periodReads += 1;
          return Promise.resolve(json(PERIODS));
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <TodayChores />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Today's chores could not be loaded."
    );
    expect(periodReads).toBe(1);
    expect(screen.queryByTestId("today-chores-column-ari")).not.toBeInTheDocument();
  });

  it("keeps board columns and manual anchors usable when day periods reject", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
    const fetch = renderToday([column("ari", "Ari")], new Response(null, { status: 500 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const child = screen.getByTestId("today-chores-column-ari");
    expect(child).toHaveTextContent("Morning");
    fireEvent.click(within(child).getByRole("button", { name: "Show next period" }));
    fireEvent.click(within(child).getByRole("button", { name: "Show next period" }));
    fireEvent.click(within(child).getByRole("button", { name: "Show next period" }));
    expect(screen.getByText("No chores in this period.")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([input]) => String(input).includes("/api/chores/board"))).toBe(
      true
    );
    expect(fetch.mock.calls.some(([input]) => String(input).includes("/api/day-periods"))).toBe(
      true
    );
  });

  it("renders no-child and failed-period states without losing the usable board response", async () => {
    renderToday([], new Response(null, { status: 500 }) as unknown);
    expect(await screen.findByText("No active children yet.")).toBeInTheDocument();

    cleanup();
    renderToday([column("ari", "Ari")], null);
    expect(await screen.findByTestId("today-chores-column-ari")).toBeInTheDocument();
  });

  it("keeps period navigation independent between child columns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
    renderToday([column("ari", "Ari"), column("bea", "Bea")]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ari = screen.getByTestId("today-chores-column-ari");
    const bea = screen.getByTestId("today-chores-column-bea");

    fireEvent.click(within(ari).getByRole("button", { name: "Show previous period" }));
    expect(within(ari).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "morning"
    );
    expect(within(bea).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "afternoon"
    );
  });

  it("completes directly for the owning child and refreshes from the server", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T06:00:00Z"));
    const first = [column("ari", "Ari", [{ id: "brush", name: "Brush teeth", completed: false }])];
    const refreshed = [
      column("ari", "Ari", [{ id: "brush", name: "Brush teeth", completed: true }]),
    ];
    let boardReads = 0;
    const fetch = vi.fn((input: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
      const url = String(input);
      if (url.includes("/api/settings"))
        return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
      if (url.startsWith("/api/chores/board"))
        return Promise.resolve(json(boardReads++ === 0 ? first : refreshed));
      if (url.includes("/api/day-periods")) return Promise.resolve(json(PERIODS));
      if (url.includes("/completions")) return Promise.resolve(json(null, 204));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <TodayChores />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    screen.getByTestId("today-chores-column-ari");
    fireEvent.click(screen.getByTestId("today-chore-toggle-ari-brush"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const completion = fetch.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/chores/brush/completions" && init?.method === "POST"
    );
    expect(completion).toBeDefined();
    expect(JSON.parse(String(completion?.[1]?.body))).toMatchObject({ memberId: "ari" });
    expect(screen.getByTestId("today-chore-toggle-ari-brush")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("renders each server-eligible chore only in its owning child column and sends that member ID", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
    const ari = column("ari", "Ari");
    const bea = column("bea", "Bea");
    ari.dayPeriods[1].chores = [{ id: "brush", name: "Ari brush", icon: null, completed: false }];
    bea.dayPeriods[1].chores = [{ id: "read", name: "Bea read", icon: null, completed: false }];
    const fetch = renderToday([ari, bea]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const ariColumn = screen.getByTestId("today-chores-column-ari");
    const beaColumn = screen.getByTestId("today-chores-column-bea");
    expect(within(ariColumn).getByText("Ari brush")).toBeInTheDocument();
    expect(within(ariColumn).queryByText("Bea read")).not.toBeInTheDocument();
    expect(within(beaColumn).getByText("Bea read")).toBeInTheDocument();
    expect(within(beaColumn).queryByText("Ari brush")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("today-chore-toggle-ari-brush"));
    fireEvent.click(screen.getByTestId("today-chore-toggle-bea-read"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const completions = fetch.mock.calls.filter(
      ([input, init]) => String(input).includes("/completions") && init?.method === "POST"
    );
    expect(completions).toHaveLength(2);
    expect(JSON.parse(String(completions[0][1]?.body))).toMatchObject({ memberId: "ari" });
    expect(JSON.parse(String(completions[1][1]?.body))).toMatchObject({ memberId: "bea" });
  });

  it("requires confirmation before uncompleting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T06:00:00Z"));
    renderToday([
      column("ari", "Ari", [{ id: "read", name: "Read", icon: "📖", completed: true }]),
    ]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    screen.getByTestId("today-chores-column-ari");
    expect(screen.getByTestId("today-chore-name-ari-read")).toHaveClass(
      "line-through",
      "text-muted-foreground"
    );
    expect(screen.getByTestId("today-chore-icon-ari-read")).toHaveClass("line-through");
    fireEvent.click(screen.getByTestId("today-chore-toggle-ari-read"));

    expect(screen.getByRole("dialog")).toHaveTextContent("Undo this chore?");
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([input, init]) => String(input).includes("/completions") && init?.method === "DELETE"
      )
    ).toHaveLength(0);
    fireEvent.click(screen.getByTestId("today-chores-uncomplete-confirm"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([input, init]) => String(input).includes("/completions") && init?.method === "DELETE"
      )
    ).toHaveLength(1);
  });

  it("selects night before the first configured start using household time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T02:00:00Z"));
    renderToday([column("ari", "Ari")]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const child = screen.getByTestId("today-chores-column-ari");
    expect(within(child).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "night"
    );
  });

  it("selects afternoon during its normal household interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
    renderToday([column("ari", "Ari")]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const child = screen.getByTestId("today-chores-column-ari");
    expect(within(child).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "afternoon"
    );
  });

  it("uses household local time rather than UTC when selecting the initial period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T11:00:00Z"));
    renderToday([column("ari", "Ari")], PERIODS, () => json(null, 204), "Europe/Madrid");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const child = screen.getByTestId("today-chores-column-ari");
    expect(within(child).getByTestId("today-chores-active-period")).toHaveAttribute(
      "data-period-id",
      "afternoon"
    );
  });
});

describe("TodayChores", () => {
  it("builds each child column from the persisted member colour scale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T06:00:00Z"));
    const ari = column(
      "ari",
      "Ari",
      [{ id: "brush", name: "Brush teeth", icon: "🪥", completed: false }],
      4,
      {
        completed: 1,
        total: 3,
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/api/settings"))
          return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
        if (url.startsWith("/api/chores/board")) return Promise.resolve(json([ari]));
        if (url.includes("/api/day-periods")) return Promise.resolve(json(PERIODS));
        if (url.includes("/api/members"))
          return Promise.resolve(json([{ id: "ari", displayName: "Ari", colorKey: "rose" }]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <TodayChores />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const child = screen.getByTestId("today-chores-column-ari");
    expect(screen.getByRole("region", { name: "Today's chores" })).toHaveClass("h-full");
    expect(screen.getByRole("heading", { name: "Today's chores" })).toBeVisible();
    expect(child.style.getPropertyValue("--member-color")).toBe("var(--color-member-rose-500)");
    expect(within(child).getByTestId("today-chores-member-badge")).toHaveClass(
      "bg-member-rose-500",
      "text-member-rose-foreground"
    );
    // The labels are visually hidden behind the flame and check icons, but still read out.
    expect(child).toHaveTextContent("Streak: 4");
    expect(child).toHaveTextContent("Progress: 1/3");
    expect(within(child).getByText("Streak:")).toHaveClass("sr-only");
    expect(within(child).getByText("Progress:")).toHaveClass("sr-only");
    expect(within(child).getByTestId("today-chore-icon-ari-brush")).toHaveAttribute(
      "data-emoji",
      "🪥"
    );
  });

  it("uses member IDs and persisted keys, with neutral fallback for an unknown key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/api/settings"))
          return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
        if (url.startsWith("/api/chores/board"))
          return Promise.resolve(json([column("second", "Ari"), column("first", "Bea")]));
        if (url.includes("/api/day-periods")) return Promise.resolve(json(PERIODS));
        if (url.includes("/api/members"))
          return Promise.resolve(
            json([
              { id: "first", displayName: "Bea", colorKey: "teal" },
              { id: "second", displayName: "Ari", colorKey: "not-a-member-key" },
            ])
          );
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <TodayChores />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    expect(
      (await screen.findByTestId("today-chores-column-first")).style.getPropertyValue(
        "--member-color"
      )
    ).toBe("var(--color-member-teal-500)");
    expect(
      screen.getByTestId("today-chores-column-second").style.getPropertyValue("--member-color")
    ).toBe("var(--color-muted-foreground)");
  });

  it("shows a column for each active child", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/api/settings")) {
          return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
        }
        if (url.startsWith("/api/chores/board")) {
          return Promise.resolve(
            json([
              {
                memberId: "ari",
                displayName: "Ari",
                streak: null,
                todayProgress: null,
                dayPeriods: [
                  { id: "morning", labelKey: "dayPeriod.morning", chores: [] },
                  { id: "afternoon", labelKey: "dayPeriod.afternoon", chores: [] },
                  { id: "evening", labelKey: "dayPeriod.evening", chores: [] },
                  { id: "night", labelKey: "dayPeriod.night", chores: [] },
                ],
              },
              {
                memberId: "bea",
                displayName: "Bea",
                streak: null,
                todayProgress: null,
                dayPeriods: [
                  { id: "morning", labelKey: "dayPeriod.morning", chores: [] },
                  { id: "afternoon", labelKey: "dayPeriod.afternoon", chores: [] },
                  { id: "evening", labelKey: "dayPeriod.evening", chores: [] },
                  { id: "night", labelKey: "dayPeriod.night", chores: [] },
                ],
              },
            ])
          );
        }
        if (url.includes("/api/day-periods")) {
          return Promise.resolve(
            json([
              { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
              { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
              { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
              { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
            ])
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <TodayChores />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    expect(
      (await screen.findByTestId("today-chores-column-ari")).style.getPropertyValue(
        "--member-color"
      )
    ).toBe("var(--color-muted-foreground)");
    expect(screen.getByTestId("today-chores-column-bea")).toBeInTheDocument();
  });
});
