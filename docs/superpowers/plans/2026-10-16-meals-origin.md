# Meals origin colours, origin pills and admin tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show where every meal comes from (one-off or a meal plan) with automatic origin colours and highlight pills on the admin Preview and the family `/meals` grid, split `/admin/meals` into three tabs, rename "Note" to "Free text", preselect a plan in the add dialog, and reseed the demo meals so every origin has meals.

**Architecture:** The server adds a derived, nullable `planId` to every `MenuItem` (no schema change). The client gets a pure origin model (`src/client/meals/meal-origins.ts`) that assigns each plan a colour token by creation order and computes chip emphasis from the selected pills. `MealPlanGrid`/`MealCell` (shared by both pages) render the pill row and the tinted chips. Colours live only in `tokens.css` + a few `@layer components` rules in `globals.css`; `PillControl` gains a `tone="colour"` option exposed through `PillToggle`'s new `colorClassName`.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (`@theme inline` tokens), Fastify + better-sqlite3, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-meals-origin-design.md`. Read it first. Owner decisions O1–O8 and design decisions D1–D11 are binding; do not reopen them.

**Branch/setup:** work in your own worktree, branched from `main` **after PR #42 (`feat/admin-pill-style`) is merged**. Copy the spec and this plan into your branch first and commit them with your first commit:

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /Users/diego/Dev/marplanner-project/docs/superpowers/specs/2026-10-16-meals-origin-design.md docs/superpowers/specs/
cp /Users/diego/Dev/marplanner-project/docs/superpowers/plans/2026-10-16-meals-origin.md docs/superpowers/plans/
```

Ports for every Playwright run: `PORT=43241 MP_E2E_WEATHER_FIXTURE_PORT=44461 MP_E2E_QUOTE_FIXTURE_PORT=44471`.

## Global Constraints

- `planId` is derived on read from `meal_entries.meal_plan_id`; no migration, no stored colour, no backfill. Invariant: `planId !== null ⇔ source === "recurring"`.
- The API field `note` and every i18n **key** stay as they are; only the displayed text changes to "Free text" / "Texto libre".
- New i18n keys go in ONE contiguous `// meals-origin` block per locale in `src/client/i18n/messages.ts`, placed right after the `// admin-settings-polish` block of that locale (the last block). Values in place of existing keys change where they are.
- No colour literals, inline `style`, or raw Tailwind scale colours in `src/client/**/*.{ts,tsx}`. Colours are defined only in `src/client/styles/tokens.css`; `check:ui-debt` baselines must not rise.
- Page code never imports `PillControl` directly; it uses `PillToggle`, `ChoicePills` or `MemberPills`.
- Admin tabs are local state (no URL sub-routes); `AdminPanel title={t("admin.sidebar.meals")}` stays.
- Every load error keeps (or gets) a Retry button.
- Do NOT add or change kiosk density tests. Only two density files may be touched, and only as Task 8/Task 6 describe (retargeting selectors / a fetch-mock route / re-measured counts). Report every such edit.
- "Today's meals" (`src/client/home/TodayMeals.tsx`) and Daily Briefing are not changed.
- The family dialog stays one-off only: `MealsBoard` never passes `plans` or `initialPlanId` to `MealEntryDialog`.

## Review Focus

1. **A pill selection referring to a plan that disappears** (deactivated in the Meal plans tab while selected): the selection must drop it, so no chip stays dimmed with nothing visibly selected, and preselection must not offer an inactive plan. Pinned in Task 4 (`useMealOrigins` prunes) and Task 7 (dialog ignores an inactive `initialPlanId`).
2. **Plans fail to load or are still loading** while the week renders: recurring chips must render (tone `unknown`, never crash on a missing map entry), pills show only "One-off", and the family page shows a Retry. Pinned in Task 4 (`toneOf` unknown) and Task 6 (family plans error).
3. **Two plans created in the same millisecond** (the seed does this on some DBs; tests use `createdAt: 0`): colour order must still be deterministic (id tiebreak) and must not change when one is renamed or deactivated. Pinned in Task 4.
4. **Selecting pills, then navigating weeks or opening a dimmed meal**: the selection survives navigation and a dimmed chip still opens the edit dialog (highlight never disables). Pinned in Task 6 (family board test) and Task 5 (grid test clicks a dim chip).
5. **Switching admin tabs with unsaved work** (recipe edit open, plan rename open): it must still be there when the user comes back (panels stay mounted, D8). Pinned in Task 8.

---

### Task 0: Baseline

- [ ] Confirm PR #42 is in `main`: `grep -n "reserveBoldLabel\|offLabel" src/client/components/PillControl.tsx src/client/components/MemberPills.tsx` must show both. If not, stop and report.
- [ ] Read: `src/client/meals/{MealCell,MealPlanGrid,MealsBoard,MealEntryDialog,useMealsWorkspace}.tsx|ts`, `src/client/admin/MealsManagement.tsx` (lines 100–520), `src/client/components/{PillControl,PillToggle,MemberPills}.tsx`, `src/client/admin/PrintingManagement.tsx` (tab pattern), `seeds/seed-060-meals.ts`.
- [ ] `grep -n "// admin-settings-polish" src/client/i18n/messages.ts` — note both positions (en ~1508, es ~3003).
- [ ] Baseline run (all must pass): `npx vitest run tests/boundary/meals-menu.test.ts tests/boundary/meals-assembly.test.ts tests/boundary/seed-meals.test.ts tests/integration/seed-meals.test.ts tests/client/meal-entry-dialog.test.tsx tests/client/meals-board.test.tsx tests/client/meals-management.test.tsx tests/client/meals-view-refresh-coherence.test.tsx tests/client/meals-workspace.test.tsx tests/client/family-surfaces.test.tsx tests/client/pill-toggle.test.tsx tests/client/meals-i18n-parity.test.ts`.
- [ ] Commit the copied spec and plan: `git add docs/superpowers && git commit -m "docs: add the meals origin spec and plan"`.

### Task 1: `planId` on every menu item (server, contract, docs)

**Files:**

- Modify: `src/shared/index.ts:596-606` (`MenuItem`)
- Modify: `src/server/modules/meals/index.ts:1059-1072` (`rowToMenuItem`)
- Modify: `docs/api/meals/openapi.yaml:288-319` (`MenuItem` schema)
- Modify: `docs/features/meals-recipes.md` (after FR-024, line ~101)
- Test: `tests/boundary/meals-menu.test.ts` (new case), `tests/boundary/meals-assembly.test.ts:88-98,133-144`, `tests/boundary/daily-briefing-optin-isolation.test.ts:303-312`
- Typecheck fixtures: every typed `MenuItem` literal in `tests/client/**` (found by `npm run typecheck`)

**Interfaces:**

- Produces: `MenuItem.planId: string | null` — the owning meal plan id for `source: "recurring"`, `null` for `"oneoff"`. Every later client task relies on it.

- [ ] **Step 1: Failing boundary test.** In `tests/boundary/meals-menu.test.ts`, inside the `describe("meals-menu boundary tests", …)`, add (helpers `seedKeys`, `createMealPlan`, `createEntry`, `getMenu`, `getWeekMenu` already exist in the file):

```ts
it("tags every menu item with its origin plan: the plan id for recurring, null for one-off (FR-025)", async () => {
  const { deviceKey } = seedKeys();
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    await app.ready();
    const plan = await createMealPlan(app, deviceKey, "Origin plan");
    const date = "2026-08-17";
    const weekday = weekdayOf(date, "Europe/Madrid");
    const recurring = JSON.parse(
      (
        await createEntry(app, deviceKey, {
          kind: "recurring",
          mealPlanId: plan.id,
          weekday,
          slot: "lunch",
          note: "weekly",
        })
      ).body
    );
    const oneOff = JSON.parse(
      (await createEntry(app, deviceKey, { kind: "oneoff", date, slot: "lunch", note: "once" }))
        .body
    );

    const expected = [
      expect.objectContaining({ entryId: recurring.id, source: "recurring", planId: plan.id }),
      expect.objectContaining({ entryId: oneOff.id, source: "oneoff", planId: null }),
    ];
    expect(JSON.parse((await getMenu(app, deviceKey, date)).body)).toEqual(expected);
    expect(JSON.parse((await getMenu(app, deviceKey, date, "lunch")).body)).toEqual(expected);
    expect(JSON.parse((await getWeekMenu(app, deviceKey, date)).body)[date].lunch).toEqual(
      expected
    );
  } finally {
    await app.close();
  }
});
```

Check how `createMealPlan` returns (it is `async` and returns the parsed plan in this file; if it returns a response, parse `.body` the same way the other tests do).

- [ ] **Step 2:** `npx vitest run tests/boundary/meals-menu.test.ts -t "FR-025"` → FAIL (`planId` undefined).
- [ ] **Step 3: Implement.** `src/shared/index.ts`, in `MenuItem` after `source`:

```ts
/** The meal plan a recurring item comes from; null for a one-off. Derived, never stored. */
planId: string | null;
```

`src/server/modules/meals/index.ts` `rowToMenuItem`, after the `source:` line:

```ts
    planId: row.meal_plan_id,
```

- [ ] **Step 4:** `npx vitest run tests/boundary/meals-menu.test.ts` → PASS.
- [ ] **Step 5: Exact assertions.** In `tests/boundary/meals-assembly.test.ts` add `planId: null,` to both exact `toEqual` objects (after `source: "oneoff",`). In `tests/boundary/daily-briefing-optin-isolation.test.ts` add `planId: null,` to the mocked `getMenu` item. Run `npm run typecheck`; for each reported `tests/client/**` literal missing `planId`, add `planId: null` for `source: "oneoff"` items and a plan id string (use the fixture's plan id if the file has one, else `"plan-1"`) for `source: "recurring"` items. Do not touch `tests/client/family-surfaces.test.tsx` content here (its week fixture is untyped JSON and needs no change).
- [ ] **Step 6: OpenAPI.** In `docs/api/meals/openapi.yaml` `MenuItem`: add `- planId` to `required` (after `- source`) and the property after `source`:

```yaml
planId:
  description: >
    The meal plan a recurring item comes from (its recurring entry's mealPlanId); null for a
    one-off item. Derived on read, never stored.
  type:
    - string
    - "null"
```

- [ ] **Step 7: Feature doc.** In `docs/features/meals-recipes.md` after FR-024 add:

```markdown
- **FR-025**: Given a derived menu item (day, slot-filtered or week read), then it MUST carry `planId`: the id of the meal plan whose recurring entry produced it, or `null` for a one-off, derived on read with no stored column and no backfill. Contract: none (admin parity).
- **FR-026**: Given the week grid on `/meals` or the admin Preview, then each meal MUST be tinted with its origin colour (one-off warm grey; each plan an automatic colour by plan creation order), free-text meals MUST render in italics, and origin pills ("One-off" plus every active plan) MUST highlight the selected origins' meals and grey the rest in place without hiding, reordering or disabling any meal. Contract: none (admin parity).
```

In "Key Entities", extend the **Menu** bullet: `… — never materialized. Each item carries its origin (`planId`, null for a one-off).`

- [ ] **Step 8:** `npm run check:openapi && npm run check:openapi-shapes && npx vitest run tests/boundary/meals-*.test.ts tests/boundary/daily-briefing-optin-isolation.test.ts` → PASS. `tests/boundary/seed-meals.test.ts` fails on `planId` until Task 2; that is expected.
- [ ] **Step 9: Commit:** `git add -A src/shared src/server docs/api docs/features tests && git commit -m "feat(meals): tag menu items with their origin plan id"`

### Task 2: Regenerate the demo meals seed

**Files:**

- Modify: `seeds/seed-060-meals.ts`
- Test: `tests/boundary/seed-meals.test.ts`, `tests/integration/seed-meals.test.ts`

**Interfaces:**

- Consumes: `upsertSeedMealPlan`, `upsertSeedMealEntry`, `replaceSeedRollingMealEntries` (unchanged), `MenuItem.planId` (Task 1).
- Produces: plans `demo:meal-plan:simpson-family-week` (created at `nowMs`) and `demo:meal-plan:school-lunches` (created at `nowMs + 1`).

- [ ] **Step 1: Update the seed tests first (they define the new seed).** In `tests/boundary/seed-meals.test.ts`:
  - `publicRead.plans` expectation becomes:

```ts
expect(publicRead.plans.map(withoutPlanTimestamps)).toEqual([
  { id: "demo:meal-plan:school-lunches", name: "School lunches", active: true },
  { id: "demo:meal-plan:simpson-family-week", name: "Simpson Family Week", active: true },
]);
```

- `publicRead.recurringEntries` (Simpson's entries, ordered `created_at, id`) gains two rows, so the full list in id order is `fri:dinner`, `mon:dinner`, `sat:breakfast` (`recipeId: null`, `note: "Waffles with Grampa"`), `sun:snack`, `tue:dinner` (`recipeId: null`, `note: "Leftovers night"`), `wed:dinner`. Write the two new objects in the same shape as the existing ones (`kind: "recurring"`, `mealPlanId: "demo:meal-plan:simpson-family-week"`, `date: null`).
- In `readMealsThroughPublicApi`, also read `/api/meal-plans/demo:meal-plan:school-lunches/entries` as `schoolEntries` and assert after the Simpson block:

```ts
expect(
  publicRead.schoolEntries.map(({ id, weekday, slot, recipeId, note }: any) => ({
    id,
    weekday,
    slot,
    recipeId,
    note,
  }))
).toEqual([
  {
    id: "demo:meal-entry:recurring:school-lunches:fri:lunch",
    weekday: "fri",
    slot: "lunch",
    recipeId: null,
    note: "Sandwich and fruit",
  },
  {
    id: "demo:meal-entry:recurring:school-lunches:mon:lunch",
    weekday: "mon",
    slot: "lunch",
    recipeId: "demo:recipe:marges-spaghetti",
    note: null,
  },
  {
    id: "demo:meal-entry:recurring:school-lunches:thu:lunch",
    weekday: "thu",
    slot: "lunch",
    recipeId: "demo:recipe:steamed-hams",
    note: null,
  },
  {
    id: "demo:meal-entry:recurring:school-lunches:thu:snack",
    weekday: "thu",
    slot: "snack",
    recipeId: "demo:recipe:apu-samosas",
    note: null,
  },
  {
    id: "demo:meal-entry:recurring:school-lunches:tue:lunch",
    weekday: "tue",
    slot: "lunch",
    recipeId: null,
    note: "Sandwich and fruit",
  },
  {
    id: "demo:meal-entry:recurring:school-lunches:wed:lunch",
    weekday: "wed",
    slot: "lunch",
    recipeId: "demo:recipe:lisa-lentil-stew",
    note: null,
  },
]);
```

- `publicRead.menu` for 2026-09-23 (a Wednesday; recurring first, plan name ASC, then one-off):

```ts
expect(publicRead.menu).toEqual([
  {
    entryId: "demo:meal-entry:recurring:school-lunches:wed:lunch",
    slot: "lunch",
    label: "Lisa's Lentil Stew",
    isTombstone: false,
    source: "recurring",
    planId: "demo:meal-plan:school-lunches",
    recipeId: "demo:recipe:lisa-lentil-stew",
    note: null,
  },
  {
    entryId: "demo:meal-entry:recurring:wed:dinner",
    slot: "dinner",
    label: "Krusty Burger",
    isTombstone: false,
    source: "recurring",
    planId: "demo:meal-plan:simpson-family-week",
    recipeId: "demo:recipe:krusty-burger",
    note: null,
  },
  {
    entryId: "demo:meal-entry:rolling:2026-09-23:snack:current-snack",
    slot: "snack",
    label: "Pink Donut",
    isTombstone: false,
    source: "oneoff",
    planId: null,
    recipeId: "demo:recipe:pink-donut",
    note: null,
  },
]);
```

- Add to the first test (`populates the Simpsons catalogue…`) after the existing `current` assertion, so every origin has meals in the current and next week:

```ts
for (const anchor of ["2026-09-25", "2026-10-02"]) {
  const origins = new Set(
    Object.values(getWeekMenu(anchor)).flatMap((slots) =>
      Object.values(slots).flatMap((items) => items.map((item) => item.planId ?? "oneoff"))
    )
  );
  expect([...origins].sort()).toEqual([
    "demo:meal-plan:school-lunches",
    "demo:meal-plan:simpson-family-week",
    "oneoff",
  ]);
}
expect(
  Object.values(getWeekMenu("2026-10-02")).some((slots) =>
    Object.values(slots).some((items) =>
      items.some((item) => item.source === "oneoff" && item.note !== null)
    )
  )
).toBe(true);
```

In `tests/integration/seed-meals.test.ts`:

- insert `{ id: "demo:meal-entry:rolling:2026-10-09:dinner:next-dinner-note", entry_date: "2026-10-09" },` between the `2026-10-07` and `2026-10-11` rows;
- `expect(firstRollingRows).toHaveLength(11)` → `12`;
- `getMenu(SECOND_DATE, undefined)` (a Friday) becomes:

```ts
expect(getMenu(SECOND_DATE, undefined)).toEqual([
  expect.objectContaining({
    entryId: "demo:meal-entry:recurring:school-lunches:fri:lunch",
    planId: "demo:meal-plan:school-lunches",
    recipeId: null,
    note: "Sandwich and fruit",
  }),
  expect.objectContaining({
    entryId: "demo:meal-entry:recurring:fri:dinner",
    planId: "demo:meal-plan:simpson-family-week",
    recipeId: "demo:recipe:lisa-lentil-stew",
    note: null,
  }),
]);
```

- [ ] **Step 2:** `npx vitest run tests/boundary/seed-meals.test.ts tests/integration/seed-meals.test.ts` → FAIL.
- [ ] **Step 3: Seed.** In `seeds/seed-060-meals.ts`:

```ts
const PLAN_ID = "demo:meal-plan:simpson-family-week";
const SCHOOL_PLAN_ID = "demo:meal-plan:school-lunches";

type RecurringSeed = readonly [
  weekday: Weekday,
  slot: Slot,
  content: { recipeId?: string; note?: string },
];

/** Simpson Family Week keeps its original ids: `demo:meal-entry:recurring:<weekday>:<slot>`. */
const SIMPSON_ENTRIES: readonly RecurringSeed[] = [
  ["mon", "dinner", { recipeId: "demo:recipe:marge-tomato-soup" }],
  ["tue", "dinner", { note: "Leftovers night" }],
  ["wed", "dinner", { recipeId: "demo:recipe:krusty-burger" }],
  ["fri", "dinner", { recipeId: "demo:recipe:lisa-lentil-stew" }],
  ["sat", "breakfast", { note: "Waffles with Grampa" }],
  ["sun", "snack", { recipeId: "demo:recipe:pink-donut" }],
];

/** School lunches ids: `demo:meal-entry:recurring:school-lunches:<weekday>:<slot>`. */
const SCHOOL_ENTRIES: readonly RecurringSeed[] = [
  ["mon", "lunch", { recipeId: "demo:recipe:marges-spaghetti" }],
  ["tue", "lunch", { note: "Sandwich and fruit" }],
  ["wed", "lunch", { recipeId: "demo:recipe:lisa-lentil-stew" }],
  ["thu", "lunch", { recipeId: "demo:recipe:steamed-hams" }],
  ["thu", "snack", { recipeId: "demo:recipe:apu-samosas" }],
  ["fri", "lunch", { note: "Sandwich and fruit" }],
];
```

Import `Weekday` alongside `Slot` from `../src/shared`. In `buildRollingMealEntries` add after `next-snack`:

```ts
    at(11, "dinner", "next-dinner-note", { note: "Takeout from Luigi's" }),
```

In `run`, replace the single plan upsert and the inline recurring loop with:

```ts
upsertSeedMealPlan({ id: PLAN_ID, nowMs, name: "Simpson Family Week" });
// One millisecond later, so Simpson Family Week keeps the first plan colour (creation order).
upsertSeedMealPlan({ id: SCHOOL_PLAN_ID, nowMs: nowMs + 1, name: "School lunches" });
for (const [weekday, slot, content] of SIMPSON_ENTRIES) {
  upsertSeedMealEntry({
    id: `demo:meal-entry:recurring:${weekday}:${slot}`,
    nowMs,
    kind: "recurring",
    mealPlanId: PLAN_ID,
    weekday,
    slot,
    ...content,
  });
}
for (const [weekday, slot, content] of SCHOOL_ENTRIES) {
  upsertSeedMealEntry({
    id: `demo:meal-entry:recurring:school-lunches:${weekday}:${slot}`,
    nowMs,
    kind: "recurring",
    mealPlanId: SCHOOL_PLAN_ID,
    weekday,
    slot,
    ...content,
  });
}
```

Keep the rolling block unchanged.

- [ ] **Step 4:** `npx vitest run tests/boundary/seed-meals.test.ts tests/integration/seed-meals.test.ts tests/integration/seed-ownership.test.ts tests/boundary/data-ownership.test.ts` → PASS. If the first test's `current["2026-09-21"].dinner` list changed, it is wrong: no new entry is a Monday dinner.
- [ ] **Step 5: Fresh-DB seed run** (from your worktree; copy `.env.local` from the main checkout first if absent, and run `npm run seed:sync-private` once, per the dev-seeding memory):

```bash
SEED_DIR=$(mktemp -d) && DATA_DIR="$SEED_DIR" npm run seed
sqlite3 "$SEED_DIR/marplanner.db" "SELECT id, name FROM meal_plans ORDER BY created_at, id;"
sqlite3 "$SEED_DIR/marplanner.db" "SELECT COUNT(*) FROM meal_entries WHERE meal_plan_id IS NOT NULL;"   # 12
DATA_DIR="$SEED_DIR" npm run seed   # second run: must succeed (rerun)
```

Expected: exit 0 both times; Simpson Family Week listed before School lunches; 12 recurring rows. If only the private profile fails for a missing private config, run `DATA_DIR="$SEED_DIR" npm run seed:public` instead and record that in the report.

- [ ] **Step 6: Commit:** `git add seeds tests && git commit -m "feat(seed): add a school lunches plan and free-text meals so every origin shows"`

### Task 3: Origin colour tokens and the coloured pill tone

**Files:**

- Modify: `src/client/styles/tokens.css` (after the meal-slot tokens, line ~45)
- Modify: `src/client/styles/globals.css` (`@layer components`, line ~125)
- Modify: `src/client/components/PillControl.tsx`, `src/client/components/PillToggle.tsx`
- Modify: `docs/ui/component-contract.md` (component table, line ~57)
- Test: `tests/client/pill-toggle.test.tsx` (new non-density case)

**Interfaces:**

- Produces: CSS classes `meal-origin-oneoff`, `meal-origin-plan-1` … `meal-origin-plan-6`, `meal-origin-unknown` (set `--meal-origin`), `meal-origin-chip` (+ `[data-emphasis="hit"|"dim"]`), `meal-origin-pill` (sets `--pill-color`, `--pill-color-selected`).
- Produces: `PillControlProps.tone?: "default" | "colour"`; `PillToggleProps.colorClassName?: string`.

- [ ] **Step 1: Failing test** in `tests/client/pill-toggle.test.tsx` (a new `it` inside the existing describe; do not edit the density case):

```tsx
it("draws a coloured pill from the caller's colour class and reserves its bold width", () => {
  render(
    <PillToggle
      checked
      onChange={vi.fn()}
      label="School lunches"
      colorClassName="meal-origin-pill meal-origin-plan-2"
    />
  );
  const checkbox = screen.getByRole("checkbox", { name: "School lunches" });
  const pill = checkbox.closest("label") as HTMLElement;
  expect(pill).toHaveClass(
    "meal-origin-pill",
    "meal-origin-plan-2",
    "has-[:checked]:bg-[var(--pill-color-selected)]",
    "has-[:checked]:border-[var(--pill-color)]",
    "has-[:checked]:font-semibold",
    "bg-muted"
  );
  expect(pill).not.toHaveClass("has-[:checked]:bg-accent");
  expect(pill.querySelector('[data-text="School lunches"]')).not.toBeNull();
});

it("keeps the plain accent pill when no colour class is given", () => {
  render(<PillToggle checked onChange={vi.fn()} label="Dinner" />);
  const pill = screen.getByRole("checkbox", { name: "Dinner" }).closest("label") as HTMLElement;
  expect(pill).toHaveClass("has-[:checked]:bg-accent");
  expect(pill.querySelector("[data-text]")).toBeNull();
});
```

- [ ] **Step 2:** `npx vitest run tests/client/pill-toggle.test.tsx` → the new cases FAIL.
- [ ] **Step 3: PillControl.** Add to `PillControlProps`:

```ts
  /** "colour": a caller class sets `--pill-color` (checked border) and `--pill-color-selected`
   * (checked ground). Unchecked it is muted like a member pill; checked it has foreground text in
   * semibold. "default" (the default) is the plain accent pill. */
  tone?: "default" | "colour";
```

Above the component:

```ts
/** The coloured tone. A transparent border keeps the box identical in both states. */
const COLOUR_TONE_CLASS =
  "border-transparent bg-muted text-muted-foreground has-[:checked]:border-[var(--pill-color)] has-[:checked]:bg-[var(--pill-color-selected)] has-[:checked]:text-foreground has-[:checked]:font-semibold";
```

Destructure `tone = "default"` and put `tone === "colour" && COLOUR_TONE_CLASS,` in the `cn(…)` call right before `disabled && …`. Update the header comment: "Internal drawing primitive behind `PillToggle`, `ChoicePills` and `MemberPills`".

- [ ] **Step 4: PillToggle.** Add the prop and forward it:

```ts
  /** Draws the coloured pill: a class (or classes) that set `--pill-color` and
   * `--pill-color-selected`, e.g. the meal-origin classes. The label reserves its bold width. */
  colorClassName?: string;
```

```tsx
<PillControl
  type="checkbox"
  checked={checked}
  onChange={onChange}
  label={label}
  disabled={disabled}
  tone={colorClassName ? "colour" : "default"}
  reserveBoldLabel={colorClassName !== undefined}
  className={cn(colorClassName, className)}
  data-testid={testId}
/>
```

(import `cn` from `@/lib/utils`).

- [ ] **Step 5: Tokens.** `tokens.css`, after `--meal-dinner`:

```css
/* Meal origins: one muted hue per meal plan (assigned by creation order) and a warm grey for
     one-off meals, kept apart from the high-chroma member colours and the amber "today" accent. */
--meal-origin-oneoff: oklch(0.62 0.01 60);
--meal-origin-plan-1: oklch(0.52 0.09 150); /* sage */
--meal-origin-plan-2: oklch(0.52 0.11 30); /* clay */
--meal-origin-plan-3: oklch(0.5 0.08 250); /* slate */
--meal-origin-plan-4: oklch(0.5 0.09 330); /* plum */
--meal-origin-plan-5: oklch(0.52 0.08 200); /* lagoon */
--meal-origin-plan-6: oklch(0.5 0.07 60); /* umber */
```

`globals.css`, inside the existing `@layer components { … }` after `.member-event-surface`, paste the CSS block from spec §5 verbatim, writing out all six `.meal-origin-plan-N` rules.

- [ ] **Step 6:** `npx vitest run tests/client/pill-toggle.test.tsx tests/client/member-pills.test.tsx tests/client/choice-pills.test.tsx` → PASS. `npm run check:ui-debt && npm run check:ui-catalog` → PASS (no new export names; `COMPONENTS.md` unchanged).
- [ ] **Step 7: Contract doc.** In `docs/ui/component-contract.md` add a row after "Member pills": `| Pill toggle            | an on/off pill; with a caller colour class it draws the coloured pill (muted off, tinted and bordered on) |` (re-run prettier to realign the table).
- [ ] **Step 8: Commit:** `git add -A src/client/styles src/client/components docs/ui tests/client/pill-toggle.test.tsx && git commit -m "feat(ui): add meal origin colour tokens and a coloured pill tone"`

### Task 4: The origin model (`meal-origins.ts`)

**Files:**

- Create: `src/client/meals/meal-origins.ts`
- Modify: `src/client/i18n/messages.ts` (new `// meals-origin` block, en + es)
- Test: `tests/client/meal-origins.test.tsx`

**Interfaces:**

- Consumes: `MealPlan`, `MenuItem` (with `planId`) from `src/shared`.
- Produces (exact, used by Tasks 5–8):

```ts
export const ONE_OFF_ORIGIN = "oneoff";
export const MEAL_ORIGIN_PLAN_TONES: readonly [
  "plan-1",
  "plan-2",
  "plan-3",
  "plan-4",
  "plan-5",
  "plan-6",
];
export type MealOriginTone = "oneoff" | "unknown" | (typeof MEAL_ORIGIN_PLAN_TONES)[number];
export type MealOriginEmphasis = "normal" | "hit" | "dim";
export interface MealOriginPill {
  id: string;
  label: string;
  tone: MealOriginTone;
}
export const MEAL_ORIGIN_TONE_CLASS: Record<MealOriginTone, string>;
export function planTones(plans: readonly MealPlan[]): ReadonlyMap<string, MealOriginTone>;
export function originIdOf(item: MenuItem): string;
export function toneOf(
  originId: string,
  tones: ReadonlyMap<string, MealOriginTone>
): MealOriginTone;
export function emphasisOf(originId: string, selected: readonly string[]): MealOriginEmphasis;
export function originPills(
  plans: readonly MealPlan[],
  tones: ReadonlyMap<string, MealOriginTone>,
  oneOffLabel: string
): MealOriginPill[];
export function preselectedPlanId(
  selected: readonly string[],
  plans: readonly MealPlan[]
): string | undefined;
export interface MealOriginsState {
  pills: MealOriginPill[];
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: string[];
  setSelected(next: string[]): void;
  preselectPlanId: string | undefined;
}
export function useMealOrigins(plans: readonly MealPlan[] | null): MealOriginsState;
```

- [ ] **Step 1: i18n block.** After `// admin-settings-polish` block in `en`:

```ts
    // meals-origin
    "meals.tabs.label": "Meals sections",
    "meals.tabs.preview": "Preview",
    "meals.tabs.plans": "Meal plans",
    "meals.tabs.recipes": "Recipes",
    "meals.origin.groupLabel": "Show where meals come from",
    "meals.origin.oneOff": "One-off",
    "meals.origin.recurring": "Recurring",
```

and in `es`:

```ts
    // meals-origin
    "meals.tabs.label": "Secciones de comidas",
    "meals.tabs.preview": "Vista previa",
    "meals.tabs.plans": "Planes de comidas",
    "meals.tabs.recipes": "Recetas",
    "meals.origin.groupLabel": "Mostrar de dónde vienen las comidas",
    "meals.origin.oneOff": "Puntual",
    "meals.origin.recurring": "Recurrente",
```

- [ ] **Step 2: Failing tests** `tests/client/meal-origins.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { LanguageProvider } from "@/i18n";
import {
  emphasisOf,
  originIdOf,
  originPills,
  planTones,
  preselectedPlanId,
  toneOf,
  useMealOrigins,
} from "@/meals/meal-origins";
import type { MealPlan, MenuItem } from "../../src/shared";

const plan = (id: string, name: string, createdAt: number, active = true): MealPlan => ({
  id,
  name,
  active,
  createdAt,
  updatedAt: createdAt,
});
const item = (planId: string | null): MenuItem => ({
  entryId: "e",
  slot: "lunch",
  label: "x",
  isTombstone: false,
  source: planId ? "recurring" : "oneoff",
  planId,
  recipeId: null,
  note: "x",
});

describe("meal origins", () => {
  it("colours plans by creation order then id, including inactive plans, and cycles after six", () => {
    const plans = [
      plan("b", "Zeta", 5),
      plan("a", "Alpha", 5),
      plan("c", "Old", 1, false),
      ...["d", "e", "f", "g", "h"].map((id, i) => plan(id, id, 10 + i)),
    ];
    const tones = planTones(plans);
    expect(tones.get("c")).toBe("plan-1");
    expect(tones.get("a")).toBe("plan-2");
    expect(tones.get("b")).toBe("plan-3");
    expect(tones.get("g")).toBe("plan-6");
    expect(tones.get("h")).toBe("plan-1");
  });

  it("keeps a plan's colour when another plan is renamed or deactivated", () => {
    const before = planTones([plan("a", "A", 1), plan("b", "B", 2)]);
    const after = planTones([plan("a", "Z renamed", 1, false), plan("b", "B", 2)]);
    expect(after.get("b")).toBe(before.get("b"));
  });

  it("maps items to origins and unknown plans to the unknown tone", () => {
    const tones = planTones([plan("a", "A", 1)]);
    expect(originIdOf(item(null))).toBe("oneoff");
    expect(originIdOf(item("a"))).toBe("a");
    expect(toneOf("oneoff", tones)).toBe("oneoff");
    expect(toneOf("a", tones)).toBe("plan-1");
    expect(toneOf("missing", tones)).toBe("unknown");
  });

  it("highlights selected origins and dims the rest only while something is selected", () => {
    expect(emphasisOf("a", [])).toBe("normal");
    expect(emphasisOf("a", ["a"])).toBe("hit");
    expect(emphasisOf("oneoff", ["a"])).toBe("dim");
  });

  it("offers One-off first, then active plans by name, never inactive ones", () => {
    const plans = [plan("b", "School", 2), plan("a", "Simpson", 1), plan("c", "Gone", 3, false)];
    expect(originPills(plans, planTones(plans), "One-off")).toEqual([
      { id: "oneoff", label: "One-off", tone: "oneoff" },
      { id: "b", label: "School", tone: "plan-2" },
      { id: "a", label: "Simpson", tone: "plan-1" },
    ]);
  });

  it("preselects a plan only when exactly one active plan pill is selected", () => {
    const plans = [plan("a", "A", 1), plan("b", "B", 2, false)];
    expect(preselectedPlanId(["a"], plans)).toBe("a");
    expect(preselectedPlanId(["oneoff"], plans)).toBeUndefined();
    expect(preselectedPlanId(["a", "oneoff"], plans)).toBeUndefined();
    expect(preselectedPlanId(["b"], plans)).toBeUndefined();
    expect(preselectedPlanId([], plans)).toBeUndefined();
  });

  it("drops a selected plan whose pill disappears", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LanguageProvider>{children}</LanguageProvider>
    );
    let plans: MealPlan[] = [plan("a", "A", 1)];
    const { result, rerender } = renderHook(() => useMealOrigins(plans), { wrapper });
    act(() => result.current.setSelected(["a"]));
    expect(result.current.preselectPlanId).toBe("a");
    plans = [plan("a", "A", 1, false)];
    rerender();
    expect(result.current.selected).toEqual([]);
    expect(result.current.preselectPlanId).toBeUndefined();
    expect(result.current.pills.map((pill) => pill.id)).toEqual(["oneoff"]);
  });

  it("works with no plans loaded yet", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LanguageProvider>{children}</LanguageProvider>
    );
    const { result } = renderHook(() => useMealOrigins(null), { wrapper });
    expect(result.current.pills).toEqual([{ id: "oneoff", label: "One-off", tone: "oneoff" }]);
    expect(toneOf("a", result.current.tones)).toBe("unknown");
  });
});
```

(If `LanguageProvider` needs `HouseholdSettingsProvider` or defaults to a language other than English in tests, wrap it the way `tests/client/meals-board.test.tsx` does.)

- [ ] **Step 3:** `npx vitest run tests/client/meal-origins.test.tsx` → FAIL (module missing).
- [ ] **Step 4: Implement** `src/client/meals/meal-origins.ts`:

```ts
import { useMemo, useState } from "react";

import { useTranslation } from "@/i18n";
import type { MealPlan, MenuItem } from "../../shared";

/** Where a meal comes from: a one-off for its date, or a meal plan's weekly entry. Colours are
 * automatic (spec D1): a plan's tone is its position among ALL plans by creation order (then id),
 * so renaming or (de)activating a plan never recolours another. Nothing is stored. */

export const ONE_OFF_ORIGIN = "oneoff";
export const MEAL_ORIGIN_PLAN_TONES = [
  "plan-1",
  "plan-2",
  "plan-3",
  "plan-4",
  "plan-5",
  "plan-6",
] as const;
export type MealOriginTone = "oneoff" | "unknown" | (typeof MEAL_ORIGIN_PLAN_TONES)[number];
export type MealOriginEmphasis = "normal" | "hit" | "dim";

export interface MealOriginPill {
  id: string;
  label: string;
  tone: MealOriginTone;
}

/** Static map so Tailwind and readers see every class; the colours live in globals.css/tokens.css. */
export const MEAL_ORIGIN_TONE_CLASS: Record<MealOriginTone, string> = {
  oneoff: "meal-origin-oneoff",
  unknown: "meal-origin-unknown",
  "plan-1": "meal-origin-plan-1",
  "plan-2": "meal-origin-plan-2",
  "plan-3": "meal-origin-plan-3",
  "plan-4": "meal-origin-plan-4",
  "plan-5": "meal-origin-plan-5",
  "plan-6": "meal-origin-plan-6",
};

/** Binary string order, like SQLite's default collation used by the menu's plan-name order. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function planTones(plans: readonly MealPlan[]): ReadonlyMap<string, MealOriginTone> {
  const ordered = [...plans].sort((a, b) => a.createdAt - b.createdAt || compareText(a.id, b.id));
  return new Map(
    ordered.map((plan, index) => [
      plan.id,
      MEAL_ORIGIN_PLAN_TONES[index % MEAL_ORIGIN_PLAN_TONES.length],
    ])
  );
}

export function originIdOf(item: MenuItem): string {
  return item.planId ?? ONE_OFF_ORIGIN;
}

export function toneOf(
  originId: string,
  tones: ReadonlyMap<string, MealOriginTone>
): MealOriginTone {
  if (originId === ONE_OFF_ORIGIN) return "oneoff";
  return tones.get(originId) ?? "unknown";
}

export function emphasisOf(originId: string, selected: readonly string[]): MealOriginEmphasis {
  if (selected.length === 0) return "normal";
  return selected.includes(originId) ? "hit" : "dim";
}

/** "One-off" first, then every ACTIVE plan by name then id (spec D2). */
export function originPills(
  plans: readonly MealPlan[],
  tones: ReadonlyMap<string, MealOriginTone>,
  oneOffLabel: string
): MealOriginPill[] {
  const active = plans
    .filter((plan) => plan.active)
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  return [
    { id: ONE_OFF_ORIGIN, label: oneOffLabel, tone: "oneoff" },
    ...active.map((plan) => ({ id: plan.id, label: plan.name, tone: toneOf(plan.id, tones) })),
  ];
}

/** Exactly one pill selected, and it is an active plan: the add dialog opens on that plan. */
export function preselectedPlanId(
  selected: readonly string[],
  plans: readonly MealPlan[]
): string | undefined {
  if (selected.length !== 1) return undefined;
  const [id] = selected;
  return plans.some((plan) => plan.id === id && plan.active) ? id : undefined;
}

export interface MealOriginsState {
  pills: MealOriginPill[];
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: string[];
  setSelected(next: string[]): void;
  preselectPlanId: string | undefined;
}

const NO_PLANS: readonly MealPlan[] = [];

/** Page-local pill selection (spec D3): survives week navigation, is not persisted, and drops ids
 * whose pill is gone. */
export function useMealOrigins(plans: readonly MealPlan[] | null): MealOriginsState {
  const { t } = useTranslation();
  const list = plans ?? NO_PLANS;
  const [rawSelected, setSelected] = useState<string[]>([]);
  const tones = useMemo(() => planTones(list), [list]);
  const pills = useMemo(() => originPills(list, tones, t("meals.origin.oneOff")), [list, tones, t]);
  const selected = useMemo(
    () => rawSelected.filter((id) => pills.some((pill) => pill.id === id)),
    [rawSelected, pills]
  );
  return {
    pills,
    tones,
    selected,
    setSelected,
    preselectPlanId: preselectedPlanId(selected, list),
  };
}
```

- [ ] **Step 5:** `npx vitest run tests/client/meal-origins.test.tsx tests/client/meals-i18n-parity.test.ts` → PASS.
- [ ] **Step 6: Commit:** `git add src/client/meals/meal-origins.ts src/client/i18n/messages.ts tests/client/meal-origins.test.tsx && git commit -m "feat(meals): add the meal origin model and its strings"`

### Task 5: Origin pills, tinted chips and the shared grid

**Files:**

- Create: `src/client/meals/MealOriginPills.tsx`
- Modify: `src/client/meals/MealCell.tsx`, `src/client/meals/MealPlanGrid.tsx`
- Test: `tests/client/meals-board.test.tsx` (replace the class assertion at line ~284; new cases)

**Interfaces:**

- Consumes: Task 3 classes + `PillToggle.colorClassName`; Task 4 exports.
- Produces:

```ts
// MealOriginPills.tsx
export interface MealOriginPillsProps {
  pills: readonly MealOriginPill[];
  selected: readonly string[];
  onChange(next: string[]): void;
}
export function MealOriginPills(props: MealOriginPillsProps): React.JSX.Element;

// MealCell.tsx
export interface MealCellOrigin {
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: readonly string[];
  labels: ReadonlyMap<string, string>;
}
// MealCellProps gains: origin?: MealCellOrigin;

// MealPlanGrid.tsx — MealPlanGridProps gains:
origin?: {
  pills: MealOriginPill[];
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: readonly string[];
  onSelectedChange(next: string[]): void;
};
```

Testids: pill row `meal-origin-pills`; each pill input `meal-origin-pill-<originId>`; chip keeps `meal-entry-card`, gains `data-origin`, `data-emphasis`, `title`.

- [ ] **Step 1: Failing tests.** In `tests/client/meals-board.test.tsx`, the test that renders `MealPlanGrid` with `recurring-1`/`oneoff-1` (line ~255): give its `recurring-1` fixture `planId: "plan-1"` and its one-off `planId: null` (Task 1 may already have), then replace

```ts
expect(cards[0]).toHaveClass("border-accent", "bg-accent/20", "text-accent-foreground");
```

with

```ts
// Without origin data a recurring chip falls back to the unknown tone, a one-off to grey.
expect(cards[0]).toHaveClass("meal-origin-chip", "meal-origin-unknown");
expect(cards[0]).toHaveAttribute("data-emphasis", "normal");
expect(cards[1]).toHaveClass("meal-origin-chip", "meal-origin-oneoff");
expect(cards[0]).not.toHaveClass("bg-accent/20");
```

Add a new `it` in the same describe (reuse that test's `week()` fixture builder and render shape; check whether its one-off item is a note or a recipe and adapt the italic assertion to the item that has `note !== null`):

```tsx
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

  fireEvent.click(within(group).getByRole("checkbox", { name: "Weeknights" }));
  expect(onSelectedChange).toHaveBeenCalledWith(["plan-1"]);

  rerender(grid(["plan-1"]));
  expect(recurring).toHaveAttribute("data-emphasis", "hit");
  expect(oneOff).toHaveAttribute("data-emphasis", "dim");
  expect(within(group).getByRole("checkbox", { name: "Weeknights" })).toBeChecked();
  fireEvent.click(oneOff);
  expect(onSelect).toHaveBeenCalled();
});
```

Add the italic check: the chip whose item has `note !== null` contains `span.italic` with the label; a recipe chip does not.

- [ ] **Step 2:** `npx vitest run tests/client/meals-board.test.tsx` → FAIL.
- [ ] **Step 3: `MealOriginPills.tsx`:**

```tsx
import { useId } from "react";

import { PillToggle } from "@/components/PillToggle";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { MEAL_ORIGIN_TONE_CLASS, type MealOriginPill } from "./meal-origins";

/** Origin pills above the week grid. They highlight, never filter: the caller dims the meals of
 * unselected origins in place (spec O4). */
export interface MealOriginPillsProps {
  pills: readonly MealOriginPill[];
  selected: readonly string[];
  onChange(next: string[]): void;
}

export function MealOriginPills({ pills, selected, onChange }: MealOriginPillsProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(pills.filter((pill) => next.has(pill.id)).map((pill) => pill.id));
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
      <span id={labelId} className="text-muted-foreground text-sm font-medium">
        {t("meals.origin.groupLabel")}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        data-testid="meal-origin-pills"
        className="flex flex-wrap gap-2"
      >
        {pills.map((pill) => (
          <PillToggle
            key={pill.id}
            label={pill.label}
            checked={selected.includes(pill.id)}
            onChange={(checked) => toggle(pill.id, checked)}
            colorClassName={cn("meal-origin-pill", MEAL_ORIGIN_TONE_CLASS[pill.tone])}
            data-testid={`meal-origin-pill-${pill.id}`}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `MealCell.tsx`.** Add imports (`cn` from `@/lib/utils`; `emphasisOf`, `originIdOf`, `toneOf`, `MEAL_ORIGIN_TONE_CLASS`, `ONE_OFF_ORIGIN`, type `MealOriginTone` from `./meal-origins`), the exported `MealCellOrigin` interface above, the prop `origin?: MealCellOrigin`, and:

```ts
const NO_ORIGIN: MealCellOrigin = { tones: new Map(), selected: [], labels: new Map() };
```

Destructure `origin = NO_ORIGIN`. Replace the entry `<button …>` in the filled branch with:

```tsx
{
  items.map((item) => {
    const originId = originIdOf(item);
    const tone = toneOf(originId, origin.tones);
    const originLabel =
      origin.labels.get(originId) ??
      t(originId === ONE_OFF_ORIGIN ? "meals.origin.oneOff" : "meals.origin.recurring");
    return (
      // eslint-disable-next-line ui-policy/raw-controls -- Native entry card grows with user content and retains block text flow inside the meal grid.
      <button
        key={item.entryId}
        type="button"
        data-testid="meal-entry-card"
        data-entry-id={item.entryId}
        data-source={item.source}
        data-origin={originId}
        data-emphasis={emphasisOf(originId, origin.selected)}
        title={originLabel}
        className={cn(
          "meal-origin-chip min-h-[var(--control-height)] rounded-xl border px-3 py-2 text-left text-control shadow-xs transition-shadow hover:shadow-md",
          MEAL_ORIGIN_TONE_CLASS[tone]
        )}
        onClick={() => onSelect(date, item)}
      >
        <span className={item.note !== null && !item.isTombstone ? "italic" : undefined}>
          {item.isTombstone ? t("meals.menu.tombstoneLabel") : item.label}
        </span>
      </button>
    );
  });
}
```

(`MealOriginTone` is only needed for the `MealCellOrigin` type.) No `bg-*`, `border-<colour>` or `text-<colour>` utility on the chip.

- [ ] **Step 5: `MealPlanGrid.tsx`.** Import `useMemo` from `react`. Add the `origin?` prop (type from the Interfaces block; import `MealOriginPill`, `MealOriginTone` types and `MealOriginPills`, `MealCellOrigin`). Inside the component:

```ts
const cellOrigin = useMemo<MealCellOrigin | undefined>(
  () =>
    origin && {
      tones: origin.tones,
      selected: origin.selected,
      labels: new Map(origin.pills.map((pill) => [pill.id, pill.label])),
    },
  [origin]
);
```

Render, between the header `div` (`mb-6 flex …`) and the `meal-plan-grid` div:

```tsx
{
  origin && (
    <MealOriginPills
      pills={origin.pills}
      selected={origin.selected}
      onChange={origin.onSelectedChange}
    />
  );
}
```

and pass `origin={cellOrigin}` to every `MealCell`. (Callers must pass a memoised `origin` object or accept the cheap recompute; both pages build it inline — fine, the map is tiny.)

- [ ] **Step 6:** `npx vitest run tests/client/meals-board.test.tsx tests/client/meal-origins.test.tsx` → PASS. `npm run lint -- src/client/meals` (or `npm run lint`) → no new findings.
- [ ] **Step 7: Commit:** `git add src/client/meals tests/client/meals-board.test.tsx && git commit -m "feat(meals): tint meal chips by origin and add highlight pills to the week grid"`

### Task 6: Family `/meals` wiring

**Files:**

- Modify: `src/client/meals/useMealsWorkspace.ts`, `src/client/meals/MealsBoard.tsx`
- Test: `tests/client/meals-board.test.tsx` (new case + add the plans route to every fetch mock in the file), `tests/client/meals-workspace.test.tsx` (plans route + new case), `tests/client/family-surfaces.test.tsx` (fetch-mock route only — density file, report it)

**Interfaces:**

- Consumes: Task 4 `useMealOrigins`; Task 5 `MealPlanGrid.origin`.
- Produces: `MealsWorkspaceState` gains `plans: MealPlan[] | null; plansError: string | null; retryPlans(): Promise<void>;`. Family retry testid `meals-board-plans-retry`.

- [ ] **Step 1: Mocks.** In every `fetch` mock of `tests/client/meals-board.test.tsx` and `tests/client/meals-workspace.test.tsx` that throws on unexpected URLs, add before the throw a route answering `/api/meal-plans` with `[]` (match the file's style, e.g. `if (url.pathname === "/api/meal-plans") return Promise.resolve(Response.json([]));` or `if (url.includes("/api/meal-plans")) return response([]);`). In `tests/client/family-surfaces.test.tsx` `mockMealsBackend`, add only:

```ts
if (url.startsWith("/api/meal-plans")) {
  return Promise.resolve(json([]));
}
```

before `throw new Error(...)`. Change nothing else in that file.

- [ ] **Step 2: Failing tests.** In `tests/client/meals-workspace.test.tsx`:

```ts
it("loads the meal plans and retries them after a failure", async () => {
  let planReads = 0;
  const plans = [{ id: "p1", name: "School", active: true, createdAt: 1, updatedAt: 1 }];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/settings"))
        return response({ locale: { timezone: "UTC", weekStartDay: 1 } });
      if (url.includes("/api/recipes")) return response([]);
      if (url.includes("/api/menu/week")) return response({});
      if (url.includes("/api/meal-plans"))
        return ++planReads === 1 ? response({}, 500) : response(plans);
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
  const { result } = renderHook(() => useMealsWorkspace(), { wrapper });
  await waitFor(() => expect(result.current.plansError).toBe("Failed to load meal plans."));
  expect(result.current.plans).toBeNull();
  await act(() => result.current.retryPlans());
  expect(result.current.plans).toEqual(plans);
  expect(result.current.plansError).toBeNull();
});
```

(Use the file's existing `response` helper; if it has no status argument, build `new Response("{}", { status: 500 })`. Import `act` from `@testing-library/react`.)

In `tests/client/meals-board.test.tsx` add a board test: plans `[{ id: "p1", name: "School lunches", active: true, createdAt: 1, updatedAt: 1 }]`, a week whose 2026-09-25 dinner has a recurring item (`planId: "p1"`, note `"Sandwich"`) and a one-off (`planId: null`, note `"Pizza"`). Assert: the pills `One-off` and `School lunches` render; the recurring chip has class `meal-origin-plan-1`; checking `School lunches` sets the recurring chip `data-emphasis="hit"` and the one-off `dim`; clicking "Next week" keeps the `School lunches` checkbox checked; clicking the dimmed one-off chip opens the dialog (`findByRole("dialog")`) and the dialog has no `radio` named `/^Every /` (family = one-off only). Add a second test: `/api/meal-plans` → 500 shows the alert "Failed to load meal plans." and `getByTestId("meals-board-plans-retry")`; clicking it with the route now returning `[]` removes the alert.

- [ ] **Step 3:** `npx vitest run tests/client/meals-workspace.test.tsx tests/client/meals-board.test.tsx` → new cases FAIL.
- [ ] **Step 4: Workspace.** In `useMealsWorkspace.ts` import `MealPlan`, add to the state interface the three members above, and:

```ts
const [plans, setPlans] = useState<MealPlan[] | null>(null);
const [plansError, setPlansError] = useState<string | null>(null);

const loadPlans = useCallback(async () => {
  try {
    setPlans(await readJson<MealPlan[]>("/api/meal-plans"));
    setPlansError(null);
  } catch {
    setPlansError(t("meals.plan.error"));
  }
}, [t]);

useEffect(() => {
  void loadPlans();
}, [loadPlans]);
```

Return `plans, plansError, retryPlans: loadPlans`.

- [ ] **Step 5: Board.** In `MealsBoard.tsx`:

```tsx
const origins = useMealOrigins(workspace.plans);
```

After the week error/retry block add:

```tsx
<ErrorNotice message={workspace.plansError} />;
{
  workspace.plansError && (
    <Button
      type="button"
      variant="outline"
      className="mb-4"
      data-testid="meals-board-plans-retry"
      onClick={() => void workspace.retryPlans()}
    >
      {t("meals.week.retry")}
    </Button>
  );
}
```

Pass to `MealPlanGrid`:

```tsx
            origin={{
              pills: origins.pills,
              tones: origins.tones,
              selected: origins.selected,
              onSelectedChange: origins.setSelected,
            }}
```

Do not pass `plans` or `initialPlanId` to `MealEntryDialog`.

- [ ] **Step 6:** `npx vitest run tests/client/meals-workspace.test.tsx tests/client/meals-board.test.tsx tests/client/family-surfaces.test.tsx tests/client/meals-household-timezone-error-retry.test.tsx tests/client/today-meals.test.tsx` → PASS. If a `family-surfaces` density case fails for any reason other than the missing route, stop and report; do not edit its assertions.
- [ ] **Step 7: Commit:** `git add src/client/meals tests/client && git commit -m "feat(meals): show origin pills and colours on the family meals page"`

### Task 7: "Free text" rename and dialog plan preselection

**Files:**

- Modify: `src/client/i18n/messages.ts` (values of 4 existing keys, both locales, in place)
- Modify: `src/client/meals/MealEntryDialog.tsx`
- Test: `tests/client/meal-entry-dialog.test.tsx`, `tests/client/meals-i18n-parity.test.ts:102-104,198-200`, and every client test using the old "Note"/"Entry note"/"enter a note" text (list below)

**Interfaces:**

- Produces: `MealEntryDialogProps.initialPlanId?: string`.

- [ ] **Step 1: Values.** In place (keys unchanged):

| Key                             | en                                  | es                                              |
| ------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `meals.entries.contentModeNote` | Free text                           | Texto libre                                     |
| `meals.entries.noteInputLabel`  | Free text                           | Texto libre                                     |
| `meals.entries.notePlaceholder` | Free text                           | Texto libre                                     |
| `meals.entries.contentRequired` | Select a recipe or enter free text. | Selecciona una receta o escribe un texto libre. |

- [ ] **Step 2: Retarget test literals.** `grep -rn '"Note"\|Entry note\|enter a note' tests/client` and replace: `name: "Note"` → `name: "Free text"`, `"Entry note"` → `"Free text"`, `"Select a recipe or enter a note."` → `"Select a recipe or enter free text."`. Files known to need it: `meal-entry-dialog.test.tsx`, `meals-view-refresh-coherence.test.tsx`, `meals-board.test.tsx`, `meals-management.test.tsx` (lines ~250 and ~817 — line ~250 is inside the density test: this is a selector retarget, report it), `meals-i18n-parity.test.ts` (the pinned values at ~102/104/198/200 and the `contentRequired` pins if present). E2E files use `m[...]` keys and need nothing.
- [ ] **Step 3: Failing dialog tests** in `tests/client/meal-entry-dialog.test.tsx` (reuse the file's `recipes`; render like its existing "Repeat" tests with `plans`):

```tsx
const twoPlans: MealPlan[] = [
  { id: "plan-a", name: "School", active: true, createdAt: 1, updatedAt: 1 },
  { id: "plan-b", name: "Simpson", active: true, createdAt: 2, updatedAt: 2 },
  { id: "plan-off", name: "Old", active: false, createdAt: 3, updatedAt: 3 },
];

it("opens a create on 'Every <weekday>' in the preselected plan", async () => {
  const onCreate = vi.fn().mockResolvedValue(true);
  render(
    <MealEntryDialog
      open
      target={{ date: "2026-09-25", slot: "dinner" }}
      recipes={recipes}
      plans={twoPlans}
      initialPlanId="plan-b"
      onClose={vi.fn()}
      onCreate={onCreate}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  expect(screen.getByRole("radio", { name: /^Every / })).toBeChecked();
  expect(screen.getByRole("combobox", { name: "Meal Plan" })).toHaveValue("plan-b");
  fireEvent.click(screen.getByRole("radio", { name: "Free text" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Free text" }), {
    target: { value: "Soup" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      kind: "recurring",
      mealPlanId: "plan-b",
      weekday: "fri",
      slot: "dinner",
      note: "Soup",
    })
  );
});

it("ignores an inactive or unknown preselected plan and stays one-off", () => {
  for (const initialPlanId of ["plan-off", "missing"]) {
    const { unmount } = render(
      <MealEntryDialog
        open
        target={{ date: "2026-09-25", slot: "dinner" }}
        recipes={recipes}
        plans={twoPlans}
        initialPlanId={initialPlanId}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByRole("radio", { name: "Only this date" })).toBeChecked();
    unmount();
  }
});

it("never preselects without plans (the family dialog)", () => {
  render(
    <MealEntryDialog
      open
      target={{ date: "2026-09-25", slot: "dinner" }}
      recipes={recipes}
      initialPlanId="plan-a"
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  expect(screen.queryByRole("radio", { name: /^Every / })).toBeNull();
});
```

(2026-09-25 is a Friday. If the file wraps renders in providers, do the same.)

- [ ] **Step 4:** `npx vitest run tests/client/meal-entry-dialog.test.tsx` → the three new cases FAIL.
- [ ] **Step 5: Implement.** In `MealEntryDialog.tsx` add to the props (after `plans`):

```ts
  /** Admin only, with `plans`: a create opens on "Every <weekday>" in this plan when it is active
   * (one plan pill selected in the grid). Ignored when editing, without `plans`, or when the plan
   * is not an active one. */
  initialPlanId?: string;
```

Destructure it and replace the reset effect's last two lines and deps:

```ts
    const preselected =
      !item && initialPlanId !== undefined && activePlans.some((plan) => plan.id === initialPlanId)
        ? initialPlanId
        : undefined;
    setRepeat(preselected ? "weekly" : "once");
    setPlanId(preselected ?? (activePlans.length === 1 ? activePlans[0].id : ""));
  }, [item, target.date, target.slot, activePlans, initialPlanId]);
```

`offerRepeat` already requires `plans !== undefined`, so the family dialog never shows it.

- [ ] **Step 6:** `npx vitest run tests/client` → PASS except `meals-management.test.tsx` cases that Task 8 restructures (note which fail; they must only be tab/visibility failures).
- [ ] **Step 7: Commit:** `git add src/client tests/client && git commit -m "feat(meals): call notes free text and preselect a plan in the add dialog"`

### Task 8: Admin `/admin/meals` tabs and Preview origins

**Files:**

- Modify: `src/client/admin/MealsManagement.tsx` (imports; state ~line 105–140; render ~line 418–520)
- Test: `tests/client/meals-management.test.tsx`, `tests/client/meals-view-refresh-coherence.test.tsx`, `tests/client/meals-all-slot-picker.test.tsx`, `tests/client/meals-household-timezone-error-retry.test.tsx`, `tests/client/admin-household-timezone-defaults.test.tsx`, `tests/client/meals-recipe-edit-clear-fields.test.tsx` (tab clicks only)

**Interfaces:**

- Consumes: `useMealOrigins` (Task 4), `MealPlanGrid.origin` (Task 5), `MealEntryDialog.initialPlanId` (Task 7).
- Produces: tabs `role="tab"` with testids `meals-tab-preview`, `meals-tab-plans`, `meals-tab-recipes`; panels `role="tabpanel"` ids `meals-tabpanel-<id>`, all mounted, inactive ones `hidden`.

- [ ] **Step 1: Failing tests** in `tests/client/meals-management.test.tsx` (new `describe("MealsManagement — tabs and origins")`, using the file's `mockBackend`, `renderSurface`, `PLAN`, `RECIPE`, `emptyWeek`):

```tsx
it("opens on Preview and switches tabs without losing an open edit", async () => {
  mockBackend();
  renderSurface();
  const preview = await screen.findByRole("tab", { name: "Preview" });
  expect(preview).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("heading", { level: 2, name: "Meals" })).toBeInTheDocument();
  expect(screen.getByTestId("meal-plan-grid")).toBeVisible();
  expect(screen.queryByTestId("meals-plan-card")).not.toBeVisible();

  fireEvent.click(screen.getByRole("tab", { name: "Recipes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(await screen.findByTestId("meals-recipe-edit-name"), {
    target: { value: "Half typed" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "Meal plans" }));
  expect(await screen.findByTestId("meals-plan-card")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Recipes" }));
  expect(screen.getByTestId("meals-recipe-edit-name")).toHaveValue("Half typed");
});

it("preselects the only selected plan pill when adding from a cell", async () => {
  mockBackend();
  renderSurface();
  const pills = await screen.findByRole("group", { name: "Show where meals come from" });
  fireEvent.click(within(pills).getByRole("checkbox", { name: PLAN.name }));
  fireEvent.click(screen.getAllByRole("button", { name: /^Add breakfast on/ })[0]);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("radio", { name: /^Every / })).toBeChecked();
  expect(within(dialog).getByRole("combobox", { name: "Meal Plan" })).toHaveValue(PLAN.id);
});

it("adds a one-off by default when the One-off pill is selected", async () => {
  mockBackend();
  renderSurface();
  const pills = await screen.findByRole("group", { name: "Show where meals come from" });
  fireEvent.click(within(pills).getByRole("checkbox", { name: "One-off" }));
  fireEvent.click(screen.getAllByRole("button", { name: /^Add breakfast on/ })[0]);
  expect(
    within(await screen.findByRole("dialog")).getByRole("radio", { name: "Only this date" })
  ).toBeChecked();
});

it("drops a plan's highlight when the plan is deactivated", async () => {
  // mockBackend's GET /api/meal-plans returns [PLAN]; after the PATCH make it return the plan
  // inactive (use `overrides.plans` with a mutable variable).
  let plans = [PLAN];
  mockBackend({ plans: () => json(plans) });
  renderSurface();
  const pills = await screen.findByRole("group", { name: "Show where meals come from" });
  fireEvent.click(within(pills).getByRole("checkbox", { name: PLAN.name }));
  plans = [{ ...PLAN, active: false }];
  fireEvent.click(screen.getByRole("tab", { name: "Meal plans" }));
  // The plan's StatusToggle is a pressed button (aria-pressed) inside the plan card.
  fireEvent.click(
    within(await screen.findByTestId("meals-plan-card")).getByRole("button", { pressed: true })
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
```

`admin.sidebar.meals` is "Meals" (en). The plan's activate control is `StatusToggle` (`pressed={plan.active}`, MealsManagement.tsx ~line 1006); if more than one pressed button exists in the card, narrow by its accessible name as the existing plan toggle tests in this file do. `toBeVisible` relies on jsdom honouring `hidden` (it does via `display: none` in RTL's visibility check of ancestors).

- [ ] **Step 2:** `npx vitest run tests/client/meals-management.test.tsx -t "tabs and origins"` → FAIL.
- [ ] **Step 3: Implement.** In `MealsManagement.tsx`:
  - imports: `useMealOrigins` from `@/meals/meal-origins`.
  - module scope:

```ts
type MealsTab = "preview" | "plans" | "recipes";
const MEALS_TABS: readonly MealsTab[] = ["preview", "plans", "recipes"];
const TAB_LABEL_KEYS: Record<MealsTab, MessageKey> = {
  preview: "meals.tabs.preview",
  plans: "meals.tabs.plans",
  recipes: "meals.tabs.recipes",
};
```

- with the other state, **before** the `if (!settingsReady)` early return (hooks must not follow it):

```ts
const [tab, setTab] = useState<MealsTab>("preview");
const origins = useMealOrigins(plans);
// Captured when the add starts, so the dialog keeps its plan even if the pills change meanwhile.
const [entryInitialPlanId, setEntryInitialPlanId] = useState<string | undefined>(undefined);
```

- Update the file's header doc comment: three local-state tabs (Preview default, Meal plans, Recipes), all mounted and hidden when inactive so open edits survive a switch (spec D8); never URL sub-routes.
- Render: keep `<ErrorNotice message={error} />` and the recipes Retry above the tabs. Then:

```tsx
<div
  role="tablist"
  aria-label={t("meals.tabs.label")}
  className="bg-muted mt-4 flex w-fit max-w-full flex-wrap gap-1 rounded-lg border p-1"
>
  {MEALS_TABS.map((id) => (
    <Button
      key={id}
      id={`meals-tab-${id}`}
      type="button"
      role="tab"
      variant={tab === id ? "default" : "ghost"}
      aria-selected={tab === id}
      aria-controls={`meals-tabpanel-${id}`}
      data-testid={`meals-tab-${id}`}
      onClick={() => setTab(id)}
    >
      {t(TAB_LABEL_KEYS[id])}
    </Button>
  ))}
</div>
```

- Wrap the three existing sections in panels, removing their `<h3>` headings:

```tsx
<div
  role="tabpanel"
  id="meals-tabpanel-preview"
  aria-labelledby="meals-tab-preview"
  hidden={tab !== "preview"}
  className="mt-6"
>
  {/* former week section body: editHint <p>, week error + Retry, MealPlanGrid, MealEntryDialog */}
</div>
```

(same for `plans` → `MealPlanManagement`, and `recipes` → search form, `RecipeCreateForm`, list). Write the bodies by moving the existing JSX unchanged except for the edits below.

- `MealPlanGrid` gets:

```tsx
          origin={{
            pills: origins.pills,
            tones: origins.tones,
            selected: origins.selected,
            onSelectedChange: origins.setSelected,
          }}
          onAdd={(date, slot) => {
            setEntryInitialPlanId(origins.preselectPlanId);
            setEntryTarget({ date, slot });
          }}
          onSelect={(date, item) => {
            setEntryInitialPlanId(undefined);
            setEntryTarget({ date, slot: item.slot, item });
          }}
```

- `MealEntryDialog` gets `initialPlanId={entryInitialPlanId}`.
- [ ] **Step 4:** `npx vitest run tests/client/meals-management.test.tsx -t "tabs and origins"` → PASS.
- [ ] **Step 5: Retarget the other admin tests (no assertion semantics change).** For each failing case in `meals-management.test.tsx` (non-density), `meals-view-refresh-coherence.test.tsx`, `meals-all-slot-picker.test.tsx`, `meals-recipe-edit-clear-fields.test.tsx`, `meals-household-timezone-error-retry.test.tsx`, `admin-household-timezone-defaults.test.tsx`: insert `fireEvent.click(await screen.findByRole("tab", { name: "Meal plans" }))` (or `"Recipes"` / `"Preview"`) before the first query that targets a control in that panel. Do not change what is asserted. Update the `recipeCard()` doc comment ("Recipes renders last…") to "in the Recipes tab".
- [ ] **Step 6: Density test retarget (owner rule O8 — selectors only, report it).** In the `MealsManagement — kiosk density` test only:
  - Before `await screen.findByRole("heading", { name: RECIPE.name })`, add `fireEvent.click(await screen.findByRole("tab", { name: "Recipes" }));`.
  - Before opening the plan rename (`within(planCard())…`), add `fireEvent.click(screen.getByRole("tab", { name: "Meal plans" }));`.
  - Phase 2 already queries `"Free text"` (Task 7) and `findAllByPlaceholderText("Free text")`.
  - Before phase 3's `within(recipe).getByRole("button", { name: "Cancel" })`, add `fireEvent.click(screen.getByRole("tab", { name: "Recipes" }));`.
  - Before phase 4's `getAllByRole("button", { name: /^Add breakfast on/ })`, add `fireEvent.click(screen.getByRole("tab", { name: "Preview" }));`.
  - Run it, then set `PHASE_1_COUNT`..`PHASE_4_COUNT` to the measured values. Expected delta: **+5 in every phase** (3 tabs + 2 origin pills: One-off and `Weeknights`), i.e. 79, 79, 74, 81. If the delta differs, find out why before changing the constant and explain it in the report. Do not touch the "DELIBERATE NEGATIVE" case.
- [ ] **Step 7:** `npx vitest run tests/client` → all PASS.
- [ ] **Step 8: Commit:** `git add src/client/admin/MealsManagement.tsx tests/client && git commit -m "feat(admin): split meals into Preview, Meal plans and Recipes tabs with origin highlights"`

### Task 9: E2E and UI docs

**Files:**

- Modify: `tests/e2e/admin-meals.spec.ts`, `tests/e2e/meals.spec.ts` (extend existing tests; do NOT rename them, so their Playwright ids stay)
- Modify: `docs/ui/household-contract.md` (line ~83 and a new paragraph after the Dashboard section)

- [ ] **Step 1: Admin e2e.** In `admin-meals.spec.ts` add a helper `const openTab = (key: keyof typeof m) => page.getByRole("tab", { name: m[key] }).click();` after `m` is known. Then:
  - Right after the page heading assertion: `await expect(page.getByRole("tab", { name: m["meals.tabs.preview"] })).toHaveAttribute("aria-selected", "true");` and replace `await expect(planEntries).toBeVisible();` with a tab round-trip: `await openTab("meals.tabs.plans"); await expect(planEntries).toBeVisible(); await openTab("meals.tabs.preview");`.
  - Where step 2 asserts `planEntries.getByText(weekly)` and step 3 asserts `planEntries.getByText(weeklyEdited)`: wrap each in `openTab("meals.tabs.plans")` … `openTab("meals.tabs.preview")`.
  - New step between 3 and 4 (origin highlight + preselection):

```ts
// 3b. Highlight this run's plan: its meal stands out, the one-off greys out in place; adding
// from a cell opens on "Every <weekday>" in this plan.
const planPill = page.getByTestId(`meal-origin-pill-${planId}`);
await planPill.check();
const weeklyChip = grid.getByRole("button", { name: weeklyEdited });
const oneOffChip = grid.getByRole("button", { name: oneOff });
await expect(weeklyChip).toHaveAttribute("data-origin", planId!);
await expect(weeklyChip).toHaveAttribute("data-emphasis", "hit");
await expect(oneOffChip).toHaveAttribute("data-emphasis", "dim");
await openAddDialog(page, today, "breakfast");
dialog = page.getByRole("dialog");
await expect(
  dialog.getByRole("radio", { name: new RegExp(`^${m["meals.entries.repeatWeeklyPrefix"]} `) })
).toBeChecked();
await expect(dialog.getByRole("combobox", { name: m["meals.plan.selectLabel"] })).toHaveValue(
  planId!
);
await dialog.getByRole("button", { name: m["meals.action.cancel"] }).click();
await expect(dialog).toBeHidden();
await planPill.uncheck();
await expect(oneOffChip).toHaveAttribute("data-emphasis", "normal");
```

- Update the file's header comment to mention tabs and the highlight step.
- [ ] **Step 2: Family e2e.** In `meals.spec.ts`, after `await expect(reloadedCell.getByText(secondNote, { exact: true })).toBeVisible();` add:

```ts
const firstChip = reloadedCell.getByRole("button", { name: firstNote, exact: true });
await expect(firstChip).toHaveAttribute("data-origin", "oneoff");
await expect(firstChip.locator("span.italic")).toHaveText(firstNote);
const oneOffPill = page.getByRole("checkbox", { name: m["meals.origin.oneOff"], exact: true });
await oneOffPill.check();
await expect(firstChip).toHaveAttribute("data-emphasis", "hit");
await oneOffPill.uncheck();
await expect(firstChip).toHaveAttribute("data-emphasis", "normal");
```

- [ ] **Step 3: Run** `PORT=43241 MP_E2E_WEATHER_FIXTURE_PORT=44461 MP_E2E_QUOTE_FIXTURE_PORT=44471 npx playwright test tests/e2e/admin-meals.spec.ts tests/e2e/meals.spec.ts tests/e2e/accessible-names-audit.spec.ts tests/e2e/household-dashboard.spec.ts` → PASS. `npm run check:accessible-names` → PASS.
- [ ] **Step 4: Docs.** `docs/ui/household-contract.md`: replace the `/admin/meals` line with:

`5. `/admin/meals` — Meals: three tabs (local state, no sub-paths). Preview (default): the editable family week grid with origin pills; a cell adds a one-off or, via "Every <weekday>", a recurring entry in an active plan (preselected when exactly one plan pill is selected); a meal opens for content edit or delete, and recurring changes apply every week. Meal plans: each plan lists its recurring entries by weekday with an in-card add form and activate/deactivate. Recipes: search, create, edit, delete with dependent counts.`

Add after the Dashboard section's paragraphs:

```markdown
## Meals

`/meals` and the admin Preview share one week grid. Each meal is tinted with its origin: a warm grey
for a one-off, and one automatic colour per meal plan by plan creation order (never stored, never
user-chosen). Free-text meals are italic. Origin pills ("One-off" and every active plan) highlight
and never filter: selected origins' meals take a stronger tint, solid border and semibold text, the
rest grey out in place and stay editable. The family add dialog creates one-offs only. Today's
meals on Home are unchanged.
```

- [ ] **Step 5:** `npx prettier --write` on the changed files; commit: `git add tests/e2e docs/ui && git commit -m "test(e2e): cover meal origin highlights and admin meals tabs; document them"`

### Task 10: Inventory resync (`tests/fixtures/assembly-cohort.json`)

- [ ] **Step 1:** `export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs) && npm run test:cohorts:stamp && npm run test:cohorts:vitest:list && npm run test:cohorts:vitest` (the tree must be committed first; untracked files such as `.env.local` change the candidate — if so, run this in the detached checkout of Task 11 Step 2 and copy the outputs back).
- [ ] **Step 2: Vitest cases.** In `testCohorts.runners.vitest.files`, update case names exactly as `.quality/vitest-list.json` prints them (same join format as neighbours) for: `tests/boundary/meals-menu.test.ts` (+1), `tests/boundary/seed-meals.test.ts`, `tests/integration/seed-meals.test.ts` (titles unchanged unless you renamed), `tests/client/meal-origins.test.tsx` (new file, 8 cases), `tests/client/pill-toggle.test.tsx` (+2), `tests/client/meals-board.test.tsx` (+3), `tests/client/meals-workspace.test.tsx` (+1), `tests/client/meal-entry-dialog.test.tsx` (+3, and any renamed title containing "note"), `tests/client/meals-management.test.tsx` (+4).
- [ ] **Step 3: Playwright.** `npm run test:cohorts:e2e:list` and compare `.quality/playwright-list.json` ids for `admin-meals.spec.ts` and `meals.spec.ts` with the fixture; titles were not changed, so ids should match. Fix only if they differ.
- [ ] **Step 4: Coverage.** Add entries for the new sources `src/client/meals/meal-origins.ts` and `src/client/meals/MealOriginPills.tsx` (layer `client`), and remeasure the touched files: `src/client/components/PillControl.tsx`, `src/client/components/PillToggle.tsx`, `src/client/meals/MealCell.tsx`, `src/client/meals/MealPlanGrid.tsx`, `src/client/meals/MealsBoard.tsx`, `src/client/meals/useMealsWorkspace.ts`, `src/client/meals/MealEntryDialog.tsx`, `src/client/admin/MealsManagement.tsx`, `src/server/modules/meals/index.ts`. Use the resync script from `docs/superpowers/plans/2026-10-15-admin-shared-pills.md` Task 7 Step 2 (copy it to your scratch dir and run it with these paths). Rules: `minimumTotals` drop only where code shrank; never lower `minimumRates`. If a rate falls, add a test, not a lower number. New files must be at 100% lines/statements/functions.
- [ ] **Step 5:** `npx prettier --write tests/fixtures/assembly-cohort.json`; `git diff --stat` must show only those entries. Commit: `git commit -am "test: resync the reviewed inventory for meal origins"`.

### Task 11: Gate, report

- [ ] **Step 1:** `git status --porcelain` empty.
- [ ] **Step 2: Standard gate in a detached clean checkout** (untracked files break the candidate inventory):

```bash
SCRATCH=$(mktemp -d)
git worktree add --detach "$SCRATCH/verify" HEAD
ln -s "$PWD/node_modules" "$SCRATCH/verify/node_modules"
cd "$SCRATCH/verify"
export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)
npm run check:standard
```

Expected exit 0. On `check:coverage` / `check:test-cohorts:standard` failure: fix the fixture in your worktree (Task 10), commit, `git worktree remove --force "$SCRATCH/verify"`, recreate, rerun. If `check:ui-debt` reports more inline styles/literals than its baseline, remove what you added.

- [ ] **Step 3: Aggregate gate** (same verify checkout, same `MP_CANDIDATE_ID`):

```bash
PORT=43241 MP_E2E_WEATHER_FIXTURE_PORT=44461 MP_E2E_QUOTE_FIXTURE_PORT=44471 npm run check:aggregate-only
```

Expected exit 0. A failure only on a 5 s timeout in a file you did not touch: rerun that file alone and note it.

- [ ] **Step 4: Report.** Back in your worktree, write `REPORT-meals-origin.md`: branch name, worktree path, `git log --oneline main..HEAD`, the last lines of both gates, the fresh-DB `npm run seed` result (Task 2 Step 5), the e2e result, **every density-test edit** (`meals-management.test.tsx`: tab clicks, "Free text" names, `PHASE_*_COUNT` old → new with the reason; `family-surfaces.test.tsx`: the `/api/meal-plans` mock route), and any deviation from the spec with its reason. `git add REPORT-meals-origin.md && git commit -m "docs: report the meals origin work"`. Do not merge or push. Reply exactly `DONE` followed by the branch name.

## Owner addendum (2026-10-16)

- Kiosk density tests: the owner does not want them to block this work. Update their counts, selectors and fixtures as the new UI requires (tabs, pills, the `/api/meal-plans` route) without asking; do not add new density tests.
- No "Clear" button next to the origin pills (few options).
- Plan preselection from any add in a cell (empty cell or "+") is fine.
- Extra task (orchestrator): `src/client/admin/DailyMessagesManagement.tsx` has a timing-dependent branch. Its reviewed branch floor is exactly 74/95 (77.89%), and CI failed once on PR #42 with fewer covered branches, then passed on a plain rerun of the same commit. Find which branch is only covered when an async response lands before the test ends (compare per-branch coverage across a few runs, or read the component's async paths), and add a deterministic test that always covers it. Do not lower its minimumRates.
