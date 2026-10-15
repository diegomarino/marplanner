# Admin parity: Reminders and Messages pages (design)

Date: 2026-10-15. Scope: port the reference app's reminder-rules admin layout and interactions
(`<marplanner-v1>/apps/web/src/features/reminders/ReminderRulesList.tsx` and
`ReminderRuleForm.tsx`) into `src/client/admin/RemindersManagement.tsx`, add a Retry button to
`src/client/admin/DailyMessagesManagement.tsx`, and make a reminder's `targetingMode` editable in
the API (`PATCH /api/reminders/:id`). Owner waived design review; every question below was answered
from the brief and the code and is recorded under Decisions.

## Intent

A parent managing reminders should see one compact list of rules (text, who it applies to, which
days, Active/Off) and add or edit a rule in a single dialog, the way the reference does. Switching a
rule between "All members" and "Specific members" must be possible without deleting and recreating
it. The Messages page keeps its 14-day editor but a failed load can be retried.

Success: the Reminders page uses an "Add rule" dialog, rows name their members and days, edit
changes targeting and members, `window.confirm` stays gone (it already is), load failures on both
pages can be retried, and everything listed under "Kept" still works.

## Current state (verified by reading the code)

- `src/client/admin/RemindersManagement.tsx` (1027 lines): an always-visible create form
  (`ReminderCreateForm`, testid `reminder-create-form`), one `ReminderCard` per rule
  (`data-testid="reminder-<id>"`) with inline edit (text, plus weekdays for apply_to_all, or query
  and query fields for calendar_gated; never targeting), an "Assignments" toggle opening a matrix
  (scheduled/specific), a membership checklist (calendar_gated/specific) or a shared weekday matrix
  (scheduled/apply_to_all), a Dry-run toggle (calendar_gated only) and a `ConfirmDialog` delete.
  The row shows kind, weekdays or the literal "Specific members", and Active/Inactive text.
  `loadData()` sets `loading=true`, which swaps the whole page for a "Loading…" panel every time a
  mutation refreshes the list. A load failure shows `ErrorNotice` only, no retry.
- Server `src/server/modules/reminders/index.ts`: `editReminder` (line 567) rejects `kind` and
  `targetingMode` in the body (lines 572-576, FR-013), allows `text`, `weekdays` (only scheduled
  apply_to_all rows), `active`, `query`, `queryFields`. `replaceAssignments` (line 715) is the only
  assignment writer; it validates kind-aware (scheduled needs weekdays, calendar_gated is
  membership-only), upserts present members and deactivates (`active=0`) the omitted ones, in one
  transaction. The DB discriminant CHECK (`src/server/db/schema.ts` lines 504-507) requires
  `weekdays IS NOT NULL` for scheduled apply_to_all, `weekdays IS NULL` for scheduled specific and
  for every calendar_gated row. `GET` embeds only `active = 1` assignments.
- Route `src/server/routes/reminders.ts` already passes the PATCH body straight to `editReminder`
  and maps `ReminderValidationError` to 400 and `ReminderNotFoundError` to 404. No route change.
- Shared type `ReminderEditInput` is in `src/shared/index.ts` (line 440).
- Contract docs: `docs/api/reminders/openapi.yaml` (`ReminderEditInput` line 370, PATCH line 505),
  `docs/api/calendar-reminders/openapi.yaml` (`ReminderEditInput` line 187, PATCH line 297),
  `docs/features/reminders.md`, and `docs/architecture/contracts/reminders.md` line 76-79, which
  already lists `targeting_mode` as an editable field per kind, so the contract was ahead of the code.
- `DailyMessagesManagement.tsx` (366 lines): member select, 14-day window, per-day textarea saved on
  blur, delete via `ConfirmDialog`. Load errors (members or messages) show `ErrorNotice` with no
  retry; a delete failure reuses the load-error text.
- Tests that pin the current UI or contract (all must be updated, see the plan):
  `tests/client/reminders.test.tsx` (density census 22/30/35/41, "Assignments" buttons, create form
  placeholder, `Create Reminder`), `tests/client/reminders-i18n-parity.test.ts` and
  `tests/client/daily-messages-i18n-parity.test.ts` (title strings),
  `tests/client/day-periods-messages-admin.test.tsx` (lines 249-251, region/heading
  "Daily Messages Management"), `tests/client/daily-messages-management.test.tsx`,
  `tests/boundary/reminders-crud.test.ts` (lines 219 and 275),
  `tests/e2e/reminders.spec.ts`, `tests/e2e/reminders-calendar-gated.spec.ts` (card located by the
  class string `.border.rounded-lg.p-4.mb-4`), `tests/e2e/admin-household-timezone-defaults.spec.ts`
  (same class locator), `tests/e2e/admin-unlock-resilience.spec.ts` (line 104-107: the reminders
  page's primary action is the button named "Create Reminder"),
  `tests/e2e/daily-messages.spec.ts` (heading by title key), and
  `tests/fixtures/assembly-cohort.json` (vitest case names and per-file coverage floors).
- `seeds/seed-050-reminders.ts` already seeds one scheduled/specific and one
  calendar_gated/specific rule. No seed change.

## Target behaviour

### Reminders page

Header: `AdminPanel` title equals the sidebar label, "Reminders" / "Recordatorios" (the
`reminders.management.title` value changes; the description line stays). `actions` slot: an
"Add rule" button (`Plus` icon, testid `reminders-add-rule`) shown once the list has loaded.

States: first load = the existing "Loading…" paragraph (e2e specs wait for it to disappear); load
failure = `ErrorNotice` plus a "Retry" button (testid `reminders-retry`) that reloads rules and
members; empty = existing "No reminders found." text. Only the first load and an explicit Retry show
the loading state: refreshes after create, edit, toggle or delete are silent so an open dialog or an
open dry-run panel is never unmounted.

List: a `<ul aria-label="Reminders">` (no extra heading: a second heading named like the panel would
break `getByRole("heading")` in the e2e specs) of `<li data-testid="reminder-<id>">` rows, in the
server's order (oldest first). Each row:

- line 1: rule text (truncating), then a small kind chip ("Scheduled" or "Calendar-gated");
- line 2 (muted), the "who and when" summary:
  - scheduled, apply_to_all: `All members · Mon, Wed`;
  - scheduled, specific: one segment per active assignment, `Ari: Mon, Wed · Bea: Fri` (member
    display names, all members including archived ones are resolvable; an unresolvable id is
    skipped);
  - calendar_gated: `Match text: <query>` then `All members` or the assigned names joined by `, `;
- right side: Active/Off badge (`Active` / `Off`), the existing Activate/Deactivate text button, a
  Dry-run toggle button (calendar_gated only), and two icon buttons Edit (`Pencil`) and Delete
  (`Trash2`) with `aria-label` `"<Edit|Delete>: <text>"`.

Dry-run panel: unchanged behaviour (member select, date defaulting to household today, Run,
verdict, request-id guard against stale responses), extracted into a `DryRunPanel` component and
rendered under the row when toggled.

Add/Edit dialog (`Dialog` primitive, testid `reminder-form-dialog`, `max-h` with scroll, one form,
Enter submits when valid), shared by create and edit:

- Title "Create Reminder" (create) or "Edit reminder" (edit); `sr-only` description reuses
  `reminders.management.description`.
- Kind: radios Scheduled / Calendar-gated in create mode; in edit mode kind is fixed and shown as
  read-only text (the API keeps `kind` immutable).
- Text input (placeholder "Reminder text").
- Applies to: radios "All members" / "Specific members", editable in both modes.
- Scheduled + all: `WeekdayPicker` (multi). Scheduled + specific: `AssignmentMatrixGrid`
  (member x weekday). Calendar_gated: query input, query field checkboxes, and when specific the
  members checklist. The weekday draft, the matrix draft and the members draft are separate state
  so toggling All/Specific back and forth keeps what was typed.
- Edit mode initial drafts come from the rule: weekdays, assignments to a matrix draft, calendar
  members; fields that do not apply start empty.
- Submit disabled until valid (same rules the create form has today: non-blank text; scheduled+all
  needs a weekday; scheduled+specific needs one member with a weekday; calendar_gated needs a query,
  at least one query field, and for specific at least one member).
- Footer: Cancel and Create Reminder / Save. A failed save keeps the dialog open and shows
  `ErrorNotice` (`reminders.management.saveError`) inside it.

Edit payload (always `PATCH /api/reminders/:id`): `{ text, targetingMode, ... }` plus
`weekdays` (scheduled + all) or `assignments` (scheduled + specific: member x weekdays;
calendar_gated + specific: members with `weekdays: []`) or `query` and `queryFields`
(calendar_gated). Create keeps the existing `POST /api/reminders` bodies.

Delete: Delete icon opens one page-level `ConfirmDialog` (title and text unchanged); testids
`reminder-delete-confirm-<id>` and `reminder-delete-cancel-<id>` are kept. Toggle and delete
failures show a page-level `ErrorNotice` (`reminders.management.actionError`).

The old "Assignments" toggle, the shared-weekday matrix and the inline card edit are removed; their
function moves into the dialog.

### API: editing targetingMode

`PATCH /api/reminders/:id` accepts two more keys, `targetingMode` and `assignments`. `kind` stays
immutable (400). Let `next = body.targetingMode ?? stored targeting_mode`.

| Stored kind    | Switch                   | Required in body                                                                                       | Effect                                                                      |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| scheduled      | apply_to_all to specific | `assignments` (member + non-empty weekdays)                                                            | `weekdays` set NULL, assignments written, rule row updated, one transaction |
| scheduled      | specific to apply_to_all | `weekdays`                                                                                             | `weekdays` stored, every active assignment set `active=0`, one transaction  |
| calendar_gated | apply_to_all to specific | `assignments` (membership only, `weekdays` absent or `[]`)                                             | assignments written                                                         |
| calendar_gated | specific to apply_to_all | nothing                                                                                                | every active assignment set `active=0`                                      |
| any            | same mode                | `assignments` optional when `next` is specific (full-set replace, same rules as `PUT .../assignments`) | as today                                                                    |

Validation (all before any write, so a rejected patch persists nothing):
`targetingMode` must be `apply_to_all` or `specific`; `assignments` is rejected when `next` is
apply_to_all; `weekdays` is rejected when `next` is specific and when the stored kind is
calendar_gated (existing rules, now evaluated against `next`); switching to apply_to_all on a
scheduled rule without `weekdays` is 400; switching to specific without `assignments` is 400;
assignment members must be active unless they already hold an active assignment on this rule (the
existing replace rule); duplicate member ids and empty sets are 400. Deactivating (not deleting)
assignments on a switch to apply_to_all matches `replaceAssignments` ("never hard-delete") and lets
a later switch back reuse and reactivate the rows. `GET` therefore returns `assignments: []` for
apply_to_all rules, as before. Emission (`getReminders`) already reads only active assignments of
specific rules, so no emission change.

Implementation shape: `replaceAssignments` is split into a validation step that returns a writer
closure (`planAssignmentSet(reminderId, kind, input)`) and the writer itself, so `editReminder` can
validate everything first and then run the rule `UPDATE` and the assignment writes inside one
`db.transaction` (FR-008, FR-015 atomicity). `replaceAssignments` keeps its signature and behaviour.

### Messages page

Heading equals the sidebar label: "Messages" / "Mensajes" (`dailyMessages.management.title`
value changes). A load failure of members or of the window's messages shows `ErrorNotice` plus a
"Retry" button (testid `daily-messages-retry`) that repeats the failed request; a save failure keeps
its own message and has no Retry; a delete failure gets its own message instead of reusing the load
error. Everything else (member select, 14-day window, blur-save, delete confirm, testids) is
unchanged.

## Decisions / Assumptions

1. Only Reminders gets the "Add rule" dialog; Messages has no create button (its editor is inline
   per day and stays).
2. Dialog, not Sheet and no new shared primitive. Everything is built from existing primitives and
   composites (`Dialog*`, `Button`, `Input`, `ConfirmDialog`, `ErrorNotice`, `AdminPanel`,
   `RadioField`, `CheckboxField`, `WeekdayPicker`, `NATIVE_SELECT_CLASSES`).
3. The reference's single "Active" checkbox inside the form is not copied; our row keeps the
   Activate/Deactivate button (brief: keep the activate toggle) plus the Active/Off badge.
4. Kind is read-only in edit mode: the brief asks only for targetingMode to become editable and
   FR-013 keeps `kind` immutable.
5. `assignments` is accepted on PATCH for any stored kind when the resulting mode is specific, so
   the edit dialog needs one request for text, targeting and members. `PUT .../assignments` stays
   (used by nothing in the client after this change, kept for API compatibility).
6. Page heading text changes (`reminders.management.title`, `dailyMessages.management.title`
   values, en and es) to match the sidebar labels; keys unchanged. `admin.nav.*` labels are not
   touched.
7. i18n keys that become unused after the rewrite (`reminders.matrix.toggleShow`, `.close`, `.save`,
   `.error`, `.emptySetError`, `.weekdaysRequiredError`, `reminders.calendarGated.membersRequiredError`)
   stay in the catalogue; deleting keys is out of scope and the parity tests pin them.
   `reminders.management.list` is reused as the list's `aria-label`.
8. A single file stays: `RemindersManagement.tsx` keeps all its sub-components (about the same size
   as today). Splitting would add files and per-file coverage floors for no behavioural gain. The
   exported `WEEKDAY_LABEL_KEYS`, `QUERY_FIELD_LABEL_KEYS`, `DRY_RUN_REASON_LABEL_KEYS` stay exported
   because `tests/client/reminders.test.tsx` imports them.
9. Delete failures and toggle failures use the page-level `ErrorNotice`; create/edit failures use
   the in-dialog one.
10. No seed change (existing seed already has both a scheduled/specific and a
    calendar_gated/specific rule, enough to exercise the row summaries).
11. No new database migration: `targeting_mode` and `weekdays` are already updated together by one
    `UPDATE` that satisfies the discriminant CHECK.
12. New i18n keys go in one contiguous block per locale under `// admin-reminders-messages`,
    appended at the end of each locale object (immediately before the closing `},` of `en` and of
    `es`), because other workers edit the same file. Two existing values change in place (the two
    titles).

## New i18n keys (en / es), block `// admin-reminders-messages`

| Key                                    | en                             | es                                   |
| -------------------------------------- | ------------------------------ | ------------------------------------ |
| `reminders.action.addRule`             | Add rule                       | Añadir regla                         |
| `reminders.management.editTitle`       | Edit reminder                  | Editar recordatorio                  |
| `reminders.management.saveError`       | Failed to save the reminder.   | Error al guardar el recordatorio.    |
| `reminders.management.actionError`     | Failed to update the reminder. | Error al actualizar el recordatorio. |
| `reminders.management.retry`           | Retry                          | Reintentar                           |
| `reminders.management.targetingLabel`  | Applies to                     | Se aplica a                          |
| `reminders.status.off`                 | Off                            | Apagado                              |
| `dailyMessages.management.retry`       | Retry                          | Reintentar                           |
| `dailyMessages.management.deleteError` | Failed to delete the message.  | Error al eliminar el mensaje.        |

Changed in place: `reminders.management.title` to "Reminders" / "Recordatorios";
`dailyMessages.management.title` to "Messages" / "Mensajes".

## Kept

Calendar-gated reminders and their query fields; per-member weekdays (the matrix, now inside the
dialog); dry-run/explain with its stale-response guard; activate/deactivate; themed delete confirm;
density compliance; household-timezone default for the dry-run date; Messages 14-day window,
blur-save, delete confirm and testids.

## Risks

- `tests/fixtures/assembly-cohort.json`: vitest case names are renamed and added, and the coverage
  floor for `RemindersManagement.tsx` / `reminders/index.ts` / `DailyMessagesManagement.tsx` is
  totals-based; resync from a real run (the verifier prints the differences). The playwright test
  titles are unchanged.
- Density census numbers in `tests/client/reminders.test.tsx` change; recompute from the real DOM and
  justify them in a comment, do not guess.
- `check:accessible-names` audits icon buttons: both icon buttons carry an `aria-label`.
- `check:openapi` / `check:openapi-shapes` compare the OpenAPI documents with the routes and shared
  types; edit both OpenAPI files and `ReminderEditInput` together.
- Radix `Dialog` portals out of the row; tests must query `screen`, not the row, for dialog content.
- `messages.ts` is edited by parallel workers: keep to the two title values plus one appended block
  per locale.
- Two PATCH behaviours change for existing callers: `{ targetingMode: ... }` was always 400 and is
  now accepted; `{ assignments: ... }` on an apply_to_all rule is still 400 (different message).
  No client or seed used either.
