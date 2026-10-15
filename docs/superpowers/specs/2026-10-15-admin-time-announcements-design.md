# Admin parity: Time announcements page (design)

Date: 2026-10-15. Scope: UI-only port of the reference app's time-announcements admin
(`<marplanner-v1>/apps/web/src/features/time-announcements/TimeAnnouncementAdmin.tsx`
and `TimeAnnouncementForm.tsx`) into our `src/client/admin/TimeAnnouncementsManagement.tsx`.
No server, shared-type, OpenAPI or schema change. Owner waived design review; every question below
was answered from the brief and the code and is recorded under Decisions.

## Intent

An admin managing the household's spoken time announcements should see the rules as scannable
cards (big time, weekday circles, dimmed when inactive) and create/edit them in one dialog, the
same way the reference does, while keeping what ours already does better (activate/deactivate
button, server overlap errors, local test voice, rules-changed event, i18n, ErrorNotice).

Success: the page behaves like the reference's admin for create/edit/delete, `window.confirm` is
gone, load failures can be retried, and the existing behaviours listed under "Kept" still pass.

## Current state (verified)

- `src/client/admin/TimeAnnouncementsManagement.tsx` (421 lines): always-visible create form,
  inline per-card edit form, text buttons Edit / Activate-Deactivate / Delete, `window.confirm`
  delete, plain-text loading state, load error shown via `ErrorNotice` with no retry.
- Routed from `src/client/admin/AdminRoutes.tsx` (`/admin/time-announcements`, sidebar label key
  `admin.sidebar.timeAnnouncements` = "Time announcements" / "Anuncios horarios"; panel title key
  `timeAnnouncements.management.title` = "Time Announcements" / "Anuncios Horarios" differs).
- API (unchanged): `GET/POST /api/time-announcements`, `PATCH/DELETE /api/time-announcements/:id`,
  body `{ time, weekDays, isActive }`, 409 `active_overlap`, 400 `validation_error`.
- `testVoice(time, lang)` in `src/client/time-announcements/speech.ts` speaks locally; it has a
  private `pickVoice(synth, lang)` but nothing exports the selected voice name.
- Seed `seeds/seed-080-time-announcements.ts` already creates two active rules (07:00, 19:00,
  mon-fri). No seed change needed.
- Tests that pin the current UI: `tests/client/time-announcements-management.test.tsx`,
  `tests/client/announcements-briefing-admin.test.tsx` (landmark, density census 17/25/14,
  ErrorNotice, WeekdayPicker, WEEKDAY_LABEL_KEYS), `tests/e2e/admin-unlock-resilience.spec.ts`
  (uses testid `time-announcements-create` as the page's primary action),
  `tests/e2e/time-announcements.spec.ts` (clock-driven, creates rules via HTTP only).
  `tests/fixtures/assembly-cohort.json` lists vitest case names and per-file coverage floors.

## Target behaviour

Header: `AdminPanel` title equals the sidebar label; `actions` slot holds a "+ Create" button
(`Plus` icon, testid `time-announcements-create`, kept so the unlock-resilience e2e still finds
its primary action). Shown once the list has loaded.

States: loading = centered spinner (`Loader2`, `role="status"`, accessible text = existing
loading message); load error = `ErrorNotice` + "Retry" button; empty = existing empty message.

Cards (a `<ul>` of `<li data-testid="time-announcements-rule-<id>">`), ordered as the server
returns them (no client re-sort, FR-006):

- Big time (`text-3xl tabular-nums`), 7 round weekday circles in canonical Mon-Sun order (on =
  primary fill, off = muted), localized single-letter initials, circles are `aria-hidden` and a
  `sr-only` sentence lists the selected full weekday names.
- Inactive: time + circles dimmed (`opacity-60`, not the buttons, to keep contrast on controls)
  and an "Inactive" tag.
- Icon buttons Edit (pencil) and Delete (trash) with localized `aria-label` (`Edit 07:00`),
  testids `time-announcements-edit-<id>` / `time-announcements-delete-<id>`.
- Activate/Deactivate secondary button kept (`time-announcements-toggle-<id>`), PATCH
  `{ isActive: !isActive }` exactly as today.

Dialog (shared `Dialog` primitive, not a Sheet): one dialog for create and edit,
testid `time-announcements-form-dialog`.

- Title: "New rule" (create) / "Edit announcement" (edit); description line.
- Time input (`type="time"`, default `07:00` on create, testid `time-announcements-time-input`) with
  a "Test voice" button beside it (`time-announcements-test-voice`, speaks the unsaved time, never
  POSTs, enabled whenever a time is set, FR-014).
- Voice line under the time: `Voice: <name>` or "No voice available for this language". The name
  comes from a new exported `voiceNameFor(lang)` in `speech.ts`; polled every 500 ms while the
  dialog is open because Chromium loads voices asynchronously (the reference does the same).
- `WeekdayPicker` multi mode (testIdPrefix `time-announcements-weekday`), `CheckboxField`
  Active (`time-announcements-active-checkbox`).
- Footer: Cancel and a submit button (`time-announcements-submit`, label Create / Save, "Creating…"
  / "Saving…" while pending). Disabled until a time and at least one weekday are set. Enter in the
  time input submits (it is a `<form>`).
- Server errors (409 overlap, 400 validation, other) show in an `ErrorNotice` inside the dialog
  (`time-announcements-form-error`) and the dialog stays open with the form intact. Success closes
  the dialog, reloads the list and dispatches `RULES_CHANGED_EVENT` (unchanged contract).
- Closing is blocked while a save is in flight.

Delete: `ConfirmDialog` (`@/components/ConfirmDialog`, destructive), confirm testid
`time-announcements-delete-confirm`. Confirm runs DELETE, reloads, dispatches `RULES_CHANGED_EVENT`;
failures show in the panel-level `ErrorNotice` (`time-announcements-error`). `window.confirm` is
removed everywhere.

Panel-level `ErrorNotice` (`time-announcements-error`) now carries: load failure, delete failure,
toggle failure.

## Kept (explicit)

Activate/deactivate button; server overlap and validation messages mapped through
`responseMessage`; local Test voice without writes; `RULES_CHANGED_EVENT` after every successful
write; server ordering; `AdminPanel` landmark/heading; kiosk density compliance (all controls use
the density-token primitives); en/es parity.

## Decisions / Assumptions

1. Create and edit share one dialog; the old inline edit form and always-visible create form go.
2. "+ Create" keeps testid `time-announcements-create` (e2e primary action). The dialog submit is
   the new `time-announcements-submit`. Tests that used `-create` as the submit are updated.
3. Edit-specific testids (`-edit-time-<id>`, `-edit-weekday-<id>-*`, `-edit-active-<id>`,
   `-save-<id>`, `-cancel-<id>`) disappear; the dialog fields use the same testids for create and
   edit. The tests that used them are updated.
4. Form errors get their own testid (`time-announcements-form-error`) so there is never a duplicate
   `time-announcements-error` while the dialog is open.
5. Panel title is changed to equal the sidebar label (brief rule 2): values of
   `timeAnnouncements.management.title` become "Time announcements" / "Anuncios horarios" (edited
   in place, not in the new block). `admin.nav.timeAnnouncements` (used for navigation/plugin
   labels) is untouched.
6. Weekday circle initials are new keys `timeAnnouncements.weekdayInitial.<day>` (en M T W T F S S,
   es L M X J V S D). The reference's `weekDays.initial.*` keys do not exist in our catalog.
7. The reference form's "empty weekdays" validation message is not needed: the submit button is
   disabled instead, matching our current Create button behaviour.
8. Voice name is read through a new tiny export `voiceNameFor(lang: Language): string | null` in
   `speech.ts` (reuses `pickVoice`, try/caught like the rest). No other speech behaviour changes.
9. Load error: Retry button re-runs the list load. Create/Retry are not offered together: on a
   failed first load the header Create button is hidden (nothing to anchor a list to), Retry shows.
10. Dimming applies to the time and circles only, not the action buttons.
11. Unused old keys (`createTitle` is reused as the dialog title; `list`, `statusActive` become
    unused) are left in place to avoid churn and merge conflicts in `messages.ts`.
12. No new shared component. `Dialog`, `ConfirmDialog`, `ErrorNotice`, `WeekdayPicker`,
    `CheckboxField`, `Button`, `Input`, `Label`, `AdminPanel` are reused. Icons from `lucide-react`
    (`Plus`, `Pencil`, `Trash2`, `Volume2`, `Loader2`) which the repo already depends on.
13. A new default-run e2e spec `tests/e2e/time-announcements-admin.spec.ts` covers the admin UI CRUD
    (the existing `time-announcements.spec.ts` seeds via HTTP and is excluded from default runs by
    `playwright.config.ts` unless `MP_E2E_TIME_ANNOUNCEMENTS=1`). It uses a 03:17 Saturday-only rule
    so it cannot collide with demo seeds, and deletes its own rule through the UI. The new file is
    added to the Playwright cohort in `assembly-cohort.json`.
14. Docs: a new FR-020 in `docs/features/time-announcements.md` records the admin surface contract;
    `docs/ui/household-contract.md` line for `/admin/time-announcements` gets a short description.
    OpenAPI untouched (no API change).

## Risks

- `tests/fixtures/assembly-cohort.json`: vitest case names are renamed/added, and coverage floors
  for `TimeAnnouncementsManagement.tsx` and `speech.ts` are totals-based; both are re-synced from a
  real run (the verifier prints the differences).
- Density census numbers in `announcements-briefing-admin.test.tsx` change; they must be recomputed
  from the real DOM and the new numbers justified in a comment, not guessed.
- `check:accessible-names` audits icon buttons: every icon-only control has an `aria-label`.
- `messages.ts` is edited by parallel workers: keep the edit to the title values plus two contiguous
  blocks at the end of each locale.
