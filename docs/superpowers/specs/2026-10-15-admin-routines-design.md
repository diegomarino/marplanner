# Admin parity: Routines & Chores — design

Date: 2026-10-15. Status: approved by owner waiver (design review waived; decisions below were made
autonomously from the shared admin-parity brief, the reference app and our code).

## Goal

Bring `/admin/routines` to the reference app's layout and interaction model (master/detail list,
week grid, dialogs, drag-to-reorder) while keeping our safety extras (streak-warning
confirmations, ConfirmDialog deletes, i18n, ErrorNotice live regions). Close two backend gaps:
a routine may move to another day period, and routines are listed by day-period start time, then
name.

Reference (read-only): `/Users/diego/Dev/marplanner/apps/web/src/features/routines/`
(`RoutineAdmin.tsx`, `RoutineList.tsx`, `RoutineDetail.tsx`, `RoutineWeekGrid.tsx`,
`AssignmentManager.tsx`, `RoutineForm.tsx`, `ChoreForm.tsx`, `SortableChoreItem.tsx`) and
`apps/api/src/routes/routines.ts` (list `orderBy(dayPeriods.startTime, routines.name)`, PATCH
accepts `dayPeriodId`).

Ours today: `src/client/admin/RoutinesManagement.tsx` (stacked cards, inline forms, expand
toggles) and `src/client/admin/ChoreOrderControls.tsx` (up/down reorder mode).

## Scope

In:

1. Page layout: master/detail inside the existing `AdminPanel`.
   - Heading equals the sidebar label: "Routines & Chores" / "Rutinas y tareas".
   - Left: routine list grouped by day period (periods in start-time order, only periods that have
     routines), routines in server order (start time, then name). A "New routine" button heads
     the list. Empty list: "No routines found.". The selected routine is highlighted
     (`aria-current="true"`, primary button style).
   - Right: detail of the selected routine, or the prompt "Select a routine to manage its chores"
     when none is selected. Nothing is selected on first load (reference parity).
   - Below `lg` the two panes stack (list first).
2. Detail header: routine name, day-period label, and actions Edit routine, Assign, Add chore,
   Delete routine.
3. Week grid: 7 columns (Mon..Sun, canonical order, localized short labels). Each column lists the
   children with an ACTIVE assignment covering that weekday, as colour chips using the member
   colour token. The whole grid is a button ("Manage assignments") that opens the assignment
   dialog.
4. Assignment dialog (our `Dialog`, not a Sheet): one row per active child: colour chip, the
   shared `WeekdayPicker` (multi), Save, and Deactivate when the assignment is active. Behaviour
   kept from ours: a brand-new assignment saves immediately; changing an existing row (active or
   inactive) asks for confirmation with the streak warning; Deactivate asks for confirmation. Save
   is disabled with no weekdays selected or when the draft equals the saved active weekdays. A
   deactivated assignment starts with an empty draft. No children: a hint to add one in Members.
5. Chore list: rows with drag handle, Noto emoji (fallback 📋), name, Edit and Delete icon buttons
   (accessible names include the chore name). Empty: "No chores yet. Add one above.". Reorder by
   drag with pointer, touch and keyboard (`@dnd-kit`, same sensors and announcement pattern as
   `CalendarManagement.tsx`). A drop persists immediately via `PUT /api/routines/:id/chores/order`;
   on failure the previous order is restored, chores are reloaded and an error is announced.
   Chore delete keeps the ConfirmDialog with the streak warning.
6. Routine dialog (create and edit): name + day-period select. Create defaults the period to the
   first period (start-time order). Submit disabled until the name is non-blank and a period is
   chosen. Edit may change the period; when it does, a ConfirmDialog with the streak warning must
   be confirmed before the PATCH (FR-009). A name-only edit saves directly. After create, the new
   routine is selected.
7. Chore dialog (create and edit): `EmojiPicker` + name; Enter submits (it is a form); submit
   disabled while the name is blank.
8. Routine delete: ConfirmDialog with the streak warning (kept); after delete the selection clears.
9. Errors: base load failure shows ErrorNotice + Retry; detail (chores/assignments) load failure
   shows ErrorNotice + Retry inside the detail pane; dialog save failures show an ErrorNotice in the
   dialog and keep it open; reorder/delete/assignment failures show a page-level ErrorNotice.
10. Backend:
    - `PATCH /api/routines/:id` accepts `dayPeriodId`: must be a non-blank string naming an
      existing day period, else 400 `validation_error` and nothing changes. On success the routine
      moves (the board follows immediately because it joins on the routine's period).
    - `GET /api/routines` orders active routines by day-period `start_minutes` ASC, then name
      (case-insensitive) ASC, then `created_at` ASC as a stable tiebreak.
    - `GET /api/routines/:id/assignments` is unchanged (still returns inactive rows for admin
      history); the client filters `active` where it shows current assignments.
11. Seed: add an afternoon routine and more chores so period grouping and the week grid show real
    variety; per-assignment weekdays.
12. Docs: feature spec FRs, OpenAPI, API contract audit note, household UI contract, shared type.

Out (explicit):

- Reference `/admin/chores` board route (the kiosk already has the board).
- Optimistic per-click assignment saves (see Decisions).
- A delete icon on list rows (delete lives in the detail header only).
- Removing now-unused `routines.*` message keys (left in place; see Decisions).
- Any new shared primitive (no Sheet, no shared MemberBadge).

## Architecture

Client, new directory `src/client/routines/admin/` (mirrors `src/client/calendar/admin/`):

| File                    | Responsibility                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `routineOrder.ts`       | Pure helpers: `groupRoutinesByPeriod(routines, dayPeriods)`, `moveChore(chores, activeId, overId)` |
| `MemberChip.tsx`        | Coloured name chip from a member's `colorKey` (token forwarding like `MembersManagement.tsx`)      |
| `RoutineList.tsx`       | Grouped master list, New button, selection                                                         |
| `RoutineWeekGrid.tsx`   | 7-column grid of active assignments; whole grid opens the assignment dialog                        |
| `SortableChoreRow.tsx`  | One sortable chore row (handle, icon, name, edit/delete)                                           |
| `RoutineDetail.tsx`     | Header actions, week grid, chore list with DnD context, chore-delete confirm                       |
| `RoutineFormDialog.tsx` | Create/edit routine; period-move confirm                                                           |
| `ChoreFormDialog.tsx`   | Create/edit chore                                                                                  |
| `AssignmentDialog.tsx`  | Per-child weekday rows with save/deactivate confirms                                               |

`src/client/admin/RoutinesManagement.tsx` becomes the orchestrator: loads day periods, routines and
members; owns selection; loads chores + assignments for the selected routine; performs every
mutation through `authFetch`; renders the panes and dialogs. `ChoreOrderControls.tsx` and its test
are deleted.

Data flow: base load (`/api/day-periods`, `/api/routines`, `/api/members`) on mount and on Retry.
Selecting a routine loads `/api/routines/:id/chores` and `/api/routines/:id/assignments`. Every
mutation reloads only what it changed (routines list for routine create/edit/delete; detail for
chore and assignment changes). Reorder is optimistic.

Server: `src/server/modules/routines/index.ts` (`editRoutine`, `listRoutines`). No migration: the
`routines.day_period_id` column already exists with an FK to `day_periods`.

## Decisions / Assumptions

1. Assignments keep our explicit per-child Save with streak-warning confirmations (brief: keep
   these confirms) instead of the reference's optimistic save on every day click. Rationale: every
   change to an existing assignment changes the live streak (FR-009); a confirm on every click
   would be worse than one Save.
2. Day selection uses the shared `WeekdayPicker` (checkbox mode) instead of the reference's round
   day buttons: it is the canonical weekday control (SC-009) and needs no new primitive.
3. The week grid is one `Button` (`variant="ghost"`, `wrap`) whose accessible name is "Manage
   assignments"; the same assignments are fully readable in the dialog.
4. Moving a routine to another period always asks for confirmation (streak warning), mirroring
   FR-009's "reorganizing" rule; renaming alone does not.
5. Nothing is selected on first load (reference parity). After create, the new routine is selected;
   after delete, the selection clears.
6. Heading text: change the values of the existing key `routines.management.title` to
   "Routines & Chores" / "Rutinas y tareas" (same as `admin.sidebar.routines`). The legacy
   `admin.nav.routinesManagement` overview label is not changed.
7. New strings live in one contiguous `// admin-routines` block per locale placed right after
   `admin.notFound.description`. Existing `routines.*` keys made unused by the rework stay (a
   deletion would collide with parallel workers and with `routines-i18n-parity.test.ts`).
8. Server ordering uses `start_minutes`, then `name COLLATE NOCASE`, then `created_at`; it uses a
   `LEFT JOIN` so a routine is never dropped from the list by the ordering join.
9. Blank or non-string `dayPeriodId` in a PATCH is a 400 (`RoutineValidationError`); an unknown id
   is a 400 (`DayPeriodNotFoundError`, already mapped to 400). Omitted means unchanged.
10. FR numbering: the old "FR-017" references in OpenAPI and code comments point at a superseded
    numbering; the new rule is FR-015 in `docs/features/routines-chores.md`, the list order is
    FR-016.
11. Seed changes: new routine `demo:routine:after-school` ("After school", afternoon) with three
    chores (🍎 Have a snack, 📚 Homework, 🪴 Water the plants); a third evening chore (🚿 Take a
    shower); assignments get per-row weekdays (morning/evening stay Mon-Fri for Bart and Lisa;
    after-school: Lisa Mon-Thu, Bart Mon/Wed/Fri). No new completions. All emojis are in
    `src/client/chores/emoji-catalog.ts`, so the vendored Noto set needs no regeneration.
12. Coverage policy: new files get entries at their measured values; files that shrink get their
    minimum totals lowered only where measured below (precedent: commit 844eed79).
13. A new e2e spec `tests/e2e/admin-routines.spec.ts` covers create → chore → assign → move period;
    `admin-unlock-resilience.spec.ts` switches its routines primary action to the `routines-new`
    test id.

## Error handling

- All fetches go through `authFetch` with `credentials: "include"`; any non-OK response is an
  error.
- Base load error: `routines.management.error` + Retry (`routines-retry`).
- Detail load error: `routines.admin.detailError` + Retry (`routine-detail-retry`).
- Routine dialog save error: `routines.admin.saveError`; chore dialog: `routines.admin.choreSaveError`.
- Delete routine/chore failures: `routines.management.error` / `routines.chores.error` at page
  level. Assignment save/deactivate failure: `routines.assignments.error`. Reorder failure:
  `routines.chores.reorderError` (existing keys, existing tests' wording).

## Testing

- Server boundary (`tests/boundary/routines-crud.test.ts`): PATCH moves the period; PATCH with
  unknown/blank/non-string period is 400 with no change; GET lists by start time then name.
- Seed boundary + integration tests updated to the new list and order.
- Client unit: `routineOrder.ts` helpers; `RoutinesManagement` page (grouping, selection prompt,
  Retry, dialogs, period-move confirm, chore dialog Enter/disabled, delete confirms, assignment
  confirms, keyboard drag reorder success and failure, week grid active-only, Spanish labels,
  AdminPanel region name, kiosk density incl. a deliberate negative).
- `tests/client/admin-gate-panel-reset.test.tsx` finds the page by `routines-management`.
- e2e: new `admin-routines.spec.ts`; `admin-unlock-resilience.spec.ts` updated.
- Gate: `npm run check:standard` from a clean committed tree, and the affected e2e specs with
  `PORT=43201 npx playwright test <spec> --workers=3`.
