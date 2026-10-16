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
function mockBackend(overrides: Partial<Record<string, () => Response | Promise<Response>>> = {}) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (overrides.settings && url.includes("/api/settings")) {
      return Promise.resolve(overrides.settings());
    }
    if (url.includes("/api/settings")) {
      return Promise.resolve(json({ locale: { timezone: "UTC", language: "en" } }));
    }

    if (method !== "GET" && !/\/api\/recipes\/[^/]+$/.test(url)) {
      return Promise.resolve(overrides.write ? overrides.write() : json({}));
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
    if (url.startsWith("/api/menu/week")) {
      return Promise.resolve(json(emptyWeek()));
    }
    if (url.startsWith("/api/menu")) {
      return Promise.resolve(json([]));
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

/** A 7-day week with every slot empty, as `GET /api/menu/week` returns it. */
function emptyWeek(start = "2026-01-12") {
  return Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(`${start}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return [d.toISOString().slice(0, 10), { breakfast: [], lunch: [], snack: [], dinner: [] }];
    })
  );
}

/** The recipe card, in the Recipes tab. */
function recipeCard(): HTMLElement {
  return screen.getByRole("heading", { name: RECIPE.name }).closest("div.border") as HTMLElement;
}

/** The first plan card. */
function planCard(): HTMLElement {
  return screen.getAllByTestId("meals-plan-card")[0];
}

function renderSurface() {
  return render(
    <LanguageProvider>
      <MealsManagement />
    </LanguageProvider>
  );
}

/** The admin meals panels are tabs (Preview, Meal plans, Recipes): open the one a query targets. */
async function openTab(name: "Preview" | "Meal plans" | "Recipes") {
  fireEvent.click(await screen.findByRole("tab", { name }));
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

// Measured control counts per phase (re-measure when the surface gains or loses a control).
const PHASE_1_COUNT = 79;
const PHASE_2_COUNT = 79;
const PHASE_3_COUNT = 74;
const PHASE_4_COUNT = 81;

describe("MealsManagement — kiosk density (SC-001, SC-002, SC-003, FR-011)", () => {
  it("meets kiosk density across every rendered control — recipe edit, plan rename, an open ConfirmDialog, plan entries, the in-card recurring form, the grid entry dialog, and both content modes across four phases", async () => {
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

      await openTab("Recipes");
      await screen.findByRole("heading", { name: RECIPE.name });
      await screen.findByTestId("meals-plan-card");

      // Phase 1 — the surface's DEFAULT content-mode state: the in-card recurring form and the
      // opened `PlanEntryRow` both start in "recipe" content mode (the latter because
      // RECURRING_ENTRY carries a recipeId), so both recipe selects are captured HERE, before
      // phase 2 switches away. The recipe edit form and the plan rename input are opened here and
      // left open through the later phases.
      //
      // Done BEFORE any dialog opens: Radix marks the rest of the page `aria-hidden`/inert while
      // a dialog is open, so these controls could not be reached (by role, the correct way — a
      // real kiosk user could not reach them either) once phase 3 opens one.

      // Switch the recipe into edit mode: name/ingredients/instructions/4 slot checkboxes. The
      // card element is captured first: its heading is gone while it is editing.
      const recipe = recipeCard();
      fireEvent.click(within(recipe).getByRole("button", { name: "Edit" }));
      await screen.findByTestId("meals-recipe-edit-name");

      // Open the plan's OWN rename control — the first "Edit" inside the plan card (the entry
      // row's own "Edit" follows it).
      await openTab("Meal plans");
      fireEvent.click(within(planCard()).getAllByRole("button", { name: "Edit" })[0]);
      await screen.findByTestId("meals-plan-rename-input");

      // Open the always-visible entry row for edit, and the card's own recurring-entry form.
      const entryRow = await screen.findByTestId("meals-plan-entry-row");
      fireEvent.click(within(entryRow).getByRole("button", { name: "Edit" }));
      fireEvent.click(screen.getByTestId("meals-plan-add-recurring"));
      await screen.findByTestId("meals-recurring-recipe-select");

      // Asserted over document.body rather than a local `container` throughout this test, even
      // before any dialog is open — matching the frozen helper's own SC-003 idiom and avoiding a
      // second, narrower assertion style that could hide a future portal-only regression.
      //
      // The count assertion is the point (independent item 1): a future edit that adds a
      // control but fails to drive an interaction that reaches it shrinks this number — with no
      // count check, `assertKioskDensityCompliant` stays green regardless, because it only
      // checks the controls it WAS given, never how many there should have been.
      expect(countInteractiveControls(document.body)).toBe(PHASE_1_COUNT);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — switch every content-mode radio group to "note" so the note-mode inputs (the
      // in-card recurring form and the opened PlanEntryRow) are ALSO measured. The recipe-mode
      // selects were measured in phase 1, so switching away from them here is a state
      // transition, not a loss.
      for (const radio of screen.getAllByRole("radio", { name: "Free text" })) {
        fireEvent.click(radio);
      }
      await screen.findAllByPlaceholderText("Free text");

      expect(countInteractiveControls(document.body)).toBe(PHASE_2_COUNT);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — SC-003: an open ConfirmDialog, portalled by Radix to document.body, OUTSIDE
      // the rendering surface. The recipe's Delete button only renders outside its own edit mode,
      // so cancel back out of it first.
      await openTab("Recipes");
      fireEvent.click(within(recipe).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByTestId("meals-recipe-edit-name")).toBeNull());

      fireEvent.click(within(recipe).getByRole("button", { name: "Delete" }));
      await screen.findByRole("dialog");

      expect(countInteractiveControls(document.body)).toBe(PHASE_3_COUNT);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 4 — the week grid's entry dialog, opened from an empty cell and switched to
      // "Every <weekday>" so the Repeat pills and the plan select are measured too.
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await openTab("Preview");
      fireEvent.click(screen.getAllByRole("button", { name: /^Add breakfast on/ })[0]);
      const entryDialog = await screen.findByRole("dialog");
      fireEvent.click(within(entryDialog).getByRole("radio", { name: /^Every / }));
      await within(entryDialog).findByRole("combobox", { name: "Meal Plan" });

      expect(countInteractiveControls(document.body)).toBe(PHASE_4_COUNT);
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
      await openTab("Recipes");
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

  it("announces the week-menu load failure and Retry reloads it", async () => {
    let weekFails = true;
    mockBackend({ weekMenu: () => (weekFails ? json(null, 500) : json(emptyWeek())) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load the week menu.");

    weekFails = false;
    fireEvent.click(screen.getByTestId("meals-week-retry"));
    await waitFor(() => expect(screen.queryByTestId("meals-week-retry")).toBeNull());
    expect(screen.getByTestId("meal-plan-grid")).toBeInTheDocument();
    expect(screen.getByTestId("meal-day-heading-2026-01-12")).toBeInTheDocument();
  });

  it("retries the plan list after a load failure", async () => {
    let plansFail = true;
    mockBackend({ plans: () => (plansFail ? json(null, 500) : json([PLAN])) });
    renderSurface();

    expect(await screen.findByText("Failed to load meal plans.")).toBeInTheDocument();
    plansFail = false;
    fireEvent.click(screen.getByTestId("meals-plans-retry"));
    expect(await screen.findByTestId("meals-plan-card")).toBeInTheDocument();
  });

  it("retries the recipe list after a load failure", async () => {
    let recipesFail = true;
    mockBackend({ recipes: () => (recipesFail ? json(null, 500) : json([RECIPE])) });
    renderSurface();
    await openTab("Recipes");

    expect(await screen.findByText("Failed to load meals data.")).toBeInTheDocument();
    recipesFail = false;
    fireEvent.click(screen.getByTestId("meals-recipes-retry"));
    expect(await screen.findByRole("heading", { name: RECIPE.name })).toBeInTheDocument();
    expect(screen.queryByTestId("meals-recipes-retry")).toBeNull();
  });

  it("announces the meal-plans load failure", async () => {
    mockBackend({ plans: () => json(null, 500) });
    renderSurface();
    await openTab("Meal plans");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load meal plans.");
  });

  it("announces the week-menu load failure", async () => {
    mockBackend({ weekMenu: () => json(null, 500) });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load the week menu.");
  });

  it("announces a plan's entries-load failure inside its card, and the card's Retry reloads it", async () => {
    let entriesFail = true;
    mockBackend({
      planEntries: () => (entriesFail ? json(null, 500) : json([RECURRING_ENTRY])),
    });
    renderSurface();
    await openTab("Meal plans");

    await screen.findByTestId("meals-plan-card");
    const alert = await within(planCard()).findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update plan entries.");

    entriesFail = false;
    fireEvent.click(within(planCard()).getByTestId("meals-plan-entries-retry"));
    expect(await screen.findByTestId("meals-plan-entry-row")).toBeInTheDocument();
  });
});

describe("MealsManagement — ConfirmDialog replaces window.confirm for recipe/entry deletion", () => {
  it("does not delete the recipe until the ConfirmDialog is confirmed, and deletes on confirm", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await openTab("Recipes");

    await screen.findByRole("heading", { name: RECIPE.name });
    fireEvent.click(within(recipeCard()).getByRole("button", { name: "Delete" }));

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
    fireEvent.click(within(recipeCard()).getByRole("button", { name: "Delete" }));
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
    await openTab("Meal plans");

    await screen.findByTestId("meals-plan-card");
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
  it("labels the recurring-entry slot select with each slot's own name, in slot order", async () => {
    mockBackend();
    renderSurface();
    await openTab("Recipes");

    await screen.findByRole("heading", { name: RECIPE.name });
    await openTab("Meal plans");
    fireEvent.click(await screen.findByTestId("meals-plan-add-recurring"));

    const slotSelect = screen.getByTestId("meals-recurring-slot-select") as HTMLSelectElement;
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
  it("labels the recurring-entry weekday radios with each weekday's own translated name, in canonical order, under a non-English household locale", async () => {
    // Rendered in Spanish, not English: this is what actually falsifies a `weekdayLabels` call
    // site that swapped a `t(WEEKDAY_LABEL_KEYS.mon)` lookup for the English literal "Monday" —
    // in English that mutant would still read wrong ("Monday" vs the real "Mon"), but only a
    // non-English render proves the label is coming from the i18n catalogue at all rather than
    // being coincidentally reproduced by a hardcoded fallback.
    mockBackend({ settings: () => json({ locale: { timezone: "UTC", language: "es" } }) });
    renderSurface();

    fireEvent.click(await screen.findByRole("tab", { name: "Recetas" }));
    await screen.findByRole("heading", { name: RECIPE.name });
    await screen.findByTestId("meals-plan-card");

    fireEvent.click(screen.getByRole("tab", { name: "Planes de comidas" }));
    fireEvent.click(screen.getByTestId("meals-plan-add-recurring"));
    const weekdayGroup = (await screen.findByTestId("meals-recurring-weekday-mon")).closest(
      '[role="radiogroup"]'
    ) as HTMLElement;
    const radios = within(weekdayGroup).getAllByRole("radio");
    // Deliberately order-and-content, not a set comparison — same rationale as the slot
    // assertion above: a mon<->tue swap in WEEKDAY_LABEL_KEYS preserves the SET of labels while
    // breaking which weekday gets which one.
    const expected = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
    expect(radios).toHaveLength(expected.length);
    radios.forEach((radio, index) => expect(radio).toHaveAccessibleName(expected[index]));
  });
});

describe("MealsManagement — recipe-create textareas keep their explicit label association (Codex, independent review on PR #760)", () => {
  it("gives the ingredients and instructions textareas their own accessible name", async () => {
    mockBackend();
    renderSurface();
    await openTab("Recipes");

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
    await openTab("Recipes");

    await screen.findByRole("heading", { name: RECIPE.name });
    fireEvent.click(within(recipeCard()).getByRole("button", { name: "Edit" }));
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
  it("names the grid-dialog, plan-rename, plan-entry and recurring recipe/name controls", async () => {
    mockBackend();
    renderSurface();
    await openTab("Recipes");

    await screen.findByRole("heading", { name: RECIPE.name });
    await screen.findByTestId("meals-plan-card");

    // The in-card recurring form's recipe picker (default content mode), once the form is open.
    await openTab("Meal plans");
    fireEvent.click(screen.getByTestId("meals-plan-add-recurring"));
    expect(screen.getByTestId("meals-recurring-recipe-select")).toHaveAccessibleName("Recipe");

    // The plan-rename input, reached via the plan card's OWN "Edit" button — the first "Edit"
    // inside the card (the entry row's follows it).
    fireEvent.click(within(planCard()).getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByTestId("meals-plan-rename-input")).toHaveAccessibleName("Plan name");

    // PlanEntryRow's recipe picker, opened for edit (recipe-mode by default, since
    // RECURRING_ENTRY carries a recipeId).
    const entryRow = await screen.findByTestId("meals-plan-entry-row");
    fireEvent.click(within(entryRow).getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("meals-plan-entry-recipe-select")).toHaveAccessibleName("Recipe");

    // The week grid's entry dialog recipe picker, opened from an empty cell.
    await openTab("Preview");
    fireEvent.click(screen.getAllByRole("button", { name: /^Add dinner on/ })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Recipe" })).toBeInTheDocument();
  });
});

describe("MealsManagement — adopts the AdminPanel L2 frame (M20, independent review on PR #760; heading half retrofitted by c)", () => {
  it("wraps the surface in a landmark region labelled by its own title, with a heading of the same name", async () => {
    mockBackend();
    renderSurface();
    await openTab("Recipes");

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
    // The heading equals the sidebar label ("Meals").
    expect(screen.getByRole("region", { name: "Meals" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Meals" })).toBeInTheDocument();
  });
});

describe("MealsManagement — accessible names (MEDIUM-b, MEDIUM-c)", () => {
  it("gives the recurring-entry weekday radios their own accessible group name", async () => {
    mockBackend();
    renderSurface();
    await openTab("Recipes");

    await screen.findByRole("heading", { name: RECIPE.name });
    await openTab("Meal plans");
    fireEvent.click(await screen.findByTestId("meals-plan-add-recurring"));

    expect(screen.getByRole("radiogroup", { name: "Weekday" })).toBeInTheDocument();
    expect(screen.getByTestId("meals-recurring-weekday-mon")).toHaveAttribute("type", "radio");
  });

  it("gives the recipe-create slots fieldset its accessible group name", async () => {
    mockBackend();
    renderSurface();
    await openTab("Recipes");

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
    await openTab("Meal plans");

    await screen.findAllByTestId("meals-plan-card");
    const toggle = screen.getByRole("button", { name: PLAN.name });

    expect(toggle).toHaveAccessibleName(PLAN.name);
    expect(toggle).toHaveTextContent("Deactivate");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("gives an inactive plan's toggle just its OWN name — not appended with a state word — action-shaped visible text, and aria-pressed=false", async () => {
    mockBackend({ plans: () => json([PLAN, INACTIVE_PLAN]) });
    renderSurface();
    await openTab("Meal plans");

    await screen.findAllByTestId("meals-plan-card");
    const toggle = screen.getByRole("button", { name: INACTIVE_PLAN.name });

    expect(toggle).toHaveAccessibleName(INACTIVE_PLAN.name);
    expect(toggle).toHaveTextContent("Activate");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

describe("MealsManagement — each plan card contains its recurring entries", () => {
  it("lists a plan's entries without a toggle, grouped by weekday", async () => {
    mockBackend();
    renderSurface();
    await openTab("Meal plans");

    const entries = await screen.findByTestId("meals-plan-entries-p1");
    expect(await within(entries).findByText("Lentil Soup")).toBeInTheDocument();
    expect(within(entries).getByRole("heading", { name: "Mon" })).toBeInTheDocument();
    expect(screen.queryByTestId("meals-plan-toggle-entries")).toBeNull();
  });

  it("orders weekday groups and slots inside the card (week-start order, then slot order)", async () => {
    mockBackend({
      planEntries: () =>
        json([
          {
            ...RECURRING_ENTRY,
            id: "e3",
            weekday: "sun",
            slot: "breakfast",
            note: "Sunday brunch",
            recipeId: null,
          },
          {
            ...RECURRING_ENTRY,
            id: "e2",
            weekday: "mon",
            slot: "dinner",
            note: "Mon dinner",
            recipeId: null,
          },
          {
            ...RECURRING_ENTRY,
            id: "e1",
            weekday: "mon",
            slot: "breakfast",
            note: "Mon breakfast",
            recipeId: null,
          },
        ]),
    });
    renderSurface();

    const entries = await screen.findByTestId("meals-plan-entries-p1");
    await within(entries).findByText("Sunday brunch");
    const rows = within(entries).getAllByTestId("meals-plan-entry-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Mon breakfast"),
      expect.stringContaining("Mon dinner"),
      expect.stringContaining("Sunday brunch"),
    ]);
  });

  it("shows the inactive hint on an inactive plan only", async () => {
    mockBackend({ plans: () => json([PLAN, INACTIVE_PLAN]) });
    renderSurface();

    await screen.findAllByTestId("meals-plan-card");
    expect(
      screen.getAllByText("Inactive: these meals don't appear in the week menu.")
    ).toHaveLength(1);
    // An inactive plan still lists (and can edit) its entries.
    expect(await screen.findByTestId("meals-plan-entries-p2")).toBeInTheDocument();
  });
});

describe("MealsManagement — writes keep the week grid and plan cards coherent", () => {
  function calls(
    mockFetch: ReturnType<typeof mockBackend>,
    match: (url: string, method: string) => boolean
  ) {
    return (mockFetch.mock.calls as FetchCall[]).filter(([input, init]) =>
      match(String(input), init?.method ?? "GET")
    );
  }

  it("re-reads the week menu after a plan is deactivated", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    await screen.findByTestId("meal-plan-grid");
    const weekReads = calls(mockFetch, (url) => url.startsWith("/api/menu/week")).length;
    await openTab("Meal plans");
    fireEvent.click(await screen.findByRole("button", { name: PLAN.name }));

    await waitFor(() =>
      expect(
        calls(mockFetch, (url, method) => url === "/api/meal-plans/p1" && method === "PATCH")
      ).toHaveLength(1)
    );
    const [, init] = calls(
      mockFetch,
      (url, method) => url === "/api/meal-plans/p1" && method === "PATCH"
    )[0];
    expect(JSON.parse(init!.body as string)).toEqual({ active: false });
    await waitFor(() =>
      expect(calls(mockFetch, (url) => url.startsWith("/api/menu/week")).length).toBeGreaterThan(
        weekReads
      )
    );
  });

  it("keeps a plan's entries visible with an error when saving one fails", async () => {
    mockBackend({ write: () => json(null, 500) });
    renderSurface();
    await openTab("Meal plans");

    const entryRow = await screen.findByTestId("meals-plan-entry-row");
    fireEvent.click(within(entryRow).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(entryRow).getByRole("button", { name: "Save" }));

    const alert = await within(planCard()).findByRole("alert");
    expect(alert).toHaveTextContent("Failed to update plan entries.");
    // A write failure is not a load failure: the list stays, with no Retry.
    expect(screen.getByTestId("meals-plan-entry-row")).toBeInTheDocument();
    expect(screen.queryByTestId("meals-plan-entries-retry")).toBeNull();
  });

  it("shows a failed week-grid write inside the dialog, not as a page error", async () => {
    mockBackend({ write: () => json(null, 500) });
    renderSurface();

    await screen.findByTestId("meal-day-heading-2026-01-12");
    fireEvent.click(screen.getAllByRole("button", { name: /^Add dinner on/ })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Free text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Free text" }), {
      target: { value: "Soup" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Entry" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Failed to add entry.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps an entry edit open in one plan card while another card adds a recurring entry", async () => {
    // A real network round trip: each card's entries arrive a macrotask later, so a refetch
    // renders its loading state (an instantly resolved mock would batch it away).
    const mockFetch = mockBackend({
      plans: () => json([PLAN, INACTIVE_PLAN]),
      planEntries: () =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(json([RECURRING_ENTRY])), 20)),
    });
    const firstCardReads = () =>
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([input]) => String(input) === "/api/meal-plans/p1/entries"
      ).length;
    renderSurface();
    await openTab("Meal plans");

    const cards = await screen.findAllByTestId("meals-plan-card");
    const firstRow = await within(cards[0]).findByTestId("meals-plan-entry-row");
    fireEvent.click(within(firstRow).getByRole("button", { name: "Edit" }));
    expect(within(cards[0]).getByTestId("meals-plan-entry-recipe-select")).toBeInTheDocument();

    // The second card's own form adds a recurring note, which refreshes every card.
    fireEvent.click(within(cards[1]).getByTestId("meals-plan-add-recurring"));
    fireEvent.click(within(cards[1]).getByRole("radio", { name: "Free text" }));
    fireEvent.change(within(cards[1]).getByTestId("meals-recurring-note-input"), {
      target: { value: "Pancakes" },
    });
    fireEvent.click(within(cards[1]).getByRole("button", { name: "Add Recurring Entry" }));
    await waitFor(() =>
      expect(within(cards[1]).queryByTestId("meals-recurring-note-input")).toBeNull()
    );

    // The first card refetches; that must not unmount its rows (and their edit drafts).
    await waitFor(() => expect(firstCardReads()).toBe(2));
    await waitFor(() => expect(within(cards[0]).queryByText("Loading…")).toBeNull());
    expect(within(cards[0]).getByTestId("meals-plan-entry-recipe-select")).toBeInTheDocument();
  });

  it("shows a failed recurring add inside its plan card, next to the form", async () => {
    mockBackend({ write: () => json(null, 500) });
    renderSurface();
    await openTab("Meal plans");

    fireEvent.click(await screen.findByTestId("meals-plan-add-recurring"));
    fireEvent.click(within(planCard()).getByRole("radio", { name: "Free text" }));
    fireEvent.change(within(planCard()).getByTestId("meals-recurring-note-input"), {
      target: { value: "Pancakes" },
    });
    fireEvent.click(within(planCard()).getByRole("button", { name: "Add Recurring Entry" }));

    expect(await within(planCard()).findByRole("alert")).toHaveTextContent("Failed to add entry.");
    // The form stays open with the typed note.
    expect(within(planCard()).getByTestId("meals-recurring-note-input")).toHaveValue("Pancakes");
  });
});

describe("MealsManagement — tabs and origins", () => {
  it("opens on Preview and switches tabs without losing an open edit", async () => {
    mockBackend();
    renderSurface();
    const preview = await screen.findByRole("tab", { name: "Preview" });
    expect(preview).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { level: 2, name: "Meals" })).toBeInTheDocument();
    expect(screen.getByTestId("meal-plan-grid")).toBeVisible();
    expect(await screen.findByTestId("meals-plan-card")).not.toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Recipes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByTestId("meals-recipe-edit-name"), {
      target: { value: "Half typed" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Meal plans" }));
    expect(screen.getByRole("tab", { name: "Meal plans" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(await screen.findByTestId("meals-plan-card")).toBeVisible();
    expect(screen.getByTestId("meals-recipe-edit-name")).not.toBeVisible();
    fireEvent.click(within(planCard()).getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(await screen.findByTestId("meals-plan-rename-input"), {
      target: { value: "Renamed half" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Recipes" }));
    expect(screen.getByTestId("meals-recipe-edit-name")).toHaveValue("Half typed");
    fireEvent.click(screen.getByRole("tab", { name: "Meal plans" }));
    expect(screen.getByTestId("meals-plan-rename-input")).toHaveValue("Renamed half");
  });

  it("preselects the only selected plan pill when adding from a cell", async () => {
    mockBackend();
    renderSurface();
    const pills = await screen.findByRole("group", { name: "Show where meals come from" });
    fireEvent.click(await within(pills).findByRole("checkbox", { name: PLAN.name }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Add breakfast on/ })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /^Every / })).toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: "Meal Plan" })).toHaveValue(PLAN.id);
  });

  it("adds a one-off by default when the One-off pill is selected", async () => {
    mockBackend();
    renderSurface();
    const pills = await screen.findByRole("group", { name: "Show where meals come from" });
    await within(pills).findByRole("checkbox", { name: PLAN.name });
    fireEvent.click(within(pills).getByRole("checkbox", { name: "One-off" }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Add breakfast on/ })[0]);
    expect(
      within(await screen.findByRole("dialog")).getByRole("radio", { name: "Only this date" })
    ).toBeChecked();
  });

  it("drops a plan's highlight when the plan is deactivated", async () => {
    let plans = [PLAN];
    mockBackend({ plans: () => json(plans) });
    renderSurface();
    const pills = await screen.findByRole("group", { name: "Show where meals come from" });
    fireEvent.click(await within(pills).findByRole("checkbox", { name: PLAN.name }));
    plans = [{ ...PLAN, active: false }];
    fireEvent.click(screen.getByRole("tab", { name: "Meal plans" }));
    fireEvent.click(
      within(await screen.findByTestId("meals-plan-card")).getByRole("button", {
        name: PLAN.name,
        pressed: true,
      })
    );
    await waitFor(() =>
      expect(within(pills).queryByRole("checkbox", { name: PLAN.name })).toBeNull()
    );
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Add breakfast on/ })[0]);
    expect(
      within(await screen.findByRole("dialog")).getByRole("radio", { name: "Only this date" })
    ).toBeChecked();
  });
});
