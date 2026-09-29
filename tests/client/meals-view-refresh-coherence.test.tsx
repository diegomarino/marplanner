import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";
import { LanguageProvider } from "@/i18n";

/** Rework — view-staleness regression coverage.
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

  function todayIsoDate(): string {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const today = todayIsoDate();

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

  function dayMenuFor(date: string) {
    return entries.filter((e) => e.kind === "oneoff" && e.date === date).map(toMenuItem);
  }

  function weekMenuFor(anchorDate: string) {
    // Simplified single-key "week" — the client does not assume a fixed key count,
    // it just iterates whatever Object.keys(week) returns.
    return { [anchorDate]: bySlot(dayMenuFor(anchorDate)) };
  }

  beforeEach(() => {
    nextEntryId = 1;
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
          new Response(JSON.stringify({ locale: { language: "en" } }), { status: 200 })
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

      if (/\/api\/meal-plans\/[^/]+\/entries$/.test(url)) {
        const id = url.match(/\/api\/meal-plans\/([^/]+)\/entries$/)?.[1];
        const planEntries = entries.filter((e) => e.kind === "recurring" && e.mealPlanId === id);
        return Promise.resolve(new Response(JSON.stringify(planEntries), { status: 200 }));
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
        return Promise.resolve(new Response(JSON.stringify(weekMenuFor(date)), { status: 200 }));
      }

      if (url.startsWith("/api/menu")) {
        const date = new URL(url, "http://localhost").searchParams.get("date") ?? today;
        return Promise.resolve(new Response(JSON.stringify(dayMenuFor(date)), { status: 200 }));
      }

      throw new Error(`unexpected fetch: ${url} (${method})`);
    });

    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows a newly-added one-off entry in the week grid without a manual reload", async () => {
    plans = []; // keep the recurring-entry form's note input out of the DOM (placeholder collision)

    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );

    const weekGrid = await screen.findByTestId("meals-week-grid");
    expect(within(weekGrid).queryByText("Weeknight note")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("meals-entry-date-input"), { target: { value: today } });
    fireEvent.change(screen.getByTestId("meals-entry-slot-select"), {
      target: { value: "dinner" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Note" }));
    fireEvent.change(screen.getByPlaceholderText("Entry note"), {
      target: { value: "Weeknight note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("meals-week-grid")).getByText("Weeknight note")
      ).toBeInTheDocument();
    });
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

    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );

    const weekGrid = await screen.findByTestId("meals-week-grid");
    await waitFor(() => {
      expect(within(weekGrid).getByText("Old Recipe")).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    //: recipe delete now confirms through the shared ConfirmDialog
    // (themed modal) instead of window.confirm — click its confirm button.
    const deleteDialog = await screen.findByRole("dialog");
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("meals-week-grid")).queryByText("Old Recipe")
      ).not.toBeInTheDocument();
    });
  });

  it("shows a newly-added recurring entry in an already-expanded plan panel", async () => {
    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );

    fireEvent.click(await screen.findByTestId("meals-plan-toggle-entries"));
    await screen.findByText("No entries in this plan.");

    fireEvent.change(screen.getByTestId("meals-recurring-plan-select"), {
      target: { value: "p1" },
    });
    fireEvent.change(screen.getByTestId("meals-recurring-weekday-select"), {
      target: { value: "mon" },
    });
    fireEvent.change(screen.getByTestId("meals-recurring-slot-select"), {
      target: { value: "breakfast" },
    });
    // Two forms on the page share the "Note" radio label (one-off + recurring) —
    // the recurring form's is the second one.
    fireEvent.click(screen.getAllByRole("radio", { name: "Note" })[1]);
    fireEvent.change(screen.getByTestId("meals-recurring-note-input"), {
      target: { value: "Oatmeal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Recurring Entry" }));

    await waitFor(() => {
      expect(screen.getByText("Oatmeal")).toBeInTheDocument();
    });
  });

  it("removes a deleted recipe's cascaded recurring entry from an already-expanded plan panel", async () => {
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

    render(
      <LanguageProvider>
        <MealsManagement />
      </LanguageProvider>
    );

    fireEvent.click(await screen.findByTestId("meals-plan-toggle-entries"));

    const planCard = screen.getByTestId("meals-plan-card");
    await waitFor(() => {
      expect(within(planCard).getAllByTestId("meals-plan-entry-row")).toHaveLength(1);
    });

    // Two "Delete" buttons exist once the panel is expanded (the recipe card's
    // and the phantom entry row's) — the recipe card's renders first in the DOM.
    // (Asserting on the row itself, not a recipe-name label: once the recipe
    // list refetches post-delete, the row's fallback label swaps to the raw
    // recipeId — a phantom row can otherwise "look" different without
    // disappearing, masking the real defect.)
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    //: recipe delete now confirms through the shared ConfirmDialog
    // (themed modal) instead of window.confirm — click its confirm button.
    const deleteDialog = await screen.findByRole("dialog");
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("meals-plan-card")).queryAllByTestId("meals-plan-entry-row")
      ).toHaveLength(0);
    });
  });
});
