# Routines: assignment dialog polish

Date: 2026-10-15. Status: approved by delegation (owner waived review). Slug: `routines-polish`.

## Owner feedback

Routines (`/admin/routines`), assignment dialog: widen the dialog so the 7 weekdays fit on one line, and use the shared weekday pills instead of checkboxes.

## What the shared-pills wave already delivers (do not redo)

Verified in the shared-pills spec/plan (`2026-10-15-admin-shared-pills-*`). Once it has merged:

- `WeekdayPicker` (multi) renders `PillToggle` pills (`px-3`, `flex flex-wrap gap-1.5`), in the household week-start order, and still emits `CANONICAL_WEEKDAY_ORDER`. `AssignmentDialog` already calls `<WeekdayPicker mode="multi" ...>`, so the checkbox UI is already gone from this dialog with no call-site edit.
- `RoutineWeekGrid` follows `weekdayDisplayOrder(...)` (orchestrator addendum).
- `tests/e2e/admin-routines.spec.ts` asserts the seven weekday inputs of one assignment row share a `boundingBox().y`.

## Current state (read at `feat/admin-parity`)

`src/client/routines/admin/AssignmentDialog.tsx`:

- `DialogContent` has `sm:max-w-xl` (576px, about 500px of content after `p-6`). The shared-pills estimate for seven pills is about 470px, so the row fits with a margin of only about 30px: the larger kiosk density or a longer localized label (Spanish "Mié", "Sáb") can wrap it.
- Each child row is a bordered box with a `MemberChip` (filled member-colour chip, the same one used by `RoutineWeekGrid` and the Members page), the weekday picker, then Save (+ Deactivate when the assignment is active) buttons.
- A deactivated assignment (an existing row with `active: false`) renders exactly like a never-assigned child (empty weekdays, no Deactivate button), yet Save asks for the streak confirmation for it and not for the never-assigned child. Nothing tells the admin why.

## Decisions

**D1 - Widen the dialog to `sm:max-w-2xl`** (672px, about 620px of content). Seven pills (about 470px) then leave roughly 150px of slack. The dialog keeps `max-w-[calc(100%-2rem)]` below `sm`, where the pills wrap, which is the intended phone behaviour (the owner's request is about the admin desktop/tablet layout). `max-h-[calc(100vh-2rem)] overflow-y-auto` stays.

**D2 - Keep `MemberChip` as the row header; do not switch to `MemberPills`.** `MemberPills` is a selector (radio/checkbox pills with a dot and a selected tint). The dialog already lists every child, so there is nothing to select. The header must read like the other Routines surfaces (week grid, detail), which all use `MemberChip`, so `MemberChip` stays. This keeps "member colour header consistency" within the page, and the shared pills are used where a choice exists (weekdays).

**D3 - Show a muted "Deactivated" marker** on the header line of a row whose assignment exists but is inactive, new key `routines.assignments.statusInactive` (en "Deactivated", es "Desactivada"). The header becomes `flex flex-wrap items-center justify-between gap-2`: chip left, marker right. This explains the streak confirmation on re-saving. No marker for never-assigned children.

**D4 - Slightly roomier rows:** the row box goes from `p-3` to `p-4`. The Save and Deactivate buttons stay below the pills; nothing else about the actions, the confirm dialogs or the streak warnings changes.

**D5 - Nothing else.** No new component, no behaviour, API, schema or server change. The weekday/test ids (`routines-weekday-<id>-<day>`, `routine-assignment-<id>`, `routines-assignment-<id>-save|deactivate`) are unchanged.

## Tests

- Vitest `tests/client/routines.test.tsx`: the deactivated-assignment case asserts the "Deactivated" text; an active and a never-assigned child assert its absence. Existing role assertions (`checkbox` named "Tue") still hold because pills are native checkboxes.
- Vitest new `tests/client/assignment-dialog.test.tsx`: renders `AssignmentDialog` directly with a mocked household week start; Sunday-first puts `Sun` first in the row and the saved weekdays are still emitted in canonical order; the content carries `sm:max-w-2xl`.
- Playwright `tests/e2e/admin-routines.spec.ts` (existing test, same title): extend the shared-pills one-line check with a width check, that the dialog's right edge is beyond the seventh pill's right edge by at least 16px (all seven pills inside the dialog box with room). No new spec.

## Assumptions

- A1: The shared-pills wave has merged before execution, so `WeekdayPicker` is the pill row and the one-line e2e assertion exists. If a shared component API differs from the plan, adapt to the real one.
- A2: Phone width is not a requirement for "one line"; wrapping is acceptable below `sm`.
- A3: No i18n key exists for the inactive state; add one (verified `messages.ts` lines 694-723, `routines.assignments.*`).
