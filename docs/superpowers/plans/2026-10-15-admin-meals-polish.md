# Admin Meals polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin week menu editable, using the family grid and dialog plus a new admin-only "repeat weekly" option, and show each meal plan with its recurring entries inside it.

**Architecture:** `MealsManagement.tsx` drops three sections: the read-only day menu, the one-off form and the read-only week table. In their place it renders the family `MealPlanGrid` + `MealEntryDialog`, wired to its own week state. `MealEntryDialog` gains one optional `plans` prop that enables creating a recurring entry from a cell. `MealPlanCard` always lists its entries grouped by weekday and holds its own "Add recurring entry" form. The backend is unchanged.

**Tech Stack:** React + TypeScript, Vitest + Testing Library, Playwright, shared UI from `@/ui`.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-meals-polish-design.md`. Read it first. Its decisions D1–D8 are binding; do not reopen them.

**Branch/setup:** work in your own worktree, branched from `main` after the shared-pills wave merged. Copy the spec and this plan into your branch first:

```bash
cp /Users/diego/Dev/marplanner-project/docs/superpowers/specs/2026-10-15-admin-meals-polish-design.md docs/superpowers/specs/
cp /Users/diego/Dev/marplanner-project/docs/superpowers/plans/2026-10-15-admin-meals-polish.md docs/superpowers/plans/
```

Ports for every Playwright run: `PORT=43225 MP_E2E_WEATHER_FIXTURE_PORT=44425 MP_E2E_QUOTE_FIXTURE_PORT=44435`.

## Global Constraints

- If a shared component API (`ChoicePills`, `WeekdayPicker`, `weekdayDisplayOrder`, `MemberPills`) differs from the shared-pills plan when you start, adapt to the real one. Never create a parallel variant, and never import `PillControl` directly.
- Domain rules:
  - The menu is derived on read (FR-003/FR-017). Never write occurrence rows.
  - Editing a recurring entry changes every matching weekday; there is no per-date skip (FR-005/FR-018).
  - An entry carries exactly one of `recipeId` or `note` (FR-002).
- New i18n keys go in one contiguous `// admin-meals-polish` block per locale in `src/client/i18n/messages.ts`, placed after the last existing `// admin-*` block of that locale. Use the exact strings in the spec's i18n table, and do not touch other workers' blocks.
- Heading = sidebar label: `AdminPanel title={t("admin.sidebar.meals")}`.
- ConfirmDialog only (no `window.confirm`), and every load error gets a Retry button.
- Every new interactive control needs a strong accessible name (a visible `<label>`, `Field`, `aria-label` or text) so that `check:accessible-names` (baseline `tools/dev/accessible-names-baseline.txt`, which has no Meals rows) stays green.
- No raw `<input>`; native `<select>` must use `NATIVE_SELECT_CLASSES` from `@/lib/recipes` as the file already does. No new `*_CLASSES` constants, and no inline styles.
- The family board's behaviour must not change: `MealsBoard` passes no `plans`, and `MealPlanGrid`'s default title stays `h1`.

## Review Focus

1. A cell create with "Every <weekday>" for a date in a **Sunday-first** household must post the weekday of that date (`weekdayOf`), not a weekday index shifted by week start. Pinned in Task 1 (2026-09-27 is a Sunday → `"sun"`).
2. A recurring entry created or edited from the grid must appear or update in the plan card without a reload: the plan-entries refresh token is bumped after every grid write. Pinned in Task 4.
3. Clicking prev/next quickly must not let an older, slower week response overwrite the newer one (generation guard). Pinned in Task 3.
4. A plan that is inactive must still list and edit its entries (they are not in the grid), and must show the inactive hint. Pinned in Task 3.
5. A tombstone item opened from the admin grid must not offer Repeat, Save or Delete. This is the existing dialog behaviour; Task 1 asserts that Repeat is absent when editing.

---

### Task 0: Confirm the baseline

- [ ] Confirm the shared-pills wave merged: `grep -n "export function ChoicePills\|export function weekdayDisplayOrder" -r src/client/components`. Also confirm `src/client/ui.ts` re-exports `ChoicePills` and `WeekdayPicker`. If they are missing, stop and report.
- [ ] Read `src/client/admin/MealsManagement.tsx`, `src/client/meals/MealEntryDialog.tsx`, `src/client/meals/MealPlanGrid.tsx` and `src/client/meals/MealCell.tsx`.
- [ ] Find the insertion points: `grep -n "// admin-" src/client/i18n/messages.ts`. Note the last admin block in `en` and in `es`.
- [ ] `npx vitest run tests/client/meal-entry-dialog.test.tsx tests/client/meals-board.test.tsx tests/client/meals-management.test.tsx tests/client/meals-view-refresh-coherence.test.tsx tests/client/meals-all-slot-picker.test.tsx tests/client/meals-household-timezone-error-retry.test.tsx tests/client/admin-household-timezone-defaults.test.tsx tests/client/meals-i18n-parity.test.ts`. Expected: all pass, which is your baseline.

### Task 1: i18n keys + `MealEntryDialog` "Repeat" option

**Files:**

- Modify: `src/client/i18n/messages.ts` (new `// admin-meals-polish` block, en + es)
- Modify: `src/client/meals/MealEntryDialog.tsx`
- Test: `tests/client/meal-entry-dialog.test.tsx`

**Interfaces:**

- Produces: `MealEntryDialogProps.plans?: MealPlan[]`. When it is defined and the dialog is creating (no `target.item`), the dialog shows the Repeat group. `onCreate` receives either `{kind:"oneoff",date,slot,recipeId|note}` or `{kind:"recurring",mealPlanId,weekday,slot,recipeId|note}`.

- [ ] **Step 1: Add the i18n block.** Put it after the last `// admin-*` block of each locale:

```ts
    // admin-meals-polish
    "meals.week.editHint":
      "Click a cell to add a meal, or a meal to edit it. Changes to a recurring meal apply every week.",
    "meals.entries.repeatLabel": "Repeat",
    "meals.entries.repeatOnce": "Only this date",
    "meals.entries.repeatWeeklyPrefix": "Every",
    "meals.entries.repeatNoActivePlan": "Activate a meal plan to repeat this meal every week.",
    "meals.plan.entriesTitle": "Every week",
    "meals.plan.inactiveHint": "Inactive: these meals don't appear in the week menu.",
    "meals.plan.addRecurring": "Add recurring entry",
```

```ts
    // admin-meals-polish
    "meals.week.editHint":
      "Pulsa una celda para añadir una comida, o una comida para editarla. Los cambios en una comida recurrente se aplican todas las semanas.",
    "meals.entries.repeatLabel": "Repetir",
    "meals.entries.repeatOnce": "Solo esta fecha",
    "meals.entries.repeatWeeklyPrefix": "Cada",
    "meals.entries.repeatNoActivePlan": "Activa un plan de comidas para repetir esta comida cada semana.",
    "meals.plan.entriesTitle": "Cada semana",
    "meals.plan.inactiveHint": "Inactivo: estas comidas no aparecen en el menú semanal.",
    "meals.plan.addRecurring": "Añadir entrada recurrente",
```

- [ ] **Step 2: Write the failing tests.** Append to the `describe("MealEntryDialog")` in `tests/client/meal-entry-dialog.test.tsx`, and add `MealPlan` to the type import:

```tsx
const ACTIVE_PLAN: MealPlan = {
  id: "p1",
  name: "Weeknights",
  active: true,
  createdAt: 0,
  updatedAt: 0,
};
const INACTIVE_PLAN: MealPlan = {
  id: "p2",
  name: "Summer",
  active: false,
  createdAt: 0,
  updatedAt: 0,
};

function renderCreate(
  plans: MealPlan[] | undefined,
  onCreate = vi.fn().mockResolvedValue(true),
  date = "2026-09-25"
) {
  render(
    <MealEntryDialog
      open
      target={{ date, slot: "dinner" }}
      recipes={recipes}
      plans={plans}
      onClose={vi.fn()}
      onCreate={onCreate}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  return onCreate;
}

it("shows no Repeat choice without plans (family board unchanged)", () => {
  renderCreate(undefined);
  expect(screen.queryByRole("radiogroup", { name: "Repeat" })).not.toBeInTheDocument();
});

it("creates a recurring entry in the chosen active plan for the date's weekday", async () => {
  const onCreate = renderCreate([ACTIVE_PLAN, INACTIVE_PLAN]);
  const repeat = screen.getByRole("radiogroup", { name: "Repeat" });
  expect(within(repeat).getByRole("radio", { name: "Only this date" })).toBeChecked();
  fireEvent.click(within(repeat).getByRole("radio", { name: "Every Friday" }));
  // Only active plans are offered; the single active one is preselected.
  const planSelect = screen.getByRole("combobox", { name: "Meal Plan" });
  expect(planSelect).toHaveValue("p1");
  expect(within(planSelect).queryByText("Summer")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Note" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
    target: { value: "Pizza night" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      kind: "recurring",
      mealPlanId: "p1",
      weekday: "fri",
      slot: "dinner",
      note: "Pizza night",
    })
  );
});

it("derives the weekday from the date itself, Sunday included", async () => {
  const onCreate = renderCreate([ACTIVE_PLAN], undefined, "2026-09-27");
  fireEvent.click(screen.getByRole("radio", { name: "Every Sunday" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Recipe" }), {
    target: { value: "recipe-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "recurring", weekday: "sun", recipeId: "recipe-1" })
    )
  );
});

it("disables weekly repeat with a hint when no plan is active", () => {
  renderCreate([INACTIVE_PLAN]);
  expect(screen.getByRole("radio", { name: "Every Friday" })).toBeDisabled();
  expect(
    screen.getByText("Activate a meal plan to repeat this meal every week.")
  ).toBeInTheDocument();
});

it("does not offer Repeat when editing an entry", () => {
  render(
    <MealEntryDialog
      open
      target={{
        date: "2026-09-25",
        slot: "dinner",
        item: {
          entryId: "e1",
          slot: "dinner",
          label: "Soup",
          isTombstone: false,
          source: "recurring",
          recipeId: null,
          note: "Soup",
        },
      }}
      recipes={recipes}
      plans={[ACTIVE_PLAN]}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  expect(screen.queryByRole("radiogroup", { name: "Repeat" })).not.toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("This changes every matching week.");
});
```

Add `within` to the testing-library import. The weekday names ("Friday", "Sunday") come from `Intl` in English, because no provider is used. If the real `ChoicePills` disables an option differently (for example, `aria-disabled`), adapt the assertion to it.

- [ ] **Step 3: Run the tests.** `npx vitest run tests/client/meal-entry-dialog.test.tsx`. Expected: the 4 new cases FAIL (no Repeat group); the old cases pass.

- [ ] **Step 4: Implement in `MealEntryDialog.tsx`.**
  - Add the imports: `ChoicePills` from `@/ui` (or its component file if that is how the wave exports it), `weekdayOf` from `../../shared/householdTime`, and `MealPlan` from `../../shared`. Take `language` from `useTranslation()`.
  - Add `plans?: MealPlan[]` to the props.
  - Add the state:

```tsx
const offerRepeat = !editing && plans !== undefined;
const activePlans = useMemo(() => (plans ?? []).filter((plan) => plan.active), [plans]);
const [repeat, setRepeat] = useState<"once" | "weekly">("once");
const [planId, setPlanId] = useState("");
const weekday = weekdayOf(target.date, "UTC");
const weekdayName = new Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" }).format(
  new Date(`${target.date}T12:00:00Z`)
);
```

- In the existing reset `useEffect`, also do `setRepeat("once"); setPlanId(activePlans.length === 1 ? activePlans[0].id : "");`, and add `activePlans` to its dependencies.
- Submit button guard: `disabled={saving || !hasContent || (repeat === "weekly" && !planId)}`.
- In `submit()`, keep the edit branch. For create, build `content = mode === "recipe" ? { recipeId } : { note }` and call either
  `onCreate(repeat === "weekly" ? { kind: "recurring", mealPlanId: planId, weekday, slot: target.slot, ...content } : { kind: "oneoff", date: target.date, slot: target.slot, ...content })`.
- Render the following, only when `offerRepeat`, before the content-mode radios (inside the non-tombstone branch):

```tsx
{
  offerRepeat && (
    <div className="flex flex-col gap-2">
      <ChoicePills
        groupLabel={t("meals.entries.repeatLabel")}
        value={repeat}
        onChange={setRepeat}
        options={[
          { value: "once", label: t("meals.entries.repeatOnce") },
          {
            value: "weekly",
            label: `${t("meals.entries.repeatWeeklyPrefix")} ${weekdayName}`,
            disabled: activePlans.length === 0,
          },
        ]}
      />
      {activePlans.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("meals.entries.repeatNoActivePlan")}</p>
      )}
      {repeat === "weekly" && (
        <Field label={t("meals.plan.selectLabel")}>
          <select
            value={planId}
            onChange={(event) => setPlanId(event.target.value)}
            aria-label={t("meals.plan.selectLabel")}
            className={NATIVE_SELECT_CLASSES}
          >
            <option value="">{t("meals.plan.selectPlaceholder")}</option>
            {activePlans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests.** `npx vitest run tests/client/meal-entry-dialog.test.tsx tests/client/meals-board.test.tsx tests/client/meals-i18n-parity.test.ts`. Expected: PASS. If `meals-i18n-parity` enumerates an explicit key list, add the new `meals.*` keys to it.
- [ ] **Step 6: Format, typecheck and commit.** `npx prettier --write` the 3 files, `npm run typecheck`, then `git commit -m "feat(meals): let the entry dialog repeat a meal weekly in an active plan"`.

### Task 2: `MealPlanGrid` title level

**Files:** Modify `src/client/meals/MealPlanGrid.tsx`; Test `tests/client/meals-board.test.tsx`.

**Interfaces:** Produces `MealPlanGridProps.titleAs?: "h1" | "h3"` (default `"h1"`).

- [ ] **Step 1: Write the failing test** in `meals-board.test.tsx`, after "uses the week range as the main title…". Render `MealPlanGrid` with the same props plus `titleAs="h3"`, then:

```tsx
expect(screen.getByRole("heading", { level: 3, name: "Sep 21 – Sep 27" })).toBeVisible();
expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
```

- [ ] **Step 2:** `npx vitest run tests/client/meals-board.test.tsx`. Expected: the new case FAILS.
- [ ] **Step 3: Implement.** Add `titleAs = "h1"` to the destructured props. Then render
      `{range && (titleAs === "h3" ? <h3 className="text-2xl font-bold tracking-tight">{range}</h3> : <h1 className="text-3xl font-bold tracking-tight">{range}</h1>)}`.
      Use two literal elements, not a dynamic tag, so the lint and audit tools keep parsing them.
- [ ] **Step 4:** Re-run. Expected: PASS. Then run prettier, and `git commit -m "feat(meals): let the meal grid title render below a page heading"`.

### Task 3: `MealsManagement` restructure (editable week, plans with entries, heading, retries)

**Files:** Modify `src/client/admin/MealsManagement.tsx`. Tests: `tests/client/meals-management.test.tsx`, `tests/client/meals-household-timezone-error-retry.test.tsx`, `tests/client/admin-household-timezone-defaults.test.tsx`, `tests/client/meals-all-slot-picker.test.tsx`.

**Interfaces:**

- Consumes: `MealEntryDialog` with `plans` (Task 1), `MealPlanGrid` with `titleAs` (Task 2), `MEALS_CHANGED_EVENT` from `@/meals/useMealsWorkspace`, `addCalendarDays` and `buildWeekDays` from `@/calendar/calendar-presentation`, `weekdayDisplayOrder` and `WeekdayPicker` from `@/ui` (or `@/components/WeekdayPicker`), `useHouseholdSettings` from `@/lib/householdSettings`.
- Produces these test ids (Task 4 and Task 5 rely on them):
  - `meal-plan-grid` and `meal-cell-<date>-<slot>`, which come from the family components;
  - `meals-plan-card` (kept) and `meals-plan-entry-row` (kept);
  - `meals-plan-add-recurring` (button that opens the in-card form);
  - `meals-plan-entries-<planId>` (the card's entry list container);
  - `meals-recurring-weekday-<day>` (radio pills) and `meals-recurring-slot-select`, `meals-recurring-recipe-select`, `meals-recurring-note-input` (the in-card form, kept names);
  - `meals-week-retry`, `meals-plans-retry`, `meals-recipes-retry`, `meals-plan-entries-retry`.

- [ ] **Step 1: Update the tests first** (they must fail against the old page).
  - `meals-management.test.tsx`:
    - The region/heading assertion changes to `"Meals"`.
    - Replace "announces the day-menu load failure" with "announces the week-menu load failure and Retry reloads it". Use `mockBackend({ weekMenu: () => json(null, 500) })`, find the alert text `"Failed to load the week menu."`, then switch the override to succeed and click `getByTestId("meals-week-retry")`; `meal-plan-grid` appears.
    - Add "lists a plan's entries without a toggle, grouped by weekday": `RECURRING_ENTRY` text `"Lentil Soup"` is inside `meals-plan-entries-p1` with no click, and `queryByTestId("meals-plan-toggle-entries")` is null.
    - Add "shows the inactive hint on an inactive plan" (`plans: [PLAN, INACTIVE_PLAN]` → `"Inactive: these meals don't appear in the week menu."` visible once).
    - Add "retries the plan list": `plans` 500 → click `meals-plans-retry` → the card appears.
    - In the #771 naming test, replace the `meals-entry-recipe-select` assertion with: open the in-card form (`meals-plan-add-recurring`), then expect `meals-recurring-recipe-select` named "Recipe". Remove the toggle click and keep the entry-row edit check.
    - The "MEDIUM-b" weekday test becomes: after opening the in-card form, `getByRole("radiogroup", { name: "Weekday" })` exists, and `meals-recurring-weekday-mon` is a radio.
    - The SLOT_LABEL_KEYS test (line ~416) must drive `meals-recurring-slot-select` inside the opened in-card form instead of `meals-entry-slot-select`.
    - The WEEKDAY_LABEL_KEYS test (line ~438) reads the radio names (`Mon`..`Sun`, via `getAllByRole("radio")` inside the Weekday radiogroup) instead of select options. Keep its Spanish branch if it has one.
    - Make `mockBackend`'s default `/api/menu/week` return a 7-day empty week. Add a helper in the test file:

      ```ts
      function emptyWeek(start = "2026-01-12") {
        return Object.fromEntries(
          Array.from({ length: 7 }, (_, i) => {
            const d = new Date(`${start}T12:00:00Z`);
            d.setUTCDate(d.getUTCDate() + i);
            return [
              d.toISOString().slice(0, 10),
              { breakfast: [], lunch: [], snack: [], dinner: [] },
            ];
          })
        );
      }
      ```

      Then route `/api/menu/week` to `json(emptyWeek())` before the generic `/api/menu` branch. The generic branch can stay for safety.

    - The density test: drive the phases through the new structure. Open the in-card form instead of the toggle, and open a `MealEntryDialog` from an empty cell (`getAllByRole("button", { name: /^Add breakfast on/ })[0]`) and switch it to weekly. Then **re-measure and update the census counts**. Do not weaken `assertKioskDensityCompliant`.
  - `meals-household-timezone-error-retry.test.tsx`: replace the `meals-menu-date-input` assertions with a check that the week was requested for the household date: `expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/menu/week?date=2026-01-16"), expect.anything())`. Before Retry, the grid (`meal-plan-grid`) is absent.
  - `admin-household-timezone-defaults.test.tsx` (Meals block): replace the three date-input assertions with the same `"/api/menu/week?date=2026-01-16"` fetch assertion on the stubbed fetch spy. Keep `vi.fn(mockFetch)` in a variable.
  - `meals-all-slot-picker.test.tsx`: give the mock a plan (`/api/meal-plans` → `[{id:"p1",name:"Weeknights",active:true,createdAt:0,updatedAt:0}]`, `/api/meal-plans/p1/entries` → `[]`) and a timezone in settings (`{ locale: { timezone: "UTC", language: "en" } }`). Then click `meals-plan-add-recurring` and loop over `meals-recurring-slot-select` values, asserting "Untagged Recipe" is in `meals-recurring-recipe-select`. Rename the describe to "MealsManagement — recurring-entry all-slot picker (FR-002)" and record the rename for the cohort resync.
- [ ] **Step 2:** `npx vitest run tests/client/meals-management.test.tsx tests/client/meals-household-timezone-error-retry.test.tsx tests/client/admin-household-timezone-defaults.test.tsx tests/client/meals-all-slot-picker.test.tsx`. Expected: the new and changed cases FAIL.
- [ ] **Step 3: Implement the page.** All of it is in `MealsManagement.tsx`.
  - **Remove** `DayMenuView`, `EntryAuthoringForm`, `WeekMenuView`, `createEntry`, `loadMenu`, `viewDate`/`slotFilter`/`menuItems`/`menuLoading`/`menuError`, `expandedPlanId` and the top-level "Add Recurring Entry" section. `refreshMenus()` becomes `loadWeekMenu()`.
  - **Week state.** Add `const weekGeneration = useRef(0);`, `const [todayDate, setTodayDate] = useState("");`, `const [entryTarget, setEntryTarget] = useState<MealEntryTarget | null>(null);` and `const { weekStartDay } = useHouseholdSettings();`. Then:

```tsx
async function loadWeekMenu(anchor = weekAnchorDate) {
  if (!anchor) return;
  const generation = ++weekGeneration.current;
  setWeekLoading(true);
  setWeekError(null);
  try {
    const res = await authFetch(`/api/menu/week?date=${encodeURIComponent(anchor)}`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("Failed to load week menu");
    const next = (await res.json()) as Record<string, Record<Slot, MenuItem[]>>;
    if (generation === weekGeneration.current) setWeekMenu(next);
  } catch {
    if (generation === weekGeneration.current) setWeekError(t("meals.week.error"));
  } finally {
    if (generation === weekGeneration.current) setWeekLoading(false);
  }
}
```

- In `loadHouseholdDate`, set `todayDate` together with `weekAnchorDate`. The existing `useEffect(() => void loadWeekMenu(), [weekAnchorDate])` stays.
- `weekDates`: `Object.keys(weekMenu)`, or, when that is empty and `weekAnchorDate` is set, `buildWeekDays(weekAnchorDate, weekStartDay === 0 ? 0 : 1)`.
- **Entry writes** (one helper; all of them refresh the week, refresh the plan cards and notify the family widgets):

```tsx
async function mutateEntry(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<boolean> {
  try {
    const res = await authFetch(url, {
      method,
      credentials: "include",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status}`);
    await loadWeekMenu();
    setPlanEntriesRefreshToken((n) => n + 1);
    window.dispatchEvent(new Event(MEALS_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}
```

    The dialog shows its own error on `false`, so do not also set the page error here. Also make `createRecurringEntry` (used by the in-card form), the plan-entry `saveEntry`/`removeEntry`, `confirmRecipeDeletion` and `editRecipe` dispatch `MEALS_CHANGED_EVENT` after their refresh.

- **Render order** inside `<AdminPanel title={t("admin.sidebar.meals")} description={t("meals.management.description")}>`:
  1. `ErrorNotice error`. A recipes-load error additionally shows `<Button variant="secondary" data-testid="meals-recipes-retry" onClick={() => void loadRecipes(searchInput)}>{t("meals.management.retry")}</Button>`.
  2. **Week Menu section:** `h3 {t("meals.week.title")}`, then `p.text-muted-foreground.text-sm {t("meals.week.editHint")}`. If `weekError`, show the ErrorNotice and `Button data-testid="meals-week-retry"` (`t("meals.week.retry")`) → `loadWeekMenu()`. Then:

```tsx
<MealPlanGrid
  titleAs="h3"
  weekDates={weekDates}
  weekMenu={weekMenu}
  todayDate={todayDate || null}
  pending={weekLoading}
  onPrevious={() => setWeekAnchorDate((d) => addCalendarDays(d, -7))}
  onCurrent={() => setWeekAnchorDate(todayDate)}
  onNext={() => setWeekAnchorDate((d) => addCalendarDays(d, 7))}
  onAdd={(date, slot) => setEntryTarget({ date, slot })}
  onSelect={(date, item) => setEntryTarget({ date, slot: item.slot, item })}
/>;
{
  entryTarget && (
    <MealEntryDialog
      open
      target={entryTarget}
      recipes={recipes}
      plans={plans}
      onClose={() => setEntryTarget(null)}
      onCreate={(input) => mutateEntry("/api/meal-entries", "POST", input)}
      onEdit={(id, input) =>
        mutateEntry(`/api/meal-entries/${encodeURIComponent(id)}`, "PATCH", input)
      }
      onDelete={(id) => mutateEntry(`/api/meal-entries/${encodeURIComponent(id)}`, "DELETE")}
    />
  );
}
```

       Note: `onCurrent` when the anchor already equals today does not refire the effect. That is fine, because nothing changed.
    3. **Meal Plans section:** `h3 {t("meals.plan.title")}` and `MealPlanManagement`, minus the expanded props, plus `onRetry={loadPlans}` (render `Button data-testid="meals-plans-retry"` under its ErrorNotice when the plans failed to load) and `onCreateRecurring={createRecurringEntry}`.
    4. **Recipes section:** unchanged content (search, `RecipeCreateForm`, `RecipeCard`s).

- **`MealPlanCard`:**
  - Remove the Show/Hide button and `expanded`.
  - Under the header, if `!plan.active`, render `p.text-muted-foreground.text-sm {t("meals.plan.inactiveHint")}`.
  - Then always render `<PlanEntriesPanel …/>` followed by the in-card add form: a `Button variant="outline" data-testid="meals-plan-add-recurring"` labelled `t("meals.plan.addRecurring")` toggles local `adding` state, and the form is `RecurringEntryAuthoringForm` with `mealPlanId={plan.id}` and `onDone={() => setAdding(false)}` after a successful add.
- **`RecurringEntryAuthoringForm`:** replace the `plans` prop and plan select with a fixed `mealPlanId: string` prop. Drop the `plans.length === 0` branch. `canSubmit` no longer checks the plan. Replace the weekday select with:

```tsx
<WeekdayPicker
  mode="single"
  renderAs="radio"
  value={weekday}
  onChange={setWeekday}
  labels={weekdayLabels(t)}
  groupLabel={t("meals.plan.weekdayLabel")}
  testIdPrefix="meals-recurring-weekday"
/>
```

    The content-mode radios' `name` must be unique per card: `meals-recurring-content-mode-${mealPlanId}`.

- **`PlanEntriesPanel`:**
  - Wrap the list in `div data-testid={`meals-plan-entries-${planId}`}` with a small heading `t("meals.plan.entriesTitle")`.
  - Group the entries: `const order = weekdayDisplayOrder(weekStartDay)` (read `useHouseholdSettings()` inside the panel). Sort with `(a, b) => order.indexOf(a.weekday!) - order.indexOf(b.weekday!) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) || a.createdAt - b.createdAt`, then render a `weekdayLabel` sub-heading per weekday that has entries, followed by its `PlanEntryRow`s. In the row's read view, the weekday prefix becomes just the slot label (the weekday is the group heading).
  - On a **load** failure (as opposed to a write failure), render ErrorNotice plus `Button data-testid="meals-plan-entries-retry"` → `load()`. Keep a separate `loadError` and `writeError` so a failed save keeps the list visible.
- Remove the now-unused imports (`DayMenuView`-only ones such as `todayInHouseholdTimezone`, which is still used by `loadHouseholdDate`, so keep it). `npm run lint` will list the dead code.
- [ ] **Step 4:** Re-run the four test files from Step 2. Expected: PASS. Then run the whole meals cohort: `npx vitest run tests/client/meal* tests/client/admin-household-timezone-defaults.test.tsx`.
- [ ] **Step 5:** `npx prettier --write` the changed files, `npm run typecheck && npm run lint`, then `node tools/dev/audit-accessible-names.mjs --strict-weak --check-baseline tools/dev/accessible-names-baseline.txt` (expected: no new rows), then `git commit -m "feat(admin): make the meals week menu editable and show plans with their recurring entries"`.

### Task 4: View-refresh coherence across grid, dialog and plan cards

**Files:** Test `tests/client/meals-view-refresh-coherence.test.tsx`. Fix `MealsManagement.tsx` only if a case exposes a bug.

- [ ] **Step 1: Rewrite the four cases against the new UI.** Keep their titles where the behaviour is the same, so the cohort names stay stable. Make the mock's `/api/menu/week` derive the week from its `entries` state (the file already derives the menu from `entries`; route the week to a 7-day object around `today` built the same way). Then:
  1. "shows a newly-added one-off entry in the week grid without a manual reload": click `getByRole("button", { name: new RegExp(`^Add dinner on`) })` for today's dinner cell (`within(getByTestId(`meal-cell-${today}-dinner`))`). In the dialog, choose the Note radio (`within(getByRole("dialog"))`), type "Weeknight note", and click "Add Entry". The text then appears inside `meal-plan-grid`.
  2. "removes a deleted recipe's entries from the week grid without a manual reload": the same as today but with `meal-plan-grid`. The recipe "Delete" button is in the Recipes section; scope it with `within(screen.getByText("Old Recipe", { selector: "h4" }).closest("div.border")!)`, or use the recipe card's own button order. The grid card button labelled "Old Recipe" disappears.
  3. "shows a newly-added recurring entry in an already-expanded plan panel" → rename it to "shows a newly-added recurring entry in its plan card". Use `meals-plan-add-recurring`, `meals-recurring-weekday-mon` (click), `meals-recurring-slot-select`, the Note radio inside the card, `meals-recurring-note-input` "Oatmeal", and the "Add Recurring Entry" button. "Oatmeal" then appears inside `meals-plan-entries-p1`.
  4. "removes a deleted recipe's cascaded recurring entry from an already-expanded plan panel" → rename it to "…from its plan card". Drop the toggle click.
  5. **New**, "shows a recurring entry added from the week grid in its plan card": open today's lunch cell, click the radio named `Every <today's weekday long name>` (compute it with `new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" })`), keep the preselected plan, choose Note "Soup", and click Add. "Soup" then appears both in `meal-plan-grid` and in `meals-plan-entries-p1`, and the POST body has `kind: "recurring"`, `mealPlanId: "p1"`, and `weekday` equal to the `weekdayOf(today)` code.
  6. **New**, "keeps the newer week when an older week response arrives late": make `/api/menu/week?date=<prev-week anchor>` resolve after a manual deferred, then click "Previous week" followed by "Next week" (back to the current week). Resolve the deferred and assert that the grid headings still show the current week's dates.
- [ ] **Step 2:** `npx vitest run tests/client/meals-view-refresh-coherence.test.tsx`. Expected: PASS. If a case fails, fix the page, not the test.
- [ ] **Step 3:** Run prettier, then `git commit -m "test(meals): pin admin grid, dialog and plan-card refresh coherence"`.

### Task 5: e2e + docs

**Files:** Create `tests/e2e/admin-meals.spec.ts`. Modify `tests/e2e/admin-household-timezone-defaults.spec.ts` and `docs/ui/household-contract.md`.

- [ ] **Step 1:** In `admin-household-timezone-defaults.spec.ts` (lines ~80-82), replace the three date-input assertions with `await expect(page.getByTestId(`meal-day-heading-${HOUSEHOLD_TODAY}`)).toBeVisible();`.
- [ ] **Step 2: Create `tests/e2e/admin-meals.spec.ts`,** modelled on `tests/e2e/admin-routines.spec.ts`: the same access/provision preamble, `unlockAdmin` from `./admin-unlock`, `openAdminSection(page, "admin-nav-meals-management")`, and the `messages`/`resolveLang` lookup `m`. Use a single test, "meals admin: edit the week menu and see recurring entries inside their plan", with a unique `rid`. The steps:
  1. Read `/api/settings` and compute today in `settings.locale.timezone` (copy `todayInTimezone` from `meals.spec.ts`).
  2. `POST /api/meal-plans {name: `E2E plan ${rid}`}` → `planId`.
  3. Open the section and expect the heading `m["admin.sidebar.meals"]`.
  4. In `meal-cell-${today}-dinner`, click the add button. In the dialog, choose the `m["meals.entries.contentModeNote"]` radio, fill the textbox `m["meals.entries.contentModeNote"]` with `One-off ${rid}`, and click `m["meals.entries.action.add"]`. Wait for the POST `/api/meal-entries` response and record the id. Expect the text inside `meal-plan-grid`.
  5. In `meal-cell-${today}-lunch`, click add. In the Repeat group, click the radio whose name starts with `m["meals.entries.repeatWeeklyPrefix"]`. Select the plan `E2E plan ${rid}` in the `m["meals.plan.selectLabel"]` combobox (other active plans may exist in the shared DB), choose Note `Weekly ${rid}`, and click Add. Record the id. Expect the text both in `meal-plan-grid` and inside `meals-plan-entries-${planId}`.
  6. Click the grid card `Weekly ${rid}`, change the note to `Weekly edited ${rid}`, and click `m["meals.action.save"]`. Expect the new text in `meals-plan-entries-${planId}`.
  7. Click the grid card `One-off ${rid}`, click `m["meals.action.delete"]` and confirm it in the ConfirmDialog. Expect the text to be gone from `meal-plan-grid`.
  8. Write `afterEach`/`finally` cleanup: delete the remaining entry ids (accept 204 or 404), then `PATCH /api/meal-plans/${planId} {active:false}` (plans have no delete).
- [ ] **Step 3:** `PORT=43225 MP_E2E_WEATHER_FIXTURE_PORT=44425 MP_E2E_QUOTE_FIXTURE_PORT=44435 npx playwright test tests/e2e/admin-meals.spec.ts tests/e2e/admin-household-timezone-defaults.spec.ts tests/e2e/meals.spec.ts --workers=3`. Expected: PASS. `meals.spec.ts` proves that the family board did not change.
- [ ] **Step 4: Docs.** In `docs/ui/household-contract.md` (the admin list, line ~75), replace `5. `/admin/meals` — meals and recipes` with:
      `5. `/admin/meals` — Meals: editable week menu (the family meal grid; a cell adds a one-off or, via "Every <weekday>", a recurring entry in an active plan; a meal opens for content edit or delete, and recurring changes apply every week), meal plans each listing their recurring entries by weekday with an in-card add form and activate/deactivate, then recipes`.
      Do not change `docs/features/meals-recipes.md` (no FR or contract change).
- [ ] **Step 5:** Run prettier on the changed files, then `git commit -m "test(e2e): cover editing the admin meals week menu and plan entries"`.

### Task 6: Inventory resync (`tests/fixtures/assembly-cohort.json`)

- [ ] `export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs) && npm run test:cohorts:stamp && npm run test:cohorts:vitest:list && npm run test:cohorts:vitest`.
- [ ] `testCohorts.runners.vitest.files`: update the case names for every new or renamed case, exactly as `.quality/vitest-list.json` prints them, in the same join format as the neighbouring entries. The affected files:
  - `tests/client/meal-entry-dialog.test.tsx` (+5)
  - `tests/client/meals-board.test.tsx` (+1)
  - `tests/client/meals-management.test.tsx` (replaced and new cases)
  - `tests/client/meals-view-refresh-coherence.test.tsx` (2 renamed, 2 new)
  - `tests/client/meals-all-slot-picker.test.tsx` (describe renamed)
  - `tests/client/meals-household-timezone-error-retry.test.tsx` and `tests/client/admin-household-timezone-defaults.test.tsx` (only if titles changed)
- [ ] `testCohorts.runners.playwright.files`: add `tests/e2e/admin-meals.spec.ts`, keyed by the spec id from `npx playwright test --list --reporter=json` (`.quality/playwright-list.json`, produced by `npm run test:cohorts:e2e:list`). Copy the shape of an existing entry.
- [ ] `coveragePolicy.files`: no new source file. Remeasure `src/client/admin/MealsManagement.tsx` (line ~5406), `src/client/meals/MealEntryDialog.tsx` (~6576) and `src/client/meals/MealPlanGrid.tsx` (~6591) from `coverage/coverage-final.json`. `MealsManagement` shrinks, so its totals will drop: set `minimumTotals` to the new measured totals, and keep `minimumRates` at or above their current values. Never lower a rate. If a rate genuinely falls, add tests rather than lowering it.
- [ ] `npx prettier --write tests/fixtures/assembly-cohort.json`. Check that `git diff --stat` shows only these entries, then `git commit -m "test: resync the reviewed inventory for the meals admin polish"`.

### Task 7: Gate, commit, report

- [ ] Commit everything so the tree is clean (`git status --porcelain` is empty; the gate rejects untracked files).
- [ ] `export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)` then `npm run check:standard`. Expected exit 0. If `check:coverage` or `check:test-cohorts:standard` fails, fix the fixture (Task 6), commit, and rerun on the new HEAD. If `check:preflight` complains about the checkout, use a detached clean worktree as the shared-pills plan Task 8 describes. If an unused-i18n-key check fails, delete only the reported now-unused `meals.*` keys (for example `meals.menu.slotFilterLabel`, `meals.entries.dateLabel`, `meals.plan.showEntries`/`hideEntries`) in both locales, and record it in the report.
- [ ] `PORT=43225 MP_E2E_WEATHER_FIXTURE_PORT=44425 MP_E2E_QUOTE_FIXTURE_PORT=44435 npm run check:aggregate-only`. It also verifies the Playwright inventory. Expected exit 0.
- [ ] Optional visual check: use your own browser tab and the seeding commands in the `marplanner-dev-servers-and-seeding` memory. Look at `/admin/meals` in English and Spanish, at default and kiosk density, with Monday- and Sunday-first week starts.
- [ ] Write `REPORT-meals-polish.md` in the worktree root. Include the branch name, the worktree path, `git log --oneline main..HEAD`, the last lines of both gates, the e2e result, and any deviation from the spec and why. Then `git add REPORT-meals-polish.md && git commit -m "docs: report the meals admin polish"`. Do not merge or push. Reply exactly `DONE` followed by the branch name.
