import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MealsBoard } from "@/meals/MealsBoard";
import { MealPlanGrid } from "@/meals/MealPlanGrid";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import type { MenuItem, Slot } from "../../src/shared";

function week(): Record<string, Record<Slot, MenuItem[]>> {
  return Object.fromEntries(
    [
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ].map((date) => [
      date,
      {
        breakfast: [],
        lunch: [],
        snack: [],
        dinner:
          date === "2026-09-25"
            ? [
                {
                  entryId: "recurring-1",
                  slot: "dinner",
                  label: "Pizza",
                  isTombstone: false,
                  source: "recurring",
                  planId: "plan-1",
                  recipeId: "recipe-1",
                  note: null,
                },
                {
                  entryId: "oneoff-1",
                  slot: "dinner",
                  label: "Pizza",
                  isTombstone: false,
                  source: "oneoff",
                  planId: null,
                  recipeId: null,
                  note: "Pizza",
                },
              ]
            : [],
      },
    ])
  );
}

function emptyWeek(): Record<string, Record<Slot, MenuItem[]>> {
  return Object.fromEntries(
    [
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ].map((date) => [date, { breakfast: [], lunch: [], snack: [], dinner: [] }])
  );
}

describe("MealsBoard weekly planner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("searches recipes from the weekly board and displays matching results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings")
          return Promise.resolve(
            Response.json({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
          );
        if (url.pathname === "/api/menu/week") return Promise.resolve(Response.json(emptyWeek()));
        if (url.pathname === "/api/recipes")
          return Promise.resolve(
            Response.json(
              url.searchParams.get("search") === "ham"
                ? [
                    {
                      id: "recipe-search",
                      name: "Steamed Hams",
                      ingredients: ["patties"],
                      instructions: "Grill.",
                      slots: ["dinner"],
                      createdAt: 0,
                      updatedAt: 0,
                    },
                  ]
                : []
            )
          );
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    await screen.findByTestId("meal-plan-grid");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ham" } });
    expect(await screen.findByRole("heading", { name: "Steamed Hams" })).toBeVisible();
  });

  it("renders seven dates, fixed slot rows, duplicate labels, and an add affordance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            new Response(
              JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
            )
          );
        if (url.includes("/api/recipes")) return Promise.resolve(new Response(JSON.stringify([])));
        if (url.includes("/api/menu/week"))
          return Promise.resolve(new Response(JSON.stringify(week())));
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    const grid = await screen.findByTestId("meal-plan-grid");
    expect(
      within(screen.getByTestId("meal-cell-2026-09-25-dinner")).getAllByTestId("meal-entry-card")
    ).toHaveLength(2);
    expect(
      within(screen.getByTestId("meal-cell-2026-09-25-dinner")).getAllByText("Pizza")
    ).toHaveLength(2);
    expect(screen.getAllByTestId(/meal-day-heading-/)).toHaveLength(7);
    expect(
      within(grid).getByRole("button", { name: "Add dinner on Friday, September 25" })
    ).toBeVisible();
    expect(
      [...grid.querySelectorAll("[data-slot-row]")].map((row) => row.getAttribute("data-slot-row"))
    ).toEqual(["breakfast", "lunch", "snack", "dinner"]);
  });

  it("uses the week range as the main title with compact navigation and v1 day headings", () => {
    render(
      <LanguageProvider>
        <MealPlanGrid
          weekDates={Object.keys(week())}
          weekMenu={week()}
          todayDate="2026-09-25"
          pending={false}
          onPrevious={vi.fn()}
          onCurrent={vi.fn()}
          onNext={vi.fn()}
          onAdd={vi.fn()}
          onSelect={vi.fn()}
        />
      </LanguageProvider>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Sep 21 – Sep 27" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous week" })).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Next week" })).toHaveTextContent("");
    expect(screen.getByText("Slot")).toBeVisible();
    expect(screen.getByTestId("meal-day-heading-2026-09-25")).toHaveTextContent("FRI25");
    expect(screen.getByTestId("meal-day-heading-2026-09-25")).toHaveClass("bg-accent/20");
  });

  it("renders the week range as an h3 below a page heading when asked", () => {
    render(
      <LanguageProvider>
        <MealPlanGrid
          titleAs="h3"
          weekDates={Object.keys(week())}
          weekMenu={week()}
          todayDate="2026-09-25"
          pending={false}
          onPrevious={vi.fn()}
          onCurrent={vi.fn()}
          onNext={vi.fn()}
          onAdd={vi.fn()}
          onSelect={vi.fn()}
        />
      </LanguageProvider>
    );

    expect(screen.getByRole("heading", { level: 3, name: "Sep 21 – Sep 27" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("fills the available height with the rounded meal-plan shell", () => {
    render(
      <LanguageProvider>
        <MealPlanGrid
          weekDates={Object.keys(emptyWeek())}
          weekMenu={emptyWeek()}
          todayDate={null}
          pending={false}
          onPrevious={vi.fn()}
          onCurrent={vi.fn()}
          onNext={vi.fn()}
          onAdd={vi.fn()}
          onSelect={vi.fn()}
        />
      </LanguageProvider>
    );

    expect(screen.getByRole("region", { name: "Week Menu" })).toHaveClass(
      "flex",
      "h-full",
      "flex-col"
    );
    expect(screen.getByTestId("meal-plan-grid")).toHaveClass("flex-1");
  });

  it("makes the empty cell the add control and reveals its plus only on hover or focus", () => {
    render(
      <LanguageProvider>
        <MealPlanGrid
          weekDates={Object.keys(emptyWeek())}
          weekMenu={emptyWeek()}
          todayDate="2026-09-25"
          pending={false}
          onPrevious={vi.fn()}
          onCurrent={vi.fn()}
          onNext={vi.fn()}
          onAdd={vi.fn()}
          onSelect={vi.fn()}
        />
      </LanguageProvider>
    );

    const cell = screen.getByTestId("meal-cell-2026-09-25-breakfast");
    expect(cell.tagName).toBe("BUTTON");
    expect(cell).toHaveAccessibleName("Add breakfast on Friday, September 25");
    expect(cell).toHaveClass("bg-accent/10");
    expect(within(cell).getByTestId("meal-cell-add-icon")).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "group-focus-visible:opacity-100"
    );
  });

  it("keeps multiple meals as separate warm cards in stable order", () => {
    render(
      <LanguageProvider>
        <MealPlanGrid
          weekDates={Object.keys(week())}
          weekMenu={week()}
          todayDate={null}
          pending={false}
          onPrevious={vi.fn()}
          onCurrent={vi.fn()}
          onNext={vi.fn()}
          onAdd={vi.fn()}
          onSelect={vi.fn()}
        />
      </LanguageProvider>
    );

    const cards = within(screen.getByTestId("meal-cell-2026-09-25-dinner")).getAllByTestId(
      "meal-entry-card"
    );
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.getAttribute("data-entry-id"))).toEqual([
      "recurring-1",
      "oneoff-1",
    ]);
    // Without origin data a recurring chip falls back to the unknown tone, a one-off to grey.
    expect(cards[0]).toHaveClass("meal-origin-chip", "meal-origin-unknown");
    expect(cards[0]).toHaveAttribute("data-emphasis", "normal");
    expect(cards[1]).toHaveClass("meal-origin-chip", "meal-origin-oneoff");
    expect(cards[0]).not.toHaveClass("bg-accent/20");
  });

  it("tints chips by origin, italicises free text and highlights selected origins without hiding others", () => {
    const onSelectedChange = vi.fn();
    const onSelect = vi.fn();
    const tones = new Map([["plan-1", "plan-1" as const]]);
    const grid = (selected: string[]) => (
      <LanguageProvider>
        <MealPlanGrid
          weekDates={Object.keys(week())}
          weekMenu={week()}
          todayDate={null}
          pending={false}
          onPrevious={vi.fn()}
          onCurrent={vi.fn()}
          onNext={vi.fn()}
          onAdd={vi.fn()}
          onSelect={onSelect}
          origin={{
            pills: [
              { id: "oneoff", label: "One-off", tone: "oneoff" },
              { id: "plan-1", label: "Weeknights", tone: "plan-1" },
            ],
            tones,
            selected,
            onSelectedChange,
          }}
        />
      </LanguageProvider>
    );
    const { rerender } = render(grid([]));
    const group = screen.getByRole("group", { name: "Show where meals come from" });
    expect(
      within(group)
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("data-testid"))
    ).toEqual(["meal-origin-pill-oneoff", "meal-origin-pill-plan-1"]);
    const [recurring, oneOff] = within(
      screen.getByTestId("meal-cell-2026-09-25-dinner")
    ).getAllByTestId("meal-entry-card");
    expect(recurring).toHaveClass("meal-origin-chip", "meal-origin-plan-1");
    expect(recurring).toHaveAttribute("data-origin", "plan-1");
    expect(recurring).toHaveAttribute("title", "Weeknights");
    expect(oneOff).toHaveAttribute("title", "One-off");
    expect(oneOff).toHaveAttribute("data-origin", "oneoff");
    // Free text (the one-off note) is italic; a recipe chip is not.
    expect(oneOff.querySelector("span.italic")).toHaveTextContent("Pizza");
    expect(recurring.querySelector("span.italic")).toBeNull();

    fireEvent.click(within(group).getByRole("checkbox", { name: "Weeknights" }));
    expect(onSelectedChange).toHaveBeenCalledWith(["plan-1"]);

    rerender(grid(["plan-1"]));
    expect(recurring).toHaveAttribute("data-emphasis", "hit");
    expect(oneOff).toHaveAttribute("data-emphasis", "dim");
    expect(within(group).getByRole("checkbox", { name: "Weeknights" })).toBeChecked();
    fireEvent.click(oneOff);
    expect(onSelect).toHaveBeenCalled();
  });

  it("shows a visible retry after an initial week failure and recovers the interactive grid", async () => {
    let weekAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            new Response(
              JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
            )
          );
        if (url.includes("/api/recipes")) return Promise.resolve(new Response(JSON.stringify([])));
        if (url.includes("/api/menu/week")) {
          weekAttempts += 1;
          return Promise.resolve(
            weekAttempts === 1
              ? new Response(null, { status: 500 })
              : new Response(JSON.stringify(week()))
          );
        }
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(await screen.findByTestId("meal-plan-grid")).toBeVisible();
    expect(weekAttempts).toBe(2);
  });

  it("keeps a recipe failure local to the catalogue and retries it", async () => {
    let recipeAttempts = 0;
    let allowRecipeRead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            new Response(
              JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
            )
          );
        if (url.includes("/api/recipes")) {
          recipeAttempts += 1;
          return Promise.resolve(
            allowRecipeRead ? new Response(JSON.stringify([])) : new Response(null, { status: 500 })
          );
        }
        if (url.includes("/api/menu/week"))
          return Promise.resolve(new Response(JSON.stringify(week())));
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    const catalogue = await screen.findByTestId("recipe-catalogue");
    expect(await within(catalogue).findByText("Failed to load recipes.")).toBeVisible();
    const attemptsBeforeRetry = recipeAttempts;
    allowRecipeRead = true;
    fireEvent.click(within(catalogue).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(recipeAttempts).toBeGreaterThan(attemptsBeforeRetry));
  });

  it("localizes workspace chrome and date labels while retaining authored content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            new Response(
              JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "es" } })
            )
          );
        if (url.includes("/api/recipes")) return Promise.resolve(new Response(JSON.stringify([])));
        if (url.includes("/api/menu/week"))
          return Promise.resolve(new Response(JSON.stringify(week())));
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "21 sept – 27 sept" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Semana anterior" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Añadir cena el viernes, 25 de septiembre/ })
    ).toBeVisible();
    expect(screen.getAllByText("Pizza")).toHaveLength(2);
  });

  it("uses the household date rather than the device date for the initial week request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T23:30:00.000Z"));
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/settings"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              locale: { timezone: "Pacific/Kiritimati", weekStartDay: 1, language: "en" },
            })
          )
        );
      if (url.includes("/api/recipes")) return Promise.resolve(new Response(JSON.stringify([])));
      if (url.includes("/api/menu/week"))
        return Promise.resolve(new Response(JSON.stringify(week())));
      if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("meal-plan-grid")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/menu/week?date=2026-09-26",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("renders a tombstone as non-editable instead of exposing its deleted recipe", async () => {
    const tombstoneWeek = week();
    tombstoneWeek["2026-09-25"].dinner = [
      {
        entryId: "deleted-1",
        slot: "dinner",
        label: "Removed pizza",
        isTombstone: true,
        source: "oneoff",
        planId: null,
        recipeId: "deleted-recipe",
        note: null,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            new Response(
              JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
            )
          );
        if (url.includes("/api/recipes")) return Promise.resolve(new Response(JSON.stringify([])));
        if (url.includes("/api/menu/week"))
          return Promise.resolve(new Response(JSON.stringify(tombstoneWeek)));
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Deleted recipe" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Deleted recipe");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Recipe" })).not.toBeInTheDocument();
  });

  it("keeps every slot interactive when a valid week contains no entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            new Response(
              JSON.stringify({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
            )
          );
        if (url.includes("/api/recipes")) return Promise.resolve(new Response(JSON.stringify([])));
        if (url.includes("/api/menu/week"))
          return Promise.resolve(new Response(JSON.stringify(emptyWeek())));
        if (String(url).includes("/api/meal-plans")) return Promise.resolve(Response.json([]));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    const grid = await screen.findByTestId("meal-plan-grid");
    expect(within(grid).queryAllByTestId("meal-entry-card")).toHaveLength(0);
    expect(within(grid).getAllByRole("button", { name: /^Add / })).toHaveLength(28);
    fireEvent.click(screen.getByTestId("meal-cell-2026-09-21-breakfast"));
    fireEvent.click(screen.getByRole("radio", { name: "Free text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Free text" }), {
      target: { value: "Porridge" },
    });
    expect(screen.getByRole("button", { name: "Add Entry" })).toBeEnabled();
  });

  it("highlights the selected origin on the family board, keeps it across weeks and still opens dimmed meals", async () => {
    const plans = [{ id: "p1", name: "School lunches", active: true, createdAt: 1, updatedAt: 1 }];
    const originWeek = () => {
      const next = emptyWeek();
      next["2026-09-25"].dinner = [
        {
          entryId: "recurring-p1",
          slot: "dinner",
          label: "Sandwich",
          isTombstone: false,
          source: "recurring",
          planId: "p1",
          recipeId: null,
          note: "Sandwich",
        },
        {
          entryId: "oneoff-1",
          slot: "dinner",
          label: "Pizza",
          isTombstone: false,
          source: "oneoff",
          planId: null,
          recipeId: null,
          note: "Pizza",
        },
      ];
      return next;
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            Response.json({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
          );
        if (url.includes("/api/recipes")) return Promise.resolve(Response.json([]));
        if (url.includes("/api/meal-plans")) return Promise.resolve(Response.json(plans));
        if (url.includes("/api/menu/week")) return Promise.resolve(Response.json(originWeek()));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    const school = await screen.findByRole("checkbox", { name: "School lunches" });
    expect(screen.getByRole("checkbox", { name: "One-off" })).not.toBeChecked();
    const chips = () =>
      within(screen.getByTestId("meal-cell-2026-09-25-dinner")).getAllByTestId("meal-entry-card");
    expect(chips()[0]).toHaveClass("meal-origin-plan-1");

    fireEvent.click(school);
    expect(chips()[0]).toHaveAttribute("data-emphasis", "hit");
    expect(chips()[1]).toHaveAttribute("data-emphasis", "dim");

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "School lunches" })).toBeChecked()
    );
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await screen.findByTestId("meal-cell-2026-09-25-dinner");
    expect(screen.getByRole("checkbox", { name: "School lunches" })).toBeChecked();

    fireEvent.click(chips()[1]);
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("radio", { name: /^Every / })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The family add dialog stays one-off only, even with exactly one plan pill selected.
    fireEvent.click(screen.getByTestId("meal-cell-2026-09-25-lunch"));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("radio", { name: /^Every / })).toBeNull();
  });

  it("shows a retry when the meal plans fail to load and recovers", async () => {
    let plansFail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/settings"))
          return Promise.resolve(
            Response.json({ locale: { timezone: "UTC", weekStartDay: 1, language: "en" } })
          );
        if (url.includes("/api/recipes")) return Promise.resolve(Response.json([]));
        if (url.includes("/api/meal-plans"))
          return Promise.resolve(
            plansFail ? new Response(null, { status: 500 }) : Response.json([])
          );
        if (url.includes("/api/menu/week")) return Promise.resolve(Response.json(week()));
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <MealsBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    expect(await screen.findByText("Failed to load meal plans.")).toBeVisible();
    await screen.findByTestId("meal-plan-grid");
    // The grid still renders: pills offer only One-off and recurring chips use the unknown tone.
    expect(
      within(screen.getByRole("group", { name: "Show where meals come from" })).getAllByRole(
        "checkbox"
      )
    ).toHaveLength(1);
    expect(
      within(screen.getByTestId("meal-cell-2026-09-25-dinner")).getAllByTestId("meal-entry-card")[0]
    ).toHaveClass("meal-origin-unknown");
    plansFail = false;
    fireEvent.click(screen.getByTestId("meals-board-plans-retry"));
    await waitFor(() => expect(screen.queryByText("Failed to load meal plans.")).toBeNull());
    expect(screen.queryByTestId("meals-board-plans-retry")).toBeNull();
  });
});
