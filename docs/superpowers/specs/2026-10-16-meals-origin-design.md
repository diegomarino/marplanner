# Meals origin colours, origin pills and admin tabs — design

Date: 2026-10-16. Status: owner decisions final (review waived); this document records them and the
choices made where the owner left an option open.

Visual reference: the interactive mockup `meals-origin.html`, **variant D** ("Plan colour as the
chip"). Its CSS values are binding and are copied below; the file itself is not in the repository.

Base: `main` after PR #42 (`feat/admin-pill-style`, one member-pill style) is merged. Code paths
below were verified against that branch.

## 1. Intent

A meal in the week grid today says _what_ is eaten (a recipe or free text) but not _where it comes
from_: a meal plan's weekly entry or a one-off added for that date. The owner wants that origin
visible at a glance on both grids (admin Preview and the family `/meals` page), and a way to
highlight one or more origins without hiding the rest. Separately, the admin Meals page becomes
three tabs, "Note" is renamed "Free text" in the UI, and the add dialog can preselect a plan.

Success: on the seeded demo week, each meal chip is tinted by its origin; selecting the "School
lunches" pill makes its meals stand out in the plan's colour while everything else greys out in
place and stays editable; in admin, clicking an empty cell with only that pill selected opens the
dialog on "Every <weekday>" in that plan.

## 2. Owner decisions (verbatim intent)

| #   | Decision                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | `/admin/meals` has 3 tabs: **Preview** (the editable week grid, default), **Meal plans** (each plan with its recurring entries, as today), **Recipes**. Local state, no URL sub-routes (admin sub-paths relock the admin; `src/client/shell/routes.ts`). Page heading stays the sidebar label. |
| O2  | **Origin** = `oneoff` or a specific meal plan. Distinct from content (recipe vs free text). `MenuItem` gains a nullable `planId` (set for recurring items) in the day and week menu responses — additive server change, OpenAPI, feature doc FR, boundary tests.                               |
| O3  | Plan colours are **automatic** (no migration, no stored colour): a stable order assigns a colour from a small palette kept apart from the ten member colours and the amber "today" accent; one-off is a warm grey. Palette as tokens in `src/client/styles`, no colour literals in components. |
| O4  | Variant D on **both** admin Preview and family `/meals` (shared `MealPlanGrid`/`MealCell`): origin-tinted chips; free text in italics; origin pills above the grid; pills **highlight, never filter**. "Today's meals" home widget unchanged.                                                  |
| O5  | "Note" → "Free text" / "Texto libre" in the UI only. API field stays `note`.                                                                                                                                                                                                                   |
| O6  | Add dialog: exactly one **plan** pill selected + add from a cell → dialog preselects "Every <weekday>" in that plan; otherwise one-off (today's behaviour). Admin-only, as today.                                                                                                              |
| O7  | Regenerate the demo meals seed (`seeds/seed-060-meals.ts`): at least two active plans with recurring entries across weekdays and slots (some free text) and one-offs (recipe and free text) in the current and next week, ids stable, rolling pattern kept.                                    |
| O8  | Do not add or change kiosk density tests. If one breaks only because the DOM changed, retarget its selectors and report it.                                                                                                                                                                    |

## 3. Decisions taken here (open points the owner delegated)

- **D1 — Colour order.** A plan's colour index is its position among **all** plans (active and
  inactive) sorted by `createdAt` ASC, then `id` ASC, modulo 6. Rationale: creation order never
  changes, so renaming, (de)activating or adding another plan never recolours an existing one;
  including inactive plans keeps a plan's colour when it is reactivated. A seventh plan reuses
  plan-1's colour (the pill names still disambiguate). Computed on the client from
  `GET /api/meal-plans`; nothing is stored.
- **D2 — Pills shown.** "One-off" first, then **every active plan** ordered by name ASC, id ASC
  (the menu order of FR-004), whether or not it has meals in the visible week. Rationale: a pill
  row that does not reshuffle while navigating weeks, and it doubles as the colour legend. Inactive
  plans contribute nothing to the grid, so they get no pill.
- **D3 — Selection state** is per page (`useState`), survives week navigation, is not persisted,
  and silently drops ids whose pill disappears (a plan deactivated or renamed away does not leave a
  ghost selection).
- **D4 — Pill component.** Extend the internal drawing primitive `PillControl` with a
  `tone: "default" | "colour"` option that draws a "coloured pill" from two caller-set custom
  properties (`--pill-color`, `--pill-color-selected`), and expose it through the existing L2
  `PillToggle` as one optional prop `colorClassName`. No new shared component. The origin pill row
  is a small feature component `src/client/meals/MealOriginPills.tsx` (a `role="group"` of
  `PillToggle`s with a visible label), not a shared UI component.
- **D5 — No "Clear" button.** The mockup had one; the owner's decisions do not. Deselecting a pill
  is one tap. YAGNI.
- **D6 — Unknown origin.** A recurring item whose `planId` is not in the loaded plan list (plans
  still loading, failed to load, or a plan created elsewhere since) uses tone `unknown`
  (`--muted-foreground` as its colour) and has no pill; with any selection active it is dimmed.
- **D7 — Family plan load.** `/meals` now reads `GET /api/meal-plans` (the API key boundary is the
  only server authorization; there is no admin-only route). A failure shows `meals.plan.error`
  with a Retry button (testid `meals-board-plans-retry`); the grid still renders, pills show only
  "One-off", and recurring chips use tone `unknown`.
- **D8 — Admin tabs keep all three panels mounted** and hide the inactive ones with the `hidden`
  attribute (unlike Printing, which unmounts). Rationale: an open recipe edit, plan rename or
  half-filled recurring form survives a tab switch, the plan cards do not refetch on every switch,
  and the existing kiosk density test keeps measuring the same control set (it only needs tab
  clicks to reach controls, see O8). Page-level errors (recipes load failure + Retry) stay above
  the tabs. The per-section `<h3>` headings ("Week Menu", "Meal Plans", "Recipes") are removed: the
  tab names now label each panel (`role="tabpanel"` + `aria-label`). The now-unused
  `meals.plan.title` key stays in the catalog (pinned by `meals-i18n-parity.test.ts`).
- **D9 — Preselection trigger.** "Clicks an empty cell" is implemented as **any add action in a
  cell** (the empty cell itself or the "+" of a filled cell): both mean "add a meal here".
  Preselection applies only when exactly one pill is selected, that pill is a plan (not
  "One-off"), and the plan is active.
- **D10 — Origin in the accessible name.** Not added (it would break every exact-name query and
  lengthen screen-reader output per chip). The chip gets `title="<origin name>"` (accessible
  description and hover tooltip) and `data-origin`. Colour is not the only signal: the pills plus
  the highlight state name the origin.
- **D11 — Seed colour order.** "School lunches" is upserted with `nowMs + 1` so that on a fresh
  database "Simpson Family Week" keeps the first plan colour (sage) and "School lunches" gets the
  second (clay), matching the mockup.

## 4. Server: `planId` on `MenuItem` (O2)

- `src/shared/index.ts` `MenuItem` gains `planId: string | null;` (after `source`).
- `src/server/modules/meals/index.ts` `rowToMenuItem` sets `planId: row.meal_plan_id`. Both
  `MENU_UNION_SQL` and `MENU_UNION_SLOT_SQL` already project `meal_plan_id` (NULL in the one-off
  branch). `getWeekMenu` reuses `getMenu`, so both endpoints carry it. Invariant:
  `planId !== null ⇔ source === "recurring"`.
- Consumers: `GET /api/menu`, `GET /api/menu/week`, host-API `getMenu` (Daily Briefing's meals
  block maps to `BriefingMealItem` and ignores the field; briefing snapshots are unchanged).
- `docs/api/meals/openapi.yaml` `MenuItem`: add `planId` to `required`, type `[string, "null"]`,
  with a description. `check:openapi-shapes` compares `required` against the DTO, so the DTO field
  must be non-optional.
- `docs/features/meals-recipes.md`: new **FR-025** (planId) and **FR-026** (origin presentation),
  both "Contract: none (admin parity)" like `daily-briefing.md` FR-025..028.

## 5. Tokens and CSS (O3, O4)

`src/client/styles/tokens.css` (single definition site, after the meal-slot tokens):

```css
/* Meal origins: one muted hue per meal plan (by creation order) and a warm grey for one-off
   meals, kept apart from the high-chroma member colours and the amber "today" accent. */
--meal-origin-oneoff: oklch(0.62 0.01 60);
--meal-origin-plan-1: oklch(0.52 0.09 150); /* sage */
--meal-origin-plan-2: oklch(0.52 0.11 30); /* clay */
--meal-origin-plan-3: oklch(0.5 0.08 250); /* slate */
--meal-origin-plan-4: oklch(0.5 0.09 330); /* plum */
--meal-origin-plan-5: oklch(0.52 0.08 200); /* lagoon */
--meal-origin-plan-6: oklch(0.5 0.07 60); /* umber */
```

Member colours are chroma 0.19 at L 0.48; the plan palette stays at chroma ≤ 0.11, so plans read
as muted/earthy next to member pills. Amber "today" is L 0.78 C 0.17 h 85; no plan hue sits there.

`src/client/styles/globals.css`, inside the existing `@layer components` (next to
`.member-event-surface`):

```css
.meal-origin-oneoff {
  --meal-origin: var(--meal-origin-oneoff);
}
.meal-origin-plan-1 {
  --meal-origin: var(--meal-origin-plan-1);
}
/* … plan-2 … plan-6 identically … */
.meal-origin-unknown {
  --meal-origin: var(--muted-foreground);
}

/* Chip: light tint + border in the origin colour (variant D). */
.meal-origin-chip {
  background: color-mix(in oklch, var(--meal-origin) 16%, var(--card));
  border-color: color-mix(in oklch, var(--meal-origin) 55%, var(--card));
  color: var(--foreground);
}
/* A selected origin: stronger tint, solid border, semibold. */
.meal-origin-chip[data-emphasis="hit"] {
  background: color-mix(in oklch, var(--meal-origin) 38%, var(--card));
  border-color: var(--meal-origin);
  font-weight: 600;
}
/* Another origin is selected: greyed in place, still clickable. */
.meal-origin-chip[data-emphasis="dim"] {
  background: var(--muted);
  border-color: var(--border);
  color: var(--muted-foreground);
}
/* Origin pill: feeds PillControl's coloured tone. */
.meal-origin-pill {
  --pill-color: var(--meal-origin);
  --pill-color-selected: color-mix(in oklch, var(--meal-origin) 38%, var(--card));
}
```

The chip must not carry Tailwind `bg-*`/`border-<colour>`/`text-<colour>` utilities: utilities
beat the components layer. It keeps `border` (width), radius, padding, `text-control`, shadow.

## 6. Client units

| Unit                                         | Responsibility                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/client/meals/meal-origins.ts` (new)     | Pure origin model + `useMealOrigins` hook: tones by creation order, pills, chip emphasis, preselected plan.         |
| `src/client/meals/MealOriginPills.tsx` (new) | The labelled pill row (`role="group"`), one `PillToggle` per origin.                                                |
| `src/client/components/PillControl.tsx`      | New `tone` option (`"default"` unchanged, `"colour"`).                                                              |
| `src/client/components/PillToggle.tsx`       | New optional `colorClassName` → `tone="colour"`, `reserveBoldLabel`.                                                |
| `src/client/meals/MealCell.tsx`              | Chip tone class, `data-origin`, `data-emphasis`, `title`, italic free text.                                         |
| `src/client/meals/MealPlanGrid.tsx`          | Optional `origin` prop: renders `MealOriginPills` between the header and the grid; passes tones/selection to cells. |
| `src/client/meals/useMealsWorkspace.ts`      | Loads plans (`plans`, `plansError`, `retryPlans`).                                                                  |
| `src/client/meals/MealsBoard.tsx`            | Wires `useMealOrigins`; plans error + Retry. No `plans`/`initialPlanId` to the dialog (family = one-off only).      |
| `src/client/meals/MealEntryDialog.tsx`       | Optional `initialPlanId` preselects "weekly" + that plan; Free-text labels come from i18n.                          |
| `src/client/admin/MealsManagement.tsx`       | Three tabs; Preview wires `useMealOrigins` and `initialPlanId`.                                                     |

`meal-origins.ts` API (exact):

```ts
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
export const MEAL_ORIGIN_TONE_CLASS: Record<MealOriginTone, string>;
export function planTones(plans: readonly MealPlan[]): ReadonlyMap<string, MealOriginTone>;
export function originIdOf(item: MenuItem): string; // item.planId ?? ONE_OFF_ORIGIN
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

`MealPlanGrid` new prop (optional so standalone renders keep working):

```ts
origin?: {
  pills: MealOriginPill[];
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: readonly string[];
  onSelectedChange(next: string[]): void;
};
```

Without `origin`, chips use `toneOf(originIdOf(item), new Map())` (one-off → `oneoff`, recurring
→ `unknown`) and emphasis `normal`, and no pill row renders.

## 7. Behaviour

- **Chip:** `data-origin` = `planId ?? "oneoff"`, `data-emphasis` ∈ normal/hit/dim, `title` = the
  pill label of its origin (plan name, "One-off", or "Recurring" for unknown). Label in italics
  when `item.note !== null` (free text). Tombstones keep the origin tint, no italics.
- **Pills:** checkbox semantics; unchecked = muted ground + muted text (member-pill D look);
  checked = `--pill-color-selected` ground, `--pill-color` border, foreground text, semibold; label
  reserves its bold width. No dot.
- **Highlight:** with no selection every chip is `normal`; with a selection, chips of selected
  origins are `hit`, all others `dim`. Nothing is hidden or reordered; dim chips open the dialog.
- **Dialog preselection (admin):** `initialPlanId = preselectPlanId` when the add came from a
  cell. Editing an existing meal never preselects (Repeat is not offered when editing).
- **Admin tabs:** tablist like `PrintingManagement` (`role="tablist"`, `Button role="tab"`,
  `aria-selected`, testids `meals-tab-preview|plans|recipes`), panels `role="tabpanel"` with
  `aria-label` and `hidden` when inactive. Preview default.
- **Free text rename:** values of existing keys change in place (keys unchanged):
  `meals.entries.contentModeNote` "Free text"/"Texto libre", `meals.entries.noteInputLabel`
  "Free text"/"Texto libre", `meals.entries.notePlaceholder` "Free text"/"Texto libre",
  `meals.entries.contentRequired` "Select a recipe or enter free text." / "Selecciona una receta o
  escribe un texto libre.".

## 8. i18n (new keys, one `// meals-origin` block per locale, after `// admin-settings-polish`)

| Key                       | en                         | es                                  |
| ------------------------- | -------------------------- | ----------------------------------- |
| `meals.tabs.label`        | Meals sections             | Secciones de comidas                |
| `meals.tabs.preview`      | Preview                    | Vista previa                        |
| `meals.tabs.plans`        | Meal plans                 | Planes de comidas                   |
| `meals.tabs.recipes`      | Recipes                    | Recetas                             |
| `meals.origin.groupLabel` | Show where meals come from | Mostrar de dónde vienen las comidas |
| `meals.origin.oneOff`     | One-off                    | Puntual                             |
| `meals.origin.recurring`  | Recurring                  | Recurrente                          |

## 9. Seed (O7)

`seeds/seed-060-meals.ts` keeps every existing id and the rolling pattern, and adds:

- Plan `demo:meal-plan:school-lunches` "School lunches" (upserted with `nowMs + 1`, D11).
- Simpson Family Week gains two free-text recurring entries using the existing id pattern
  `demo:meal-entry:recurring:<weekday>:<slot>`: `tue dinner "Leftovers night"`,
  `sat breakfast "Waffles with Grampa"`.
- School lunches entries, id `demo:meal-entry:recurring:school-lunches:<weekday>:<slot>` (a new
  prefix so they never collide with Simpson's ids): `mon lunch` Marge's Spaghetti, `tue lunch`
  "Sandwich and fruit", `wed lunch` Lisa's Lentil Stew, `thu lunch` Steamed Hams, `thu snack`
  Apu's Samosas, `fri lunch` "Sandwich and fruit".
- One more rolling one-off: `at(11, "dinner", "next-dinner-note", { note: "Takeout from Luigi's" })`
  (free text next week; the current week already has recipe and free-text one-offs).

Every origin then has meals in the current and next week (recurring entries repeat weekly; one-offs
exist in both weeks).

## 10. Tests and docs

- Boundary: `planId` on day, slot-filtered and week reads (recurring = its plan id, one-off =
  null); existing exact `MenuItem` assertions gain `planId`; seed tests updated to the new seed.
- Client: `meal-origins` pure tests; `MealOriginPills`; `PillToggle` coloured tone; `MealCell`
  tone/emphasis/italics/title; `MealsBoard` pills + highlight + plans error/Retry;
  `MealEntryDialog` `initialPlanId`; admin tabs + preselection; label renames.
- E2E: extend the existing tests in `admin-meals.spec.ts` and `meals.spec.ts` (titles unchanged,
  so Playwright ids stay).
- Density (O8): `meals-management.test.tsx` density test — retarget only (tab clicks, "Free text"
  names, re-measured `PHASE_*_COUNT`); `family-surfaces.test.tsx` — add the `/api/meal-plans` route
  to its fetch mock only. Both reported.
- Docs: `docs/ui/household-contract.md` (admin meals line + a short family Meals paragraph),
  `docs/ui/component-contract.md` (Pill toggle row), `docs/features/meals-recipes.md`,
  `docs/api/meals/openapi.yaml`.

## 11. Out of scope

Stored or user-chosen plan colours; filtering; persisting the selection; the home "Today's meals"
widget; Daily Briefing; plan pills inside the admin "Meal plans" tab; a "Clear" control.
