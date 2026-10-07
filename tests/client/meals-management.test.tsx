/** MealsManagement spec (— the PROVING BATCH, FR-009/FR-011).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over this surface's rendered control set with kiosk density
 * active (not merely imports it), records a deliberate negative proving the assertion can fail
 * on THIS surface's own controls, and asserts every error state the surface renders is announced
 * through the shared `ErrorNotice` live region (SC-011).
 * Functional/wiring regressions already have dedicated coverage in the sibling `meals-*.test.tsx`
 * files (search, entry authoring, plan CRUD, view-refresh coherence) — this file does not repeat
 * that surface area; it only proves the migration-specific guarantees exists to prove.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MealsManagement } from "@/admin/MealsManagement";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

type FetchCall = Parameters<typeof globalThis.fetch>;

const RECIPE = {
  id: "r1",
  name: "Lentil Soup",
  ingredients: ["Lentils", "Water"],
  instructions: "Boil the lentils.",
  slots: null,
  createdAt: 0,
  updatedAt: 0,
};

const PLAN = { id: "p1", name: "Weeknights", active: true, createdAt: 0, updatedAt: 0 };
const INACTIVE_PLAN = { id: "p2", name: "Weekends", active: false, createdAt: 0, updatedAt: 0 };

const RECURRING_ENTRY = {
  id: "e1",
  kind: "recurring" as const,
  date: null,
  weekday: "mon",
  mealPlanId: "p1",
  slot: "breakfast",
  recipeId: "r1",
  note: null,
  createdAt: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

/** A fully-loaded, happy-path mock backend — recipes, an active plan, an empty day/week menu.
 * `overrides` lets a single test redirect one endpoint to a failure without re-declaring the rest. */
function mockBackend(overrides: Partial<Record<string, () => Response>> = {}) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (overrides.settings && url.includes("/api/settings")) {
      return Promise.resolve(overrides.settings());
    }
    if (url.includes("/api/settings")) {
      return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
    }

    if (overrides.recipes && url.startsWith("/api/recipes") && method === "GET") {
      return Promise.resolve(overrides.recipes());
    }
    if (/\/api\/recipes\/[^/]+\/dependents$/.test(url)) {
      return Promise.resolve(json({ recurringCount: 0, oneOffCount: 0 }));
    }
    if (url.startsWith("/api/recipes") && method === "GET") {
      return Promise.resolve(json([RECIPE]));
    }

    if (
      overrides.plans &&
      url.startsWith("/api/meal-plans") &&
      method === "GET" &&
      !url.includes("/entries")
    ) {
      return Promise.resolve(overrides.plans());
    }
    if (overrides.planEntries && /\/api\/meal-plans\/[^/]+\/entries$/.test(url)) {
      return Promise.resolve(overrides.planEntries());
    }
    if (/\/api\/meal-plans\/[^/]+\/entries$/.test(url)) {
      return Promise.resolve(json([RECURRING_ENTRY]));
    }
    if (url.startsWith("/api/meal-plans") && method === "GET") {
      return Promise.resolve(json([PLAN]));
    }

    if (overrides.menu && url.startsWith("/api/menu") && !url.includes("/week")) {
      return Promise.resolve(overrides.menu());
    }
    if (overrides.weekMenu && url.startsWith("/api/menu/week")) {
      return Promise.resolve(overrides.weekMenu());
    }
    if (url.startsWith("/api/menu")) {
      return Promise.resolve(json([]));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderSurface() {
  return render(
    <LanguageProvider>
      <MealsManagement />
    </LanguageProvider>
  );
}

/** Census helper (independent, round 2, item 1): mirrors `density.ts`'s own
 * `INTERACTIVE_CONTROL_SELECTOR` + `isRenderable` filter, duplicated here rather than imported —
 * the frozen helper deliberately exposes no census API (its public surface is
 * `assertKioskDensityCompliant` alone; see that file's own header). This is NOT a weakening of
 * the frozen file: it adds nothing to what `assertKioskDensityCompliant` checks, it only lets
 * THIS spec assert an exact control count at each phase, so a future edit that reaches fewer
 * controls than before (a batch adding a control and forgetting to drive an interaction that
 * reaches it, exactly the failure mode) goes red on the count instead of silently
 * shrinking the measured set while the density assertion itself stays green.
 */
const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return Array.from(container.querySelectorAll(CENSUS_CONTROL_SELECTOR)).filter((element) => {
    if (element instanceof HTMLElement && element.hidden) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("MealsManagement — kiosk density (SC-001, SC-002, SC-003, FR-011)", () => {
  it("meets kiosk density across every rendered control — recipe edit, plan rename, an open ConfirmDialog, expanded plan panel, and both content modes across three phases", async () => {
    mockBackend();
    // CheckboxField/RadioField (recipe slots, content-mode) render a `size-[var(--control-height)]`
    // utility — outside the density helper's base candidate list (`densityStyles.ts` header),
    // same as `checkbox-field.test.tsx`/`radio-field.test.tsx`'s own extraCandidates.
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();

      await screen.findByRole("heading", { name: RECIPE.name });
      await screen.findByTestId("meals-plan-card");

      // Phase 1 — the surface's DEFAULT content-mode state (independent, round
      // 2, item 1): `EntryAuthoringForm`, `RecurringEntryAuthoringForm` and `PlanEntryRow` all
      // start in "recipe" content mode (the latter because RECURRING_ENTRY carries a recipeId),
      // so `#meals-entry-recipe-select` and `#meals-recurring-recipe-select` — measured by the
      // original single-state test, then dropped by the two-phase revision that switched every
      // content-mode group to "note" before ever asserting — are captured HERE, before phase 2
      // switches away. `#meals-plan-rename-input` (never measured in ANY prior revision) is
      // reached the same way: the plan's own "Edit" button, opened here and left open through
      // every later phase (it does not conflict with content mode or the recipe/dialog state).
      //
      // Done BEFORE any dialog opens: Radix marks the rest of the page `aria-hidden`/inert while
      // a dialog is open, so these controls could not be reached (by role, the correct way — a
      // real kiosk user could not reach them either) once phase 3 opens one.

      // Switch the recipe into edit mode: name/ingredients/instructions/4 slot checkboxes.
      // `getAllByRole` because MealPlanCard's own "Edit" (rename) button is already on the page
      // too — the recipe's is first in document order (Recipes section renders before Meal
      // Plans).
      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
      await screen.findByTestId("meals-recipe-edit-name");

      // Open the plan's OWN rename control — now the only remaining "Edit" button on the page
      // (the recipe's is hidden while it is itself editing).
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      await screen.findByTestId("meals-plan-rename-input");

      // Expand the plan panel so PlanEntryRow's controls (weekday/slot text, edit/delete,
      // and — once opened for edit — RadioField/select/Input, defaulting to "recipe" mode) are
      // also in the measured set.
      fireEvent.click(screen.getByTestId("meals-plan-toggle-entries"));
      const entryRow = await screen.findByTestId("meals-plan-entry-row");
      fireEvent.click(within(entryRow).getByRole("button", { name: "Edit" }));

      // Asserted over document.body rather than a local `container` throughout this test, even
      // before any dialog is open — matching the frozen helper's own SC-003 idiom and avoiding a
      // second, narrower assertion style that could hide a future portal-only regression.
      //
      // The count assertion is the point (independent item 1): a future edit that adds a
      // control but fails to drive an interaction that reaches it shrinks this number — with no
      // count check, `assertKioskDensityCompliant` stays green regardless, because it only
      // checks the controls it WAS given, never how many there should have been.
      expect(countInteractiveControls(document.body)).toBe(47);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — switch every content-mode radio group to "note" so the three note-mode inputs
      // (the top-level entry form, the recurring-entry form, and this expanded PlanEntryRow) are
      // ALSO measured. This is the other half of the original defect: the recipe-mode
      // selects were measured in phase 1 above, so switching away from them here is a state
      // transition, not a loss — nothing that was reachable in phase 1 was reachable ONLY in a
      // state phase 2 then hides for good.
      for (const radio of screen.getAllByRole("radio", { name: "Note" })) {
        fireEvent.click(radio);
      }
      await screen.findAllByPlaceholderText("Entry note");

      expect(countInteractiveControls(document.body)).toBe(47);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — SC-003: an open ConfirmDialog, portalled by Radix to document.body, OUTSIDE
      // the rendering surface. The recipe's Delete button only renders outside its own edit mode
      // (mutually exclusive with phase 1's edit-mode controls in the same card), so cancel back
      // out of it first — the FIRST "Cancel" in document order (Recipes section precedes Meal
      // Plans; the plan rename and the expanded PlanEntryRow edit both stay open through this
      // phase, untouched by this click).
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
      await waitFor(() => expect(screen.queryByTestId("meals-recipe-edit-name")).toBeNull());

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await screen.findByRole("dialog");

      expect(countInteractiveControls(document.body)).toBe(42);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing one of this surface's own controls below the kiosk minimum makes the assertion fail", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderSurface();
      await screen.findByRole("heading", { name: RECIPE.name });

      // A real control from this surface, not a synthetic fixture — the recipe search input.
      const searchInput = screen.getByPlaceholderText("Search recipes…");
      searchInput.style.height = "10px";
      searchInput.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      // Recorded verbatim in this module's report — proof the helper actually rejects a real
      // undersized control on THIS surface, not merely on the helper's own synthetic fixtures.
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);
    } finally {
      uninject();
    }
  });
});

describe("MealsManagement — error states are announced (SC-011)", () => {
  it("announces the pre-ready settings-load failure", async () => {
    mockBackend({ settings: () => json(null, 503) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load meals data.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces the general recipes-load failure", async () => {
    mockBackend({ recipes: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load meals data.");
  });

  it("announces the day-menu load failure", async () => {
    mockBackend({ menu: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load the menu.");
  });

  it("announces the meal-plans load failure", async () => {
    mockBackend({ plans: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load meal plans.");
  });

  it("announces the week-menu load failure", async () => {
    mockBackend({ weekMenu: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load the week menu.");
  });

  it("announces a plan's entries-load failure once its panel is expanded", async () => {
    mockBackend({ planEntries: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("meals-plan-card");
    fireEvent.click(screen.getByTestId("meals-plan-toggle-entries"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update plan entries.");
  });
});

describe("MealsManagement — ConfirmDialog replaces window.confirm for recipe/entry deletion", () => {
  it("does not delete the recipe until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete this recipe?");

    // Cancel first — no DELETE must have fired.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) => String(reqInput) === "/api/recipes/r1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Now confirm.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialogAgain = await screen.findByRole("dialog");
    fireEvent.click(within(dialogAgain).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) => String(reqInput) === "/api/recipes/r1" && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });

  // (independent): this describe block's own name promises "recipe/entry
  // deletion", but only recipe deletion had a test — a plan-entry delete button wired directly to
  // `onClick={ => onDelete}` (no confirmation at all) passed the entire suite.
  it("does not delete a recurring entry until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await screen.findByTestId("meals-plan-card");
    fireEvent.click(screen.getByTestId("meals-plan-toggle-entries"));
    const entryRow = await screen.findByTestId("meals-plan-entry-row");

    fireEvent.click(within(entryRow).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete this entry?");

    // Cancel first — no DELETE must have fired.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput, init]) =>
          String(reqInput) === "/api/meal-entries/e1" && init?.method === "DELETE"
      )
    ).toHaveLength(0);

    // Now confirm.
    fireEvent.click(within(entryRow).getByRole("button", { name: "Delete" }));
    const dialogAgain = await screen.findByRole("dialog");
    fireEvent.click(within(dialogAgain).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput, init]) =>
            String(reqInput) === "/api/meal-entries/e1" && init?.method === "DELETE"
        )
      ).toHaveLength(1);
    });
  });
});

describe("MealsManagement — SLOT_LABEL_KEYS maps each slot to its own translation key (HIGH-2)", () => {
  it("labels the entry-authoring slot select with each slot's own name, in slot order", async () => {
    mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });

    const slotSelect = screen.getByTestId("meals-entry-slot-select") as HTMLSelectElement;
    const optionLabels = Array.from(slotSelect.options).map((option) => option.textContent);
    // Deliberately not a set/sorted comparison — a mislabelled map (e.g. breakfast <-> lunch
    // swapped) preserves the SET of labels while breaking which slot gets which one; only an
    // order-and-content comparison against each slot's own expected label catches that.
    expect(optionLabels).toEqual(["Breakfast", "Lunch", "Snack", "Dinner"]);
  });
});

// Independent, round 2, item 3: (the `as MessageKey` -> typed-map
// refactor) was proven for SLOT_LABEL_KEYS above but NOT for WEEKDAY_LABEL_KEYS/weekdayLabels —
// a mon<->tue swap in the map, or replacing weekdayLabels's `t(...)` call with the English
// literal "Monday", both passed the whole suite. The general rule this leaves for every future
// batch doing the SAME `as MessageKey` -> typed-map refactor: assert EVERY map the refactor
// creates, not just the one you happened to think of first — a refactor rarely touches only one.
describe("MealsManagement — WEEKDAY_LABEL_KEYS maps each weekday to its own translation key, through i18n (HIGH-2 parity)", () => {
  it("labels the recurring-entry weekday select with each weekday's own translated name, in canonical order, under a non-English household locale", async () => {
    // Rendered in Spanish, not English: this is what actually falsifies a `weekdayLabels` call
    // site that swapped a `t(WEEKDAY_LABEL_KEYS.mon)` lookup for the English literal "Monday" —
    // in English that mutant would still read wrong ("Monday" vs the real "Mon"), but only a
    // non-English render proves the label is coming from the i18n catalogue at all rather than
    // being coincidentally reproduced by a hardcoded fallback.
    mockBackend({ settings: () => json({ locale: { timezone: "UTC", language: "es" } }) });
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });
    await screen.findByTestId("meals-plan-card");

    const weekdaySelect = (await screen.findByTestId(
      "meals-recurring-weekday-select"
    )) as HTMLSelectElement;
    const optionLabels = Array.from(weekdaySelect.options).map((option) => option.textContent);
    // Deliberately order-and-content, not a set comparison — same rationale as the slot
    // assertion above: a mon<->tue swap in WEEKDAY_LABEL_KEYS preserves the SET of labels while
    // breaking which weekday gets which one.
    expect(optionLabels).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });
});

describe("MealsManagement — recipe-create textareas keep their explicit label association (Codex, independent review on PR #760)", () => {
  it("gives the ingredients and instructions textareas their own accessible name", async () => {
    mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });

    // `getByRole` with `name` fails outright (not merely "wrong name") if `htmlFor`/`id` is
    // removed from either side of the pair — the exact regression the independent review found
    // unasserted (N3/N4): the file's own doc comment claims this association since the
    // fix, but nothing checked it.
    expect(
      screen.getByRole("textbox", { name: "Ingredients (one per line)" })
    ).toHaveAccessibleName("Ingredients (one per line)");
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveAccessibleName(
      "Instructions"
    );
  });
});

describe("MealsManagement — RecipeCard edit-mode controls carry visible, associated labels (#764)", () => {
  it("gives the name/ingredients/instructions edit-mode controls their own accessible name via the shared Field component", async () => {
    mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await screen.findByTestId("meals-recipe-edit-name");

    // demands a VISIBLE label, and `toHaveAccessibleName` alone cannot enforce that — a
    // bare `aria-label` (invisible to sighted users, the issue's literal complaint) satisfies it
    // identically (independent review on this module proved it by mutation: stripping `Field` for an
    // `aria-label` left the whole suite green). So each control asserts the visible association
    // itself: no `aria-label` attribute, and a real `<label for>` element carrying the text.
    for (const [testId, labelText] of [
      ["meals-recipe-edit-name", "Name"],
      ["meals-recipe-edit-ingredients", "Ingredients (one per line)"],
      ["meals-recipe-edit-instructions", "Instructions"],
    ] as const) {
      const control = screen.getByTestId(testId);
      expect(control).toHaveAccessibleName(labelText);
      expect(
        control,
        `${testId} must be named by a visible label, not aria-label`
      ).not.toHaveAttribute("aria-label");
      const label = document.querySelector(`label[for="${control.id}"]`);
      expect(label, `${testId} must have an associated <label for>`).not.toBeNull();
      expect(label!).toHaveTextContent(labelText);
    }
  });
});

describe("MealsManagement — the four -orphaned controls carry real accessible names (#771)", () => {
  it("names the one-off, plan-rename, plan-entry and recurring recipe/name controls", async () => {
    mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });
    await screen.findByTestId("meals-plan-card");

    // `MealsManagement.tsx:902` — EntryAuthoringForm's recipe picker (default content mode,
    // rendered without any interaction).
    expect(screen.getByTestId("meals-entry-recipe-select")).toHaveAccessibleName("Recipe");

    // `MealsManagement.tsx:1582` — RecurringEntryAuthoringForm's recipe picker (default content
    // mode, rendered as soon as a plan exists — no interaction needed either).
    expect(screen.getByTestId("meals-recurring-recipe-select")).toHaveAccessibleName("Recipe");

    // `MealsManagement.tsx:1149` — the plan-rename input, reached via the plan card's OWN "Edit"
    // button. `getAllByRole` because RecipeCard's "Edit" is still on the page too (not entered);
    // the plan's is the SECOND "Edit" in document order (Recipes section renders first).
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    expect(screen.getByTestId("meals-plan-rename-input")).toHaveAccessibleName("Plan name");

    // `MealsManagement.tsx:1391` — PlanEntryRow's recipe picker, reached by expanding the plan
    // panel and opening its (recipe-mode by default, since RECURRING_ENTRY carries a recipeId)
    // entry row for edit.
    fireEvent.click(screen.getByTestId("meals-plan-toggle-entries"));
    const entryRow = await screen.findByTestId("meals-plan-entry-row");
    fireEvent.click(within(entryRow).getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("meals-plan-entry-recipe-select")).toHaveAccessibleName("Recipe");
  });
});

describe("MealsManagement — adopts the AdminPanel L2 frame (M20, independent review on PR #760; heading half retrofitted by c)", () => {
  it("wraps the surface in a landmark region labelled by its own title, with a heading of the same name", async () => {
    mockBackend();
    renderSurface();

    // Anchor on LOADED content FIRST (retrofit — verification policy): a surface
    // whose loading skeleton renders a heading of its own could satisfy a heading-only assertion
    // before the real panel ever mounts. Waiting for a fixture row proves what follows runs
    // against the actually-loaded surface, not a transient loading state.
    await screen.findByRole("heading", { name: RECIPE.name });

    // A bare `<div>` in place of `AdminPanel` passes every functional test in this file — this
    // is the only assertion that would catch it: the region role, its accessible name, AND the
    // heading itself all come from `AdminPanel`'s `role="region"` + generated `aria-labelledby`
    // pointing at its own `<h2>`, not from anything this surface writes itself. Region alone was
    // asserted since; this file's own heading assertions were all recipe-card titles
    // (measured 2026-09-10) — never the panel's own heading — until this retrofit.
    expect(screen.getByRole("region", { name: "Meals Management" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Meals Management" })).toBeInTheDocument();
  });
});

describe("MealsManagement — accessible names (MEDIUM-b, MEDIUM-c)", () => {
  it("gives the recurring-entry weekday select its own accessible group name", async () => {
    mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });
    await screen.findByTestId("meals-plan-card");

    expect(screen.getByTestId("meals-recurring-weekday-select")).toHaveAccessibleName("Weekday");
  });

  it("gives the recipe-create slots fieldset its accessible group name", async () => {
    mockBackend();
    renderSurface();

    await screen.findByRole("heading", { name: RECIPE.name });

    expect(screen.getByRole("group", { name: "Slots" })).toBeInTheDocument();
  });
});

// (independent, — doctrine settled AFTER shipped this call
// site): `aria-pressed` already carries the state, so a name that ALSO changes with the state
// (the previous `${plan.name} ${stateWord}` shape) announces it twice and re-announces the whole
// name on every toggle. The accessible name must be STATE-INVARIANT; the visible `label` stays
// action-shaped for sighted users. Mirrors `chores-board.test.tsx`'s identical two-fixture proof
// for `chore.name` — an active AND an inactive plan rendered together, so each toggle's name is
// checked against its OWN bare `plan.name`, never a state-derived string.
describe("MealsManagement — MealPlanCard's StatusToggle accessible name is state-invariant (#781)", () => {
  it("gives an active plan's toggle just its name as the accessible name, action-shaped visible text, and aria-pressed=true", async () => {
    mockBackend({ plans: () => json([PLAN, INACTIVE_PLAN]) });
    renderSurface();

    await screen.findAllByTestId("meals-plan-card");
    const toggle = screen.getByRole("button", { name: PLAN.name });

    expect(toggle).toHaveAccessibleName(PLAN.name);
    expect(toggle).toHaveTextContent("Deactivate");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("gives an inactive plan's toggle just its OWN name — not appended with a state word — action-shaped visible text, and aria-pressed=false", async () => {
    mockBackend({ plans: () => json([PLAN, INACTIVE_PLAN]) });
    renderSurface();

    await screen.findAllByTestId("meals-plan-card");
    const toggle = screen.getByRole("button", { name: INACTIVE_PLAN.name });

    expect(toggle).toHaveAccessibleName(INACTIVE_PLAN.name);
    expect(toggle).toHaveTextContent("Activate");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});
