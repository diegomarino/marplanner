# Admin Meals polish: editable week menu, plans with their recurring entries

Date: 2026-10-15. Status: approved by delegation. The owner waived review, so the decisions below bind the executor. Slug: `meals-polish`. Page: `/admin/meals` (`src/client/admin/MealsManagement.tsx`).

## Intent (from the owner)

1. The admin "week menu" must be **editable** in admin. It must not be read-only and it must not be removed.
2. Meal plans and their recurring entries belong together. Show each plan with its recurring entries inside it, not as separate, unrelated sections.

Round-1 cross-cutting rules apply: the heading equals the sidebar label, load errors get a Retry button, ConfirmDialog instead of `window.confirm`, i18n goes in one `// admin-meals-polish` block per locale, shared pills come from `@/ui`, `docs/ui/household-contract.md` stays in sync, and the inventory is resynced. This page was not part of round 1 (it has no reference counterpart), so this design was read fresh from the code.

## Current state (verified at `feat/admin-parity`)

`MealsManagement.tsx` (1690 lines) stacks six sections in this order:

1. **Recipes**: search, create form, cards with edit and delete. Delete fetches `/dependents` and confirms through ConfirmDialog.
2. **Add One-off Entry** (`EntryAuthoringForm`): date, slot select, recipe/note radio, recipe select or note input.
3. **Menu** (`DayMenuView`): a read-only list for one date, with a slot filter.
4. **Meal Plans** (`MealPlanManagement` / `MealPlanCard`): create, rename, an activate/deactivate `StatusToggle`, and a "Show Entries" toggle that expands `PlanEntriesPanel`. The panel reads `GET /api/meal-plans/:id/entries` (inactive plans included) and has `PlanEntryRow`s with content-only edit and a ConfirmDialog delete.
5. **Add Recurring Entry** (`RecurringEntryAuthoringForm`): a separate form with a plan select, `WeekdayPicker mode="single"` (native select), slot, and content.
6. **Week Menu** (`WeekMenuView`): a read-only `<table data-testid="meals-week-grid">` from `GET /api/menu/week?date=`, with a "Week of" date input.

The page reads `/api/settings` itself to compute the household "today", with a pre-ready Retry. The heading is `meals.management.title` ("Meals Management"), but the sidebar label is `admin.sidebar.meals` ("Meals").

The family Meals workspace (`src/client/meals/`) already edits the week:

- `MealPlanGrid` draws 7 dates × 4 slots, with prev / Today / next navigation and a `h1` date-range title.
- `MealCell`: an empty cell is an add button; each item is a card button that opens it.
- `MealEntryDialog`:
  - Create always makes a `oneoff` for `(date, slot)`.
  - Edit PATCHes content only (`recipeId` xor `note`) for either kind, and shows `meals.entries.recurringWarning` ("This changes every matching week.") for a recurring item.
  - Delete confirms through ConfirmDialog, with the same warning for recurring items.
  - A tombstone item cannot be edited.
- `useMealsWorkspace` wires this to `POST /api/meal-entries`, `PATCH|DELETE /api/meal-entries/:id` and `GET /api/menu/week`, and dispatches `MEALS_CHANGED_EVENT` after writes.

`MenuItem` = `{ entryId, slot, label, isTombstone, source: "recurring"|"oneoff", recipeId, note }`. It carries no `mealPlanId`.

Domain rules that constrain the UI (`docs/features/meals-recipes.md`):

- FR-003/FR-017: the menu is the on-read union of active-plan recurring entries for the weekday plus one-offs for the date. Nothing is materialized.
- FR-005/FR-018: there is no per-date skip. Editing a recurring entry changes every matching weekday. A non-recurring meal is a one-off.
- FR-001/FR-015: adds are additive.
- `MealEntryEditInput` is content-only. Moving an entry means deleting it and adding it again.

## Decisions

**D1 — One editable week grid replaces three sections.** The admin renders the family `MealPlanGrid` + `MealEntryDialog` (the same components, endpoints and payloads) as its "Week Menu". The read-only `WeekMenuView` table, the read-only `DayMenuView` and the standalone `EntryAuthoringForm` are removed. They are redundant once a cell can be clicked to add a one-off and every visible meal can be opened to edit or delete it. The "Week of" date input is replaced by the grid's prev / Today / next navigation (the same as the family board).

**D2 — Entry kinds when editing from the grid (FR-017 safe).**

- Click an empty cell or "+": this creates an entry for that `(date, slot)`. The default is a **one-off** (`kind: "oneoff", date, slot`), exactly as on the family board.
- In admin only, the create dialog adds a **Repeat** choice: `ChoicePills` with "Only this date" | "Every <weekday>". Choosing weekly reveals a meal-plan select (active plans only, preselected when exactly one is active) and creates `kind: "recurring", mealPlanId, weekday: weekdayOf(date), slot, content`.
  - If no plan is active, the weekly option is disabled and a hint explains why.
  - No occurrence rows are ever written. The grid simply re-reads `/api/menu/week`.
- Click a meal: this edits that entry's content in place via `PATCH /api/meal-entries/:entryId`, whatever its kind. A recurring item shows the existing "This changes every matching week." note, because FR-005 has no single-date override. Delete works the same way. Changing an entry's kind (recurring ↔ one-off) is not offered: the API has no such edit, and delete plus re-add covers it.
- This is done by giving `MealEntryDialog` one optional prop, `plans?: MealPlan[]`. When the prop is absent (the family board), the dialog renders and behaves exactly as today.
- Weekday derivation uses the shared `weekdayOf` (`src/shared/householdTime.ts`). It is timezone-invariant for a calendar date.

**D3 — Week state stays in `MealsManagement`; the hook is not used.** The admin already owns its household "today" read (with Retry), its recipes list (with search) and its plans. `useMealsWorkspace` would add a second `/api/recipes` fetch and make the page depend on `HouseholdSettingsProvider` for the week to load. So the admin keeps its `weekAnchorDate` / `weekMenu` state and adds:

- prev / next (`addCalendarDays(anchor, ±7)` from `@/calendar/calendar-presentation`) and Today;
- a generation guard so a slow earlier week cannot overwrite a newer one (mirroring the hook);
- create/edit/delete entry handlers that call the same endpoints, then refresh the week, bump `planEntriesRefreshToken` (a recurring write must show up in the plan cards), and dispatch `MEALS_CHANGED_EVENT`.

`weekDates` = `Object.keys(weekMenu)`. When the payload is empty, it falls back to `buildWeekDays(anchor, weekStartDay === 0 ? 0 : 1)` with `useHouseholdSettings().weekStartDay`.

**D4 — `MealPlanGrid` heading level.** Add an optional prop, `titleAs?: "h1" | "h3"` (default `"h1"`). The family board is unchanged. The admin passes `"h3"`, because the page already has its `h2` panel heading. This is the only change to `MealPlanGrid`.

**D5 — Plans contain their recurring entries.** Each `MealPlanCard` always shows its entries; the Show/Hide toggle and `expandedPlanId` are removed.

- **Card header:** name, Active/Inactive badge, Edit (rename), the activate/deactivate `StatusToggle`.
- **Inactive hint:** an inactive plan shows "Inactive: these meals don't appear in the week menu."
- **Entry list:** entries are grouped by weekday in the household display order (`weekdayDisplayOrder(useHouseholdSettings().weekStartDay)`). Within a day they are sorted by slot order (breakfast, lunch, snack, dinner) and then `createdAt`. Each row keeps its edit (content-only) and ConfirmDialog delete.
- **Add form inside the card:** an "Add recurring entry" form, which is `RecurringEntryAuthoringForm` with the plan fixed and the plan select removed. It has:
  - the weekday as `WeekdayPicker mode="single" renderAs="radio"` (shared pills, one line, week-start order);
  - the slot select;
  - the recipe/note mode;
  - the recipe select or note input.

  The form is collapsed behind an "Add recurring entry" button so that cards stay compact.

- **Loading:** each card fetches `GET /api/meal-plans/:id/entries` on mount. A load failure shows ErrorNotice plus Retry inside that card.
- **Removed:** the standalone "Add Recurring Entry" section is gone.

**D6 — Page order and heading.**

1. Week Menu (with one hint line: "Click a cell to add a meal, or a meal to edit it. Changes to a recurring meal apply every week.").
2. Meal Plans.
3. Recipes (unchanged apart from the Retry described in D7).

The `AdminPanel` title becomes `t("admin.sidebar.meals")` ("Meals" / "Comidas"), the same pattern as Daily Briefing. The `meals.management.title` and `admin.nav.mealsManagement` keys stay, because `meals-i18n-parity.test.ts` pins them.

**D7 — Retry on load errors.**

- Settings: the existing Retry is kept.
- Recipes: Retry reloads the current search.
- Plans: Retry calls `loadPlans`.
- Week: Retry calls `loadWeekMenu`.
- Plan entries: per-card Retry.

The existing message keys are reused (`meals.management.retry` / `meals.week.retry`).

**D8 — Not changed:** recipe create/edit/delete (including the `CheckboxField` slot checkboxes and the RadioField content mode), the plan create form, the backend, OpenAPI, `docs/features/meals-recipes.md` (this is a UI-only change that follows FR-003/005/017/018), the family board's behaviour, and `useMealsWorkspace`.

## i18n (new keys, `// admin-meals-polish` block in en and es)

| Key                                | en                                                                                              | es                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `meals.week.editHint`              | Click a cell to add a meal, or a meal to edit it. Changes to a recurring meal apply every week. | Pulsa una celda para añadir una comida, o una comida para editarla. Los cambios en una comida recurrente se aplican todas las semanas. |
| `meals.entries.repeatLabel`        | Repeat                                                                                          | Repetir                                                                                                                                |
| `meals.entries.repeatOnce`         | Only this date                                                                                  | Solo esta fecha                                                                                                                        |
| `meals.entries.repeatWeeklyPrefix` | Every                                                                                           | Cada                                                                                                                                   |
| `meals.entries.repeatNoActivePlan` | Activate a meal plan to repeat this meal every week.                                            | Activa un plan de comidas para repetir esta comida cada semana.                                                                        |
| `meals.plan.entriesTitle`          | Every week                                                                                      | Cada semana                                                                                                                            |
| `meals.plan.inactiveHint`          | Inactive: these meals don't appear in the week menu.                                            | Inactivo: estas comidas no aparecen en el menú semanal.                                                                                |
| `meals.plan.addRecurring`          | Add recurring entry                                                                             | Añadir entrada recurrente                                                                                                              |

The weekly option's label is `${t("meals.entries.repeatWeeklyPrefix")} ${weekdayName}`, where `weekdayName` is `Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" })` of the target date. The i18n `t()` has no interpolation, so the label is concatenated the same way `MealCell` builds its labels.

Keys that become unused after the removals stay in the catalog. Do not delete them, because the parity test and other workers' blocks share the file. The only exception: if `check:standard` has an unused-key check that fails, delete just those keys and record that in the report.

## Testing

**Unit tests (vitest)**, updated or added:

- `tests/client/meal-entry-dialog.test.tsx`: add cases for the `plans` prop.
  - Without `plans`, no Repeat group is rendered (the family is unchanged).
  - With an active plan, choosing "Every <weekday>" posts `{kind:"recurring", mealPlanId, weekday, slot, note}` with the weekday derived from the date.
  - With no active plan, the weekly option is disabled and the hint is shown.
  - Editing a recurring item shows no Repeat group.
- `tests/client/meals-board.test.tsx`: add one `MealPlanGrid` case: `titleAs="h3"` renders the range as `h3`, and the default stays `h1`.
- `tests/client/meals-management.test.tsx`:
  - Heading/region "Meals".
  - Recompute the density census counts.
  - Replace the day-menu error test with "announces the week-menu load failure, and Retry reloads".
  - Plan entries are visible without a toggle.
  - The plan-card recurring form uses weekday radios.
  - Replace the `meals-entry-recipe-select` / `meals-recurring-recipe-select` naming assertions with their new locations: the dialog recipe select, and the in-card form recipe select.
- `tests/client/meals-view-refresh-coherence.test.tsx`:
  - The one-off is added through the grid cell and dialog.
  - The recipe-delete cascade is reflected in the grid (`meal-plan-grid`) and in the card.
  - A recurring entry added through the in-card form appears in the card.
  - New: a recurring entry added from the grid dialog appears in the plan card.
- `tests/client/meals-all-slot-picker.test.tsx`: drive the in-card recurring form's slot select (or the dialog for each slot cell). An unslotted recipe must appear for every slot.
- `tests/client/meals-household-timezone-error-retry.test.tsx` and `tests/client/admin-household-timezone-defaults.test.tsx`: assert the household today through the week request URL (`/api/menu/week?date=<today>`) and/or `meal-day-heading-<today>`, instead of the removed date inputs.

**End-to-end (Playwright):**

- `tests/e2e/admin-household-timezone-defaults.spec.ts`: replace the three date-input assertions with `meal-day-heading-${HOUSEHOLD_TODAY}` visible.
- New `tests/e2e/admin-meals.spec.ts`. It creates a uniquely named plan through the API and opens `/admin/meals`, then:
  1. adds a one-off note via today's dinner cell, which shows in the grid;
  2. adds a weekly note to the plan via the lunch cell dialog, which shows in the grid **and** inside the plan card under today's weekday;
  3. edits the weekly note from the grid, which updates the card;
  4. deletes the one-off from the grid.

  Cleanup deletes the entries and deactivates the plan through the API (plans have no delete).

## Assumptions

- A1: Admin routes render under `HouseholdSettingsProvider` (`src/client/shell/Shell.tsx:222`), so `weekdayDisplayOrder(useHouseholdSettings().weekStartDay)` and `WeekdayPicker` work without props. Unit tests that render `MealsManagement` without a provider fall back to Monday-first.
- A2: The shared-pills wave has merged (`ChoicePills` and the `WeekdayPicker` radio pills from `@/ui`, and `weekdayDisplayOrder`). If its API differs, adapt to the real one and do not duplicate it.
- A3: No backend change is needed. `POST /api/meal-entries` already accepts `kind: "recurring"` with `mealPlanId` + `weekday`.
- A4: Not showing which plan a recurring grid item belongs to is acceptable (`MenuItem` has no `mealPlanId`), because the item's entry is visible in its plan card.
