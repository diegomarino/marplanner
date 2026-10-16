import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";
import { addCalendarDays, buildWeekDays } from "@/calendar/calendar-presentation";
import { LanguageProvider } from "@/i18n";
import { weekdayOf } from "../../src/shared/householdTime";

/** Rework — view-staleness regression coverage (updated for the editable admin week grid:
 * every write — from the grid's entry dialog, a plan card's form, or a recipe delete — must
 * show up in the grid AND in the plan cards without a reload).
 * added `refreshMenus` (day + week) but wired it only into the NEW plan/recurring
 * write paths; the PRE-EXISTING one-off entry create left the week grid stale (day-only
 * refresh), and deleting a recipe left BOTH the day and week grid stale (list-only
 * refresh). Separately, `PlanEntriesPanel` caches a plan's entries keyed on `planId` —
 * adding a recurring entry via the top-level authoring form refreshed the derived menus
 * but never told an already-expanded panel for that same plan to refetch, so a newly
 * added recurring entry was invisible for edit/delete until the panel was collapsed and
 * reopened.
 * Each mock endpoint below is a minimal in-memory model of just enough server behavior
 * (including the FK-cascade: deleting a recipe removes entries that reference it) to
 * observe whether the CLIENT re-reads a view after a write that can change it — the
 * assertions are about client-side refresh wiring, not backend derivation correctness.
 */
describe("MealsManagement — view refresh coherence (rework #448)", () => {
  let recipes: Array<{
    id: string;
    name: string;
    ingredients: string[] | null;
    instructions: string | null;
    slots: string[] | null;
    createdAt: number;
    updatedAt: number;
  }>;
  let plans: Array<{
    id: string;
    name: string;
    active: boolean;
    createdAt: number;
    updatedAt: number;
  }>;
  let entries: Array<{
    id: string;
    kind: "oneoff" | "recurring";
    date: string | null;
    weekday: string | null;
    mealPlanId: string | null;
    slot: string;
    recipeId: string | null;
    note: string | null;
    createdAt: number;
  }>;
  let nextEntryId: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  // The household timezone below is UTC, so "today" is the UTC date.
  const today = new Date().toISOString().slice(0, 10);
  const previousWeekAnchor = addCalendarDays(today, -7);
  let delayedWeeks: Map<string, Promise<void>>;
  let delayedPlanWrite: Promise<void> | null;

  function toMenuItem(entry: (typeof entries)[number]) {
    const recipe = entry.recipeId ? recipes.find((r) => r.id === entry.recipeId) : undefined;
    return {
      entryId: entry.id,
      slot: entry.slot,
      label: entry.recipeId ? (recipe?.name ?? "") : (entry.note ?? ""),
      isTombstone: !!entry.recipeId && !recipe,
      source: entry.kind,
    };
  }

  function bySlot(items: ReturnType<typeof toMenuItem>[]) {
    const grouped: Record<string, ReturnType<typeof toMenuItem>[]> = {
      breakfast: [],
      lunch: [],
      snack: [],
      dinner: [],
    };
    for (const item of items) grouped[item.slot].push(item);
    return grouped;
  }

  /** The derived menu for one date: active-plan recurring entries for its weekday, then
   * one-offs for the date (FR-003/FR-017). */
  function dayMenuFor(date: string) {
    const weekday = weekdayOf(date, "UTC");
    const activePlanIds = new Set(plans.filter((plan) => plan.active).map((plan) => plan.id));
    const recurring = entries.filter(
      (e) => e.kind === "recurring" && e.weekday === weekday && activePlanIds.has(e.mealPlanId!)
    );
    const oneoffs = entries.filter((e) => e.kind === "oneoff" && e.date === date);
    return [...recurring, ...oneoffs].map(toMenuItem);
  }

  function weekMenuFor(anchorDate: string) {
    return Object.fromEntries(
      buildWeekDays(anchorDate, 1).map((date) => [date, bySlot(dayMenuFor(date))])
    );
  }

  beforeEach(() => {
    nextEntryId = 1;
    delayedWeeks = new Map();
    delayedPlanWrite = null;
    recipes = [
      {
        id: "r1",
        name: "Old Recipe",
        ingredients: null,
        instructions: null,
        slots: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    plans = [{ id: "p1", name: "Weeknights", active: true, createdAt: 0, updatedAt: 0 }];
    entries = [];

    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify({ locale: { timezone: "UTC", language: "en" } }), {
            status: 200,
          })
        );
      }

      if (/\/api\/recipes\/[^/]+\/dependents$/.test(url)) {
        const id = url.match(/\/api\/recipes\/([^/]+)\/dependents$/)?.[1];
        const oneOffCount = entries.filter((e) => e.kind === "oneoff" && e.recipeId === id).length;
        const recurringCount = entries.filter(
          (e) => e.kind === "recurring" && e.recipeId === id
        ).length;
        return Promise.resolve(
          new Response(JSON.stringify({ recurringCount, oneOffCount }), { status: 200 })
        );
      }

      if (/\/api\/recipes\/[^/]+$/.test(url) && method === "DELETE") {
        const id = url.match(/\/api\/recipes\/([^/]+)$/)?.[1];
        recipes = recipes.filter((r) => r.id !== id);
        // FK cascade (recipes -> meal_entries ON DELETE CASCADE, FR-028).
        entries = entries.filter((e) => e.recipeId !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url.startsWith("/api/recipes")) {
        return Promise.resolve(new Response(JSON.stringify(recipes), { status: 200 }));
      }

      if (/\/api\/meal-entries\/[^/]+$/.test(url) && method === "PATCH") {
        const id = url.match(/\/api\/meal-entries\/([^/]+)$/)?.[1];
        const body = JSON.parse(init!.body as string) as { recipeId?: string; note?: string };
        entries = entries.map((e) =>
          e.id === id ? { ...e, recipeId: body.recipeId ?? null, note: body.note ?? null } : e
        );
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }

      if (/\/api\/meal-plans\/[^/]+\/entries$/.test(url)) {
        const id = url.match(/\/api\/meal-plans\/([^/]+)\/entries$/)?.[1];
        const planEntries = entries.filter((e) => e.kind === "recurring" && e.mealPlanId === id);
        return Promise.resolve(new Response(JSON.stringify(planEntries), { status: 200 }));
      }

      if (/\/api\/meal-plans\/[^/]+$/.test(url) && method === "PATCH") {
        const id = url.match(/\/api\/meal-plans\/([^/]+)$/)?.[1];
        const body = JSON.parse(init!.body as string) as { active?: boolean };
        const respond = () => {
          plans = plans.map((plan) => (plan.id === id ? { ...plan, ...body } : plan));
          return new Response(JSON.stringify(plans.find((plan) => plan.id === id)), {
            status: 200,
          });
        };
        return delayedPlanWrite ? delayedPlanWrite.then(respond) : Promise.resolve(respond());
      }

      if (url.startsWith("/api/meal-plans")) {
        return Promise.resolve(new Response(JSON.stringify(plans), { status: 200 }));
      }

      if (url.startsWith("/api/meal-entries") && method === "POST") {
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        const entry = {
          id: `e${nextEntryId++}`,
          kind: body.kind as "oneoff" | "recurring",
          date: (body.date as string) ?? null,
          weekday: (body.weekday as string) ?? null,
          mealPlanId: (body.mealPlanId as string) ?? null,
          slot: body.slot as string,
          recipeId: (body.recipeId as string) ?? null,
          note: (body.note as string) ?? null,
          createdAt: 0,
        };
        entries.push(entry);
        return Promise.resolve(new Response(JSON.stringify(entry), { status: 201 }));
      }

      if (url.startsWith("/api/menu/week")) {
        const date = new URL(url, "http://localhost").searchParams.get("date") ?? today;
        const respond = () => new Response(JSON.stringify(weekMenuFor(date)), { status: 200 });
        const delay = delayedWeeks.get(date);
        return delay ? delay.then(respond) : Promise.resolve(respond());
      }

      throw new Error(`unexpected fetch: ${url} (${method})`);
    });

    vi.stubGlobal("fetch", mockFetch);
    fetchMock = mockFetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  function renderSurface() {
    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );
  }

  /** The admin meals panels are tabs (Preview, Meal plans, Recipes): open the one a query targets. */
  async function openTab(name: "Preview" | "Meal plans" | "Recipes") {
    fireEvent.click(await screen.findByRole("tab", { name }));
  }

  /** The recipe card, in the Recipes tab. */
  function recipeCard(name: string): HTMLElement {
    return screen.getByRole("heading", { name }).closest("div.border") as HTMLElement;
  }

  it("shows a newly-added one-off entry in the week grid without a manual reload", async () => {
    renderSurface();

    const weekGrid = await screen.findByTestId("meal-plan-grid");
    expect(within(weekGrid).queryByText("Weeknight note")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId(`meal-cell-${today}-dinner`));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Free text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Free text" }), {
      target: { value: "Weeknight note" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Entry" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("meal-plan-grid")).getByText("Weeknight note")
      ).toBeInTheDocument();
    });
    expect(entries).toEqual([
      expect.objectContaining({ kind: "oneoff", date: today, slot: "dinner" }),
    ]);
  });

  it("removes a deleted recipe's entries from the week grid without a manual reload", async () => {
    entries = [
      {
        id: "e0",
        kind: "oneoff",
        date: today,
        weekday: null,
        mealPlanId: null,
        slot: "dinner",
        recipeId: "r1",
        note: null,
        createdAt: 0,
      },
    ];

    renderSurface();

    const weekGrid = await screen.findByTestId("meal-plan-grid");
    expect(await within(weekGrid).findByRole("button", { name: "Old Recipe" })).toBeInTheDocument();

    await openTab("Recipes");
    fireEvent.click(within(recipeCard("Old Recipe")).getByRole("button", { name: "Delete" }));
    // Recipe delete confirms through the shared ConfirmDialog — click its confirm button.
    const deleteDialog = await screen.findByRole("dialog");
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openTab("Preview");
    await waitFor(() => {
      expect(
        within(screen.getByTestId("meal-plan-grid")).queryByRole("button", { name: "Old Recipe" })
      ).not.toBeInTheDocument();
    });
  });

  it("shows a newly-added recurring entry in its plan card", async () => {
    renderSurface();

    await openTab("Meal plans");
    const card = await screen.findByTestId("meals-plan-card");
    await within(card).findByText("No entries in this plan.");

    fireEvent.click(within(card).getByTestId("meals-plan-add-recurring"));
    fireEvent.click(within(card).getByTestId("meals-recurring-weekday-mon"));
    fireEvent.change(within(card).getByTestId("meals-recurring-slot-select"), {
      target: { value: "breakfast" },
    });
    fireEvent.click(within(card).getByRole("radio", { name: "Free text" }));
    fireEvent.change(within(card).getByTestId("meals-recurring-note-input"), {
      target: { value: "Oatmeal" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add Recurring Entry" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("meals-plan-entries-p1")).getByText("Oatmeal")
      ).toBeVisible();
    });
    // The form collapses after a successful add.
    expect(screen.queryByTestId("meals-recurring-note-input")).not.toBeInTheDocument();
  });

  it("removes a deleted recipe's cascaded recurring entry from its plan card", async () => {
    entries = [
      {
        id: "e0",
        kind: "recurring",
        date: null,
        weekday: "mon",
        mealPlanId: "p1",
        slot: "breakfast",
        recipeId: "r1",
        note: null,
        createdAt: 0,
      },
    ];

    renderSurface();

    const planCard = await screen.findByTestId("meals-plan-card");
    await waitFor(() => {
      expect(within(planCard).getAllByTestId("meals-plan-entry-row")).toHaveLength(1);
    });

    // (Asserting on the row itself, not a recipe-name label: once the recipe list refetches
    // post-delete, the row's fallback label swaps to the raw recipeId — a phantom row can
    // otherwise "look" different without disappearing, masking the real defect.)
    await openTab("Recipes");
    fireEvent.click(within(recipeCard("Old Recipe")).getByRole("button", { name: "Delete" }));
    const deleteDialog = await screen.findByRole("dialog");
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("meals-plan-card")).queryAllByTestId("meals-plan-entry-row")
      ).toHaveLength(0);
    });
  });

  it("shows a recurring entry added from the week grid in its plan card", async () => {
    const weekdayName = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(
      new Date(`${today}T12:00:00Z`)
    );
    renderSurface();

    await screen.findByTestId("meals-plan-entries-p1");
    fireEvent.click(await screen.findByTestId(`meal-cell-${today}-lunch`));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: `Every ${weekdayName}` }));
    // The single active plan is preselected.
    expect(within(dialog).getByRole("combobox", { name: "Meal Plan" })).toHaveValue("p1");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Free text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Free text" }), {
      target: { value: "Soup" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Entry" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openTab("Meal plans");
    await waitFor(() => {
      expect(within(screen.getByTestId("meal-plan-grid")).getByText("Soup")).toBeInTheDocument();
      expect(within(screen.getByTestId("meals-plan-entries-p1")).getByText("Soup")).toBeVisible();
    });
    const post = (fetchMock.mock.calls as Parameters<typeof fetch>[]).find(
      ([input, init]) => String(input) === "/api/meal-entries" && init?.method === "POST"
    );
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      kind: "recurring",
      mealPlanId: "p1",
      weekday: weekdayOf(today, "UTC"),
      slot: "lunch",
      note: "Soup",
    });
  });

  it("updates the plan card when a recurring meal is edited from the week grid", async () => {
    entries = [
      {
        id: "e0",
        kind: "recurring",
        date: null,
        weekday: weekdayOf(today, "UTC"),
        mealPlanId: "p1",
        slot: "dinner",
        recipeId: null,
        note: "Stew",
        createdAt: 0,
      },
    ];
    renderSurface();

    const grid = await screen.findByTestId("meal-plan-grid");
    fireEvent.click(await within(grid).findByRole("button", { name: "Stew" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("note")).toHaveTextContent("This changes every matching week.");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Free text" }), {
      target: { value: "Bean stew" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openTab("Meal plans");
    await waitFor(() => {
      expect(
        within(screen.getByTestId("meals-plan-entries-p1")).getByText("Bean stew")
      ).toBeVisible();
    });
  });

  it("keeps the newer week when an older week response arrives late", async () => {
    let releasePreviousWeek!: () => void;
    delayedWeeks.set(
      previousWeekAnchor,
      new Promise<void>((resolve) => {
        releasePreviousWeek = resolve;
      })
    );
    renderSurface();

    await screen.findByTestId(`meal-day-heading-${today}`);
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    // Back on the current week; its (fast) response has landed.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/menu/week"))
      ).toHaveLength(3)
    );
    await screen.findByTestId(`meal-day-heading-${today}`);

    releasePreviousWeek();
    // Let the late response settle, then check it did not replace the current week.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByTestId(`meal-day-heading-${today}`)).toBeInTheDocument();
    expect(
      screen.queryByTestId(`meal-day-heading-${addCalendarDays(today, -7)}`)
    ).not.toBeInTheDocument();
  });

  it("keeps the week the user moved to when a slow plan write finishes", async () => {
    let releasePlanWrite!: () => void;
    delayedPlanWrite = new Promise<void>((resolve) => {
      releasePlanWrite = resolve;
    });
    const nextWeekDate = addCalendarDays(today, 7);
    renderSurface();

    await screen.findByTestId(`meal-day-heading-${today}`);
    // Deactivate the plan (slow), then move to next week before the write returns.
    await openTab("Meal plans");
    fireEvent.click(await screen.findByRole("button", { name: "Weeknights" }));
    await openTab("Preview");
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByTestId(`meal-day-heading-${nextWeekDate}`);
    const weekReads = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/menu/week"));
    const readsBefore = weekReads().length;

    releasePlanWrite();
    // The write's menu refresh lands; it must re-read the week on screen, not the old one.
    await waitFor(() => expect(weekReads().length).toBeGreaterThan(readsBefore));
    expect(String(weekReads().at(-1)![0])).toContain(`date=${nextWeekDate}`);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByTestId(`meal-day-heading-${nextWeekDate}`)).toBeInTheDocument();
  });
});
