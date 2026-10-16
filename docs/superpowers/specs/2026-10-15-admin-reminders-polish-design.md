# Admin Reminders polish: pills instead of radios and checkboxes

Date: 2026-10-15. Status: approved by delegation (the owner waived review). Decisions below bind the executor.

## Intent

Owner feedback on `/admin/reminders` (the add/edit rule dialog):

1. The kind control (scheduled | calendar-gated) uses the shared segmented choice.
2. "All members" days use the shared weekday pills.
3. "Specific members": each member appears as a pill in their own colour, and the per-member day selection is a compact weekday-pill row, not a table of raw checkboxes.
4. The calendar-gated form gets the same treatment.

Success: no raw `RadioField`/`CheckboxField`/bare checkbox table remains in the dialog; every selection is a shared pill; behaviour, request payloads and all testids that are not about the old matrix are unchanged.

## Current state (verified at `feat/admin-parity`)

`src/client/admin/RemindersManagement.tsx` (958 lines) holds the page, `ReminderRow`, `DryRunPanel`, and `ReminderFormDialog`. The dialog (`sm:max-w-xl`) renders:

- kind: two `RadioField`s (`name="reminder-kind"`), or plain text when editing (kind is fixed on edit);
- text `Input`;
- targeting: two `RadioField`s (`name="reminder-targeting-mode"`);
- scheduled + all members: `WeekdayPicker mode="multi"` (`testIdPrefix="reminders-weekday-form"`);
- scheduled + specific: `AssignmentMatrixGrid`, a `<table>` of member rows by weekday columns with bare checkboxes labelled `"<name> — <day>"`, state `assignmentDraft: Record<memberId, Weekday[]>`;
- calendar-gated: match-text `Input` (`w-auto`), `QueryFieldsPicker` (`CheckboxField`s), and for specific targeting `MembershipChecklist` (`CheckboxField`s), state `cgMemberIds`.

After the shared-pills wave, `WeekdayPicker` already renders pills in week-start order, and `ChoicePills`/`MemberPills`/`PillToggle` exist in `@/ui`.

## Decisions

**D1. Kind and targeting are `ChoicePills`.** Create mode: `ChoicePills<ReminderKind>` with options scheduled and calendar_gated, `groupLabel` and visible caption `reminders.management.kindLabel`. Edit mode keeps today's read-only text (kind cannot change). The targeting control, which the owner did not name, becomes `ChoicePills<TargetingMode>` too (caption `reminders.management.targetingLabel`), so the dialog reads as one visual language; the owner's intent is clearly consistency. Option testids: `reminder-kind-scheduled`, `reminder-kind-calendar_gated`, `reminder-targeting-apply_to_all`, `reminder-targeting-specific` (on the native radio inputs).

**D2. All members days** stay `WeekdayPicker mode="multi"` with the same `testIdPrefix`; nothing to change except that its surroundings are now pills.

**D3. Specific members (scheduled) is a new component `ReminderMemberDays`** in `src/client/admin/ReminderMemberDays.tsx`. For every active member it renders a block: a one-member `MemberPills` (multi, single entry; the member's colour, selected means "this member takes part") and, only while selected, a `WeekdayPicker mode="multi"` row below it. Why one `MemberPills` per member rather than one group: the day row must sit under its own member, and a 500px dialog cannot hold the member pill plus seven day pills on one line (about 470px for the days alone). Draft model is unchanged in shape: `Record<memberId, Weekday[]>`, where the key's presence means the member takes part. Selecting a member adds `[]`; deselecting removes the key (their days are dropped, which matches the full-set replace on the server). Submit still goes through `draftToAssignments`, which omits members with no days; `canSubmit` still requires at least one member with at least one day. A selected member with no days shows a muted one-line hint (new key) so the disabled Save button is explained.

Testids: member pill input `reminders-member-<memberId>`; weekday input `reminders-weekday-<memberId>-<day>`. `groupLabel` of a member's day row is `"<name> — <weekdays label>"`; the member pill group is named by the member's display name.

**D4. Calendar-gated** keeps its fields but changes controls: match fields become `PillToggle`s (`reminders-query-field-<field>`), assigned members (specific only) become one `MemberPills` multi group (`groupLabel` = `reminders.calendarGated.membershipTitle`, `testIdPrefix="reminders-cg-member"`), and the match-text input becomes a full-width labelled column. `MembershipChecklist`, `QueryFieldsPicker` and `AssignmentMatrixGrid` are deleted; `CheckboxField`, `RadioField`, `BARE_CHECKBOX_INPUT_CLASSES` imports go with them.

**D5. Week start.** `AssignmentMatrixGrid` was the last display-only weekday loop in this file; it disappears, so there is no `CANONICAL_WEEKDAY_ORDER` import left. Day pills follow the household week start through `WeekdayPicker`. The row summary text (`weekdayList`, "Mon, Wed") keeps data order; it is text, not a control.

**D6. No behaviour or API change.** Request bodies, `buildBody`, dry-run, toggle, delete, Retry, silent refresh: untouched. No server, OpenAPI or shared-type changes.

**D7. i18n.** One block `// admin-reminders-polish` at the end of each locale's admin keys in `src/client/i18n/messages.ts`: `reminders.specific.membersHint` ("Pick at least one weekday.", no interpolation) and `reminders.specific.membersLabel` ("Members and weekdays"). Spanish equivalents. `reminders.matrix.member` becomes unused and is left in place (catalogue parity tests only compare locales).

**D8. Docs.** `docs/ui/household-contract.md` reminders paragraph: add that the dialog uses pills (kind and targeting choices, weekday pills in week-start order, member pills in member colours, a day row per selected member).

## Assumptions

- A1: Targeting radios becoming pills is within the owner's intent (decided above).
- A2: Row list/summary (outside the dialog) is not restyled.
- A3: `Member` (from `src/shared`) satisfies `MemberPillsMember` structurally (`id`, `displayName`, `colorKey`). Test fixtures in `tests/client/reminders.test.tsx` lack `colorKey` and must gain it.
- A4: Playwright `.check()` works on the stretched opacity-0 inputs (the shared-pills spec A3). Playwright test titles and ids do not change, so the playwright inventory in the cohort fixture needs no new ids.
- A5: If a shared component API differs from the shared-pills plan when execution starts, adapt to the real one (read `src/client/components/{ChoicePills,MemberPills,WeekdayPicker}.tsx` first).

## Testing

- New `tests/client/reminder-member-days.test.tsx` for `ReminderMemberDays`.
- `tests/client/reminders.test.tsx`: fixtures get `colorKey`; matrix interactions move to the new testids; add tests for kind pills, targeting pills, member prefill on edit, deselect drops days, calendar-gated member pills, hint; density counts recomputed.
- e2e `reminders.spec.ts` and `reminders-calendar-gated.spec.ts` move off the table locators; the former also asserts one member's seven day inputs sit on one line.
- Cohort fixture resync and both gates (see plan).
