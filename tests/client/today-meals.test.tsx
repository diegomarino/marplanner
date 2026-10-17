import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { TodayMeals } from "@/home/TodayMeals";
import { LanguageProvider } from "@/i18n";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

function menuItem(entryId: string, label: string, isTombstone = false) {
  return {
    entryId,
    slot: "dinner" as const,
    label,
    isTombstone,
    source: "oneoff" as const,
  };
}

function mockTodayMealsBackend(menu: () => Response | Promise<Response>) {
  const fetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/settings")) {
      return Promise.resolve(
        new Response(JSON.stringify({ locale: { timezone: "UTC", language: "en" } }))
      );
    }
    if (url.startsWith("/api/menu?date=")) return menu();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderTodayMeals() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <TodayMeals />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

it("renders exactly one tile per meal slot in chronological order", async () => {
  mockTodayMealsBackend(
    () =>
      new Response(
        JSON.stringify([
          menuItem("dinner-first", "Pasta"),
          {
            ...menuItem("breakfast-second", "Toast"),
            slot: "breakfast" as const,
            source: "recurring",
          },
          { ...menuItem("dinner-third", "Pasta"), source: "recurring" },
        ])
      )
  );
  renderTodayMeals();

  const strip = await screen.findByTestId("today-meals-strip");
  await within(strip).findByText("Toast");
  expect(
    within(strip)
      .getAllByTestId("today-meals-slot")
      .map((item) => item.getAttribute("data-slot"))
  ).toEqual(["breakfast", "lunch", "snack", "dinner"]);
});

it("groups multiple meals in one slot into one slash-separated card", async () => {
  mockTodayMealsBackend(
    () =>
      new Response(
        JSON.stringify([
          { ...menuItem("dinner-first", "Pasta"), slot: "dinner" as const },
          { ...menuItem("breakfast-second", "Toast"), slot: "breakfast" as const },
          { ...menuItem("dinner-third", "Salad"), slot: "dinner" as const },
        ])
      )
  );
  renderTodayMeals();

  const strip = await screen.findByTestId("today-meals-strip");
  await within(strip).findAllByTestId("today-meals-item");
  expect(
    within(strip)
      .getAllByTestId("today-meals-item")
      .map((item) => item.textContent)
  ).toEqual(["Toast", "Pasta / Salad"]);
  expect(within(strip).getAllByTestId("today-meals-tile")).toHaveLength(2);
  expect(within(strip).getAllByTestId("today-meals-slot-icon-dinner")).toHaveLength(1);
  expect(within(strip).getByTestId("today-meals-slot-icon-breakfast")).toHaveAttribute(
    "aria-hidden",
    "true"
  );
});

it("renders subtle placeholders only for missing slots without creating meal item nodes", async () => {
  mockTodayMealsBackend(
    () => new Response(JSON.stringify([{ ...menuItem("lunch", "Soup"), slot: "lunch" as const }]))
  );
  renderTodayMeals();

  const strip = await screen.findByTestId("today-meals-strip");
  await within(strip).findByText("Soup");
  expect(within(strip).getAllByTestId("today-meals-item")).toHaveLength(1);
  expect(within(strip).getAllByTestId("today-meals-empty-slot")).toHaveLength(3);
  expect(
    within(strip)
      .getAllByTestId("today-meals-empty-slot")
      .find((slot) => slot.getAttribute("data-slot") === "breakfast")
  ).toHaveTextContent("Breakfast");
});

it("keeps four slot placeholders visible while the menu is loading", async () => {
  let resolveMenu: (response: Response) => void = () => undefined;
  mockTodayMealsBackend(
    () =>
      new Promise<Response>((resolve) => {
        resolveMenu = resolve;
      })
  );
  renderTodayMeals();

  const strip = await screen.findByTestId("today-meals-strip");
  expect(within(strip).getByRole("status")).toHaveTextContent("Loading today's meals…");
  expect(within(strip).getAllByTestId("today-meals-empty-slot")).toHaveLength(4);
  resolveMenu(new Response(JSON.stringify([])));
});

it("keeps the strip read-only while providing the full meals destination", async () => {
  mockTodayMealsBackend(() => new Response(JSON.stringify([menuItem("e1", "Pasta")])));
  const { container } = renderTodayMeals();

  const link = await screen.findByRole("link", { name: "Today's meals — open Meals" });
  expect(link.getAttribute("href")).toBe("/meals");
  expect(screen.queryByRole("heading")).toBeNull();
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(link.querySelectorAll("a, button, input, select, textarea")).toHaveLength(0);
});

it("renders a clear empty state without removing the meals destination", async () => {
  mockTodayMealsBackend(() => new Response(JSON.stringify([])));
  renderTodayMeals();

  expect(await screen.findByText("No meals planned for today.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Today's meals — open Meals" })).toHaveAttribute(
    "href",
    "/meals"
  );
});

it("announces a failed household-current-day request", async () => {
  mockTodayMealsBackend(() => new Response(null, { status: 500 }));
  renderTodayMeals();

  expect(await screen.findByRole("alert")).toHaveTextContent("Today's meals could not be loaded.");
});

it("clears an initial load error when the next interval successfully loads meals", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  const responses = [
    new Response(null, { status: 500 }),
    new Response(JSON.stringify([menuItem("recovered", "Recovered")])),
  ];
  mockTodayMealsBackend(() => Promise.resolve(responses.shift()!));
  renderTodayMeals();

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Today's meals could not be loaded.");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });

  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Recovered");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("refetches today's meals after a successful workspace mutation event", async () => {
  const addEventListener = vi.spyOn(window, "addEventListener");
  let resolveRefresh!: (response: Response) => void;
  const refreshed = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  let requests = 0;
  mockTodayMealsBackend(() => {
    requests += 1;
    return requests === 1
      ? Promise.resolve(new Response(JSON.stringify([menuItem("old", "Old")])))
      : refreshed;
  });
  renderTodayMeals();
  expect(await screen.findByTestId("today-meals-item")).toHaveTextContent("Old");
  // Visible items precede the date commit that installs the mutation-event subscription.
  await waitFor(() =>
    expect(addEventListener).toHaveBeenCalledWith("marplanner:meals-changed", expect.any(Function))
  );
  await act(async () => {
    window.dispatchEvent(new Event("marplanner:meals-changed"));
  });
  await waitFor(() => expect(requests).toBe(2));
  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Old");
  await act(async () => {
    resolveRefresh(new Response(JSON.stringify([menuItem("new", "New")])));
  });
  await waitFor(() => expect(screen.getByTestId("today-meals-item")).toHaveTextContent("New"));
});

it("ignores a delayed stale failure after a newer menu response succeeds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  let resolveStale: (response: Response) => void = () => undefined;
  let menuCalls = 0;
  mockTodayMealsBackend(() => {
    menuCalls += 1;
    if (menuCalls === 1) {
      return new Promise<Response>((resolve) => {
        resolveStale = resolve;
      });
    }
    return Promise.resolve(new Response(JSON.stringify([menuItem("fresh", "Fresh")])));
  });
  renderTodayMeals();

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(menuCalls).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(menuCalls).toBe(2);
  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Fresh");

  await act(async () => {
    resolveStale(new Response(null, { status: 500 }));
  });

  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Fresh");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows localized loading until a deferred menu response replaces it", async () => {
  let resolveMenu: (response: Response) => void = () => undefined;
  const fetch = mockTodayMealsBackend(
    () =>
      new Promise<Response>((resolve) => {
        resolveMenu = resolve;
      })
  );
  renderTodayMeals();

  expect(await screen.findByRole("status")).toHaveTextContent("Loading today's meals…");
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([input]) => String(input).startsWith("/api/menu?date="))
    ).toHaveLength(1)
  );

  await act(async () => {
    resolveMenu(new Response(JSON.stringify([menuItem("e1", "Pasta")])));
  });

  expect(await screen.findByTestId("today-meals-item")).toHaveTextContent("Pasta");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("uses the household current day and refreshes after household midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T23:59:30.000Z"));
  const fetch = mockTodayMealsBackend(() => new Response(JSON.stringify([])));
  renderTodayMeals();

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText("No meals planned for today.")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });

  const menuRequests = fetch.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.startsWith("/api/menu?date="));
  expect(menuRequests).toEqual(["/api/menu?date=2026-01-01", "/api/menu?date=2026-01-02"]);
});

it("retries a failed new-day menu fetch on the following interval", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T23:59:30.000Z"));
  const responses = [
    new Response(JSON.stringify([menuItem("yesterday", "Yesterday")])),
    new Response(null, { status: 500 }),
    new Response(JSON.stringify([menuItem("today", "Today")])),
  ];
  const fetch = mockTodayMealsBackend(() => Promise.resolve(responses.shift()!));
  renderTodayMeals();

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Yesterday");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Yesterday");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.getByTestId("today-meals-item")).toHaveTextContent("Today");

  const menuRequests = fetch.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.startsWith("/api/menu?date="));
  expect(menuRequests).toEqual([
    "/api/menu?date=2026-01-01",
    "/api/menu?date=2026-01-02",
    "/api/menu?date=2026-01-02",
  ]);
});

it("preserves duplicate labels and tombstones while grouping their shared slot", async () => {
  mockTodayMealsBackend(
    () =>
      new Response(
        JSON.stringify([
          menuItem("e1", "Pasta"),
          menuItem("e2", "ignored deleted label", true),
          menuItem("e3", "Pasta"),
        ])
      )
  );
  renderTodayMeals();

  const labels = await screen.findAllByTestId("today-meals-item");
  expect(labels.map((item) => item.textContent)).toEqual(["Pasta / Deleted recipe / Pasta"]);
});
