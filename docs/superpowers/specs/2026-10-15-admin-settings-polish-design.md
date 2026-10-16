# Admin Settings polish: two columns, aligned weather grid, one Save, four always-editable day periods

Date: 2026-10-15. Status: approved by delegation (owner waived review). Base: main after PR #38 and the shared-pills wave. Slug `settings-polish`.

## Owner feedback (requirement)

1. Settings (locale) and Weather side by side in 2 columns; stacked on narrow screens.
2. Weather form as a real grid: labels in one column, inputs sharing the same left and right edges.
3. One Save below the two columns, enabled as soon as any input differs from the stored value, disabled again when edits are reverted.
4. Day periods: 4 columns (one per period), inputs always editable, no "Edit" mode and no layout jump.

## Current state (read at feat/admin-parity, e8f44121 + dd859714)

- `src/client/admin/SettingsManagement.tsx`: one vertical `flex-col gap-8` stack: locale `AdminPanel`, then `PluginContribution` -> `WeatherManagement` (its own `AdminPanel`), then the Save row (`settings-save`, `settings-saved`, scope note), then `DayPeriodsManagement`. Dirty logic already exists: `localeDirty`, `weatherDirty` (compares against `persisted`), `canSave = !saving && (localeDirty || weatherDirty) && problem === null`. It already disables again on revert because it compares to `persisted`, so item 3 needs a pinning test, not new logic.
- `src/client/admin/WeatherManagement.tsx`: each field is `<label className={LABEL_INLINE_CLASSES}>caption<Input className="w-auto"/></label>`, so inputs start after their caption and zig-zag. `weatherFormProblem` holds the decimal-only check (`DECIMAL` regex, commit dd859714).
- `src/client/admin/DayPeriodsManagement.tsx`: vertical list of cards; each has an `Edit` button that swaps the card into an editor (time input, Save, Cancel). `refreshPeriods()` sets `loading` which renders a "Loading..." paragraph above the list on every refresh. Own PATCH per period (`/api/day-periods/:id`); the server validates the whole ordering with only that period changed (`editDayPeriodStart`).
- Layout shell: `AdminRoutes.tsx` puts a `lg:w-60` sidebar beside the content (`min-w-0 flex-1 p-4 lg:p-6`), so viewport breakpoints overstate the content width. Tailwind is v4 (container queries available: `@container`, `@2xl:`).

## Decisions

- D1 Two columns by **container query**, not viewport: the page root gets `@container`; the columns grid is `grid items-start gap-6 @2xl:grid-cols-2` (>= 672px of content). Below that it stacks, Settings first. If the weather plugin contributes nothing, the Settings column simply stays at half width (no special case).
- D2 The grid holds the locale `AdminPanel` (left) and `PluginContribution` -> `WeatherManagement` (right). The Save row moves below the grid, full width, unchanged (testids, "Saved" auto-hide, scope note). Save logic is not changed.
- D3 Weather fields: inside the existing card use `grid grid-cols-1 gap-x-3 gap-y-3 @sm:grid-cols-[max-content_1fr] items-center`. Each field is a `Label` (`htmlFor`, id from `useId`) in column 1 and an `Input className="w-full min-w-0"` in column 2; hint and the Locate/Clear row span both columns (`@sm:col-span-2`). All inputs therefore share identical left and right edges. Testids (`weather-lat-input`, `weather-lon-input`, `weather-label-input`, `weather-hint`, `weather-locate`, `weather-clear`, `weather-management`, `weather-error`) and the helper exports stay. Decimal-only validation (`DECIMAL`, `weatherFormProblem`, hint text) is untouched and must keep its tests (`0x10`, `1e3` still flagged and Save blocked).
- D4 The timezone Select trigger drops `w-72` for full width of the column.
- D5 Day periods: **one Save per card** (decision: keeps the existing PATCH-per-period semantics and the server's per-period ordering validation; a single row Save would need ordered multi-PATCH and partial-failure handling, because shifting two periods can be valid only as a pair). Each card always shows: heading + optional "Active now" badge, the stored range line, a labelled time input, and a Save button (disabled unless that card's draft differs from its stored start, empty, or saving). No Edit/Cancel. Typing the stored value back is the revert.
- D6 No layout shift: cards have the same structure at all times (range line always rendered, header `min-h`), the grid is `grid gap-3 grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-4` (>= 896px of content shows 4), the post-save refresh is silent (the "Loading..." line shows only on the first load, `loading && periods.length === 0`), and the error notice sits above the grid as today.
- D7 Day periods get a Retry button on a failed load (round-1 rule 5; it had none). New key only for this.
- D8 State: `drafts: Partial<Record<PeriodId, string>>`; input value is `drafts[id] ?? period.start`; dirty is `drafts[id] !== undefined && drafts[id] !== period.start`. Save validates with `validateStartOrdering` over stored starts plus that one draft (as today), PATCHes, then refreshes and drops that draft. A save error keeps the draft.
- D9 Shared components: the language and week-start rows already use the shared `ChoicePills` after the pills wave; do not touch that. No new shared component.
- D10 i18n: one `// admin-settings-polish` block per locale, at the end of the existing admin keys in `src/client/i18n/messages.ts`. Remove `dayPeriods.action.edit` and `dayPeriods.action.cancel` from both locales only if grep shows no remaining use. New keys: `dayPeriods.management.retry` and nothing else is required (button label reuses `dayPeriods.action.save`).

## Assumptions

- A1 Playwright's default 1280x720 viewport gives ~990px of content (sidebar 240px + padding), so e2e sees 2 settings columns and 4 day-period columns.
- A2 jsdom has no layout; column and alignment behaviour is pinned by e2e bounding boxes, unit tests pin structure (testids, ids, disabled states).
- A3 Kiosk density: Input and Button already carry density tokens; controls count in the day-periods density tests changes (see plan).

## Acceptance

Settings and Weather share a row at >= 672px content width and stack below; the three weather inputs have equal `x` and `width`; Save disabled on load, enabled after any locale or weather edit, disabled again after reverting; four day-period cards in one row at 1280px, editing a time never moves any card; per-card Save persists, ordering errors still show `day-periods-error`; `docs/ui/household-contract.md` item 13 updated; gates green.
