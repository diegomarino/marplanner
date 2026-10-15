# Routines assignment dialog polish: implementation plan

> For the executor. Spec: `docs/superpowers/specs/2026-10-15-admin-routines-polish-design.md`. Small task (3 source files, 3 test files). Decisions are made; do not reopen them. If a shared component API (`WeekdayPicker`, `MemberPills`, `ChoicePills`) differs from the shared-pills plan when you start, adapt to the real one. Do not duplicate shared components.

**Branch/setup:** work in your own worktree branched from `main` after the shared-pills wave merged. Copy the spec and this plan into your branch first:

```bash
cp /Users/diego/Dev/marplanner-project/docs/superpowers/specs/2026-10-15-admin-routines-polish-design.md docs/superpowers/specs/
cp /Users/diego/Dev/marplanner-project/docs/superpowers/plans/2026-10-15-admin-routines-polish.md docs/superpowers/plans/
```

Ports for every Playwright run: `PORT=43226 MP_E2E_WEATHER_FIXTURE_PORT=44426 MP_E2E_QUOTE_FIXTURE_PORT=44436`.

## Task 0: Confirm the baseline

- [ ] Read `src/client/routines/admin/AssignmentDialog.tsx`, `src/client/components/WeekdayPicker.tsx` and `tests/e2e/admin-routines.spec.ts`. Confirm the wave merged: `WeekdayPicker` renders `PillToggle`s, exports `weekdayDisplayOrder`, and the e2e spec has the one-line `boundingBox().y` assertion. If something is missing, stop and report; do not re-implement the wave.
- [ ] `grep -n "routines.assignments" src/client/i18n/messages.ts` and find the `// admin-routines` block at the end of the existing admin keys (en about line 282, es about line 1758).

## Task 1: Dialog, header and i18n

**Files:** `src/client/routines/admin/AssignmentDialog.tsx`, `src/client/i18n/messages.ts`.

- [ ] In `AssignmentDialog`, change the `DialogContent` class from `sm:max-w-xl` to `sm:max-w-2xl` (keep `max-h-[calc(100vh-2rem)] overflow-y-auto`).
- [ ] In `AssignmentRow`, change the container to `p-4` and replace the lone `MemberChip` with:

```tsx
<div className="flex flex-wrap items-center justify-between gap-2">
  <MemberChip member={child} className="self-start text-base" />
  {assignment !== undefined && !assignment.active && (
    <span className="text-muted-foreground text-sm" data-testid={`routine-assignment-${child.id}-inactive`}>
      {t("routines.assignments.statusInactive")}
    </span>
  )}
</div>
```

- [ ] Add to the `// admin-routines` block of each locale (append after the last key of that block, same ordering rule as the file; keep other workers' blocks untouched):
  - en: `"routines.assignments.statusInactive": "Deactivated",`
  - es: `"routines.assignments.statusInactive": "Desactivada",`
- [ ] Run `npx prettier --write src/client/routines/admin/AssignmentDialog.tsx src/client/i18n/messages.ts` then `npm run typecheck`.

## Task 2: Unit tests

**Files:** `tests/client/routines.test.tsx`, new `tests/client/assignment-dialog.test.tsx`.

- [ ] In `routines.test.tsx`, "a deactivated assignment starts empty and re-saving it asks for confirmation": add `expect(within(row).getByTestId("routine-assignment-m1-inactive")).toHaveTextContent("Deactivated")`. In "changing an existing assignment asks for the streak confirmation" (active) add `expect(within(row).queryByTestId("routine-assignment-m1-inactive")).not.toBeInTheDocument()`.
- [ ] Create `tests/client/assignment-dialog.test.tsx`. Model the household-settings mock on `tests/client/weekday-picker.test.tsx` (hoisted `vi.mock("@/lib/householdSettings")` returning a mutable `weekStartDay`) and the provider wrapping on `tests/client/routines.test.tsx` (`LanguageProvider`, helpers `injectDensityStyles`/`assertKioskDensityCompliant` only if the sibling file needs them). Render `AssignmentDialog` with one child member (`colorKey` any valid key), `assignments=[]`, `busy=false`, `error=null`, spies for `onSave`/`onDeactivate`/`onClose`. Cases:
  1. Monday-first (`weekStartDay: 1`): the checkboxes inside `routine-assignment-<id>` are named Mon..Sun in that order.
  2. Sunday-first (`weekStartDay: 0`): named Sun, Mon..Sat; clicking Wed then Mon and Save calls `onSave(id, ["mon","wed"])` (canonical order, new assignment so no confirmation).
  3. `screen.getByTestId("assignment-dialog")` has class `sm:max-w-2xl` and not `sm:max-w-xl`.
  4. Inactive marker: with `assignments=[{ id, memberId, weekdays: ["mon"], active: false }]` the marker shows; with an active one it does not.
  Use the `Assignment`/`Member` types from `src/shared` to build fixtures (check the required fields by reading `src/shared`; copy the shapes the existing `routines.test.tsx` `CHILD` constant uses).
- [ ] `npx prettier --write` both files, then `npx vitest run tests/client/routines.test.tsx tests/client/assignment-dialog.test.tsx tests/client/weekday-picker.test.tsx`. Expected: all pass.

## Task 3: e2e

**File:** `tests/e2e/admin-routines.spec.ts` (existing test; keep its title so the Playwright inventory is unchanged).

- [ ] Next to the shared-pills one-line assertion (after `const row = assign.getByTestId(...)`), add a width check: take the `boundingBox()` of the dialog and of the `sun` and `mon` weekday inputs (whichever is last depends on the week start; take all seven via the `routines-weekday-${memberId}-*` testids) and assert each pill's `x + width` is at most the dialog box's `x + width - 16`. Keep the existing `y` equality assertion.
- [ ] Run `PORT=43226 MP_E2E_WEATHER_FIXTURE_PORT=44426 MP_E2E_QUOTE_FIXTURE_PORT=44436 npx playwright test tests/e2e/admin-routines.spec.ts --workers=3`. Expected: PASS.
- [ ] Visual check (optional, using your own browser tab and the exact seeding commands in `marplanner-dev-servers-and-seeding`): open the dialog at the default and kiosk density in English and Spanish, confirm one line and the header marker.

## Task 4: Docs

- [ ] `docs/ui/household-contract.md` (the Routines paragraph, about line 62): add one sentence after "Routines, chores and assignments are edited in dialogs.": "The assignment dialog lists each child with their colour chip and a one-line weekday pill row in the household week-start order; an assignment that was deactivated is marked as such." Do not touch `docs/features/routines-chores.md` (no behaviour or contract change).
- [ ] `npx prettier --write docs/ui/household-contract.md`.

## Task 5: Inventory resync (`tests/fixtures/assembly-cohort.json`)

- [ ] Run the full vitest cohort to get the list and coverage: `npm run test:cohorts:vitest:list && npm run test:cohorts:vitest` (needs `MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)` exported and `npm run test:cohorts:stamp` first, as in `check:standard`).
- [ ] In `testCohorts.runners.vitest.files` add the new file `tests/client/assignment-dialog.test.tsx` with its full case names (exactly as `.quality/vitest-list.json` prints them, `describe — it` joined as in the neighbouring entries). `tests/client/routines.test.tsx` keeps the same case titles (no rename), so its entry is unchanged.
- [ ] In `coveragePolicy.files`: `src/client/routines/admin/AssignmentDialog.tsx` already has an entry (around line 6846). Compare its `minimumTotals`/`minimumRates` to the measured totals in `coverage/coverage-final.json`; the totals (lines/statements/functions/branches) go up by the new marker branch, so raise the minimums to the new measured totals and keep the rates at or above their current values (never lower a rate). No new source file, so no new coverage entry.
- [ ] Playwright files: unchanged (no new spec, no renamed test). `npm run check:aggregate-only` below verifies this.
- [ ] `npx prettier --write tests/fixtures/assembly-cohort.json`; review `git diff --stat` shows only the entries above.

## Task 6: Gate, commit, report

- [ ] Commit all work so the tree is clean (`git status --porcelain` empty; the gate rejects untracked files). Conventional commits, for example `feat(admin): widen the routine assignment dialog and mark deactivated assignments`, then `test: resync the reviewed inventory for the assignment dialog`.
- [ ] `export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)` then `npm run check:standard`. Expected exit 0. If `check:coverage` or `check:test-cohorts:standard` fails, fix the fixture (Task 5), commit, and rerun on the new HEAD. If `check:preflight` complains about the checkout, use a detached clean worktree as the shared-pills plan Task 8 describes.
- [ ] `PORT=43226 MP_E2E_WEATHER_FIXTURE_PORT=44426 MP_E2E_QUOTE_FIXTURE_PORT=44436 npm run check:aggregate-only` (it also verifies the Playwright inventory). Expected exit 0.
- [ ] Write `REPORT-routines-polish.md` in the worktree root (branch name, worktree path, `git log --oneline main..HEAD`, last lines of both gates, e2e result, any deviation from the spec and why), `git add REPORT-routines-polish.md && git commit -m "docs: report the routines assignment dialog polish"`. Do not merge or push. Reply exactly `DONE` followed by the branch name.
