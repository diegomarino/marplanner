# External Event Participants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the family pick participants on external (feed) events from `/calendar` without
turning title-derived assignments into manual ones.

**Architecture:** One minimal server change in `replaceAssignments` keeps `ext:` rows for members
still requested; the client adds a participants-only panel for `source === "external"` that reuses
the local edit form's member state and calls the existing `PUT /assignments`.

**Tech Stack:** Fastify + better-sqlite3 (server), React + Vitest/RTL (client), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-17-external-event-participants-design.md`

## Global Constraints

- No new endpoint, no response shape change, no new API field.
- i18n en and es added in one block (`src/client/i18n/messages.ts`), keys `calendar.editParticipants`,
  `calendar.externalParticipantsHint`, reworded `calendar.externalReadOnly` (copy verbatim in spec).
- Test ids: `calendar-edit-participants-btn`, `calendar-participants-save-btn`, pills prefix
  `calendar-assign-member`.
- Docs kept in sync: `docs/features/calendar.md`, `docs/api/calendar/openapi.yaml`,
  `docs/ui/household-contract.md`.
- Density tests must not block; if a census count shifts, update the count, not the assertion.

## Review Focus

- PUT with the exact current set on an external event → nothing changes, `ext:` ids preserved
  (Task 1 test "keeps title-derived rows title-derived").
- PUT with `[]` on an external event → all rows gone; next same-title sync restores only the
  title-derived member (Task 1 test).
- Duplicated ids in the PUT body on an external event → one row per member (covered by existing
  dedup + Task 1 assertion on row count).
- Unchanged selection on Save → no request, panel closes (Task 2 test).
- Members failed to load when opening the panel → error notice instead of pills (reused branch;
  Task 2 asserts the panel uses the same component path via the existing members-error test id).

---

### Task 1: Server — keep `ext:` rows on assignment replace

**Files:**

- Modify: `src/server/modules/calendar/index.ts` (`replaceAssignments` transaction)
- Modify: `docs/api/calendar/openapi.yaml` (PUT summary/description)
- Modify: `docs/features/calendar.md` (manual-assignment edge case)
- Test: `tests/boundary/calendar-sync.test.ts`

**Interfaces:**

- Consumes: `reconcileExternalCalendar`, `calendarRoutes` (already imported by the test file).
- Produces: unchanged `replaceAssignments(eventId: string, memberIds: string[]): FeedItem`.

- [ ] **Step 1: Write failing boundary tests** in a new `describe("manual participants on an
external event")` in `calendar-sync.test.ts`, driving PUT through a Fastify app with
      `calendarRoutes` (auth as the file's existing route test does), members Bart + Lisa, event from
      `occurrence("one", "Bart school")`:
  - "keeps title-derived rows title-derived": PUT `{memberIds: [bart, lisa]}` → 200; rows =
    `[{member: bart, derived: 1}, {member: lisa, derived: 0}]`, exactly 2 rows.
  - "keeps the manual member and follows the title on later syncs": after that PUT, reconcile with
    the same title → same 2 rows; reconcile with title "School trip" → only lisa (manual) remains.
  - "clearing removes everyone until the title is read again": PUT `[]` → 0 rows; reconcile same
    title → only bart (`ext:`).
- [ ] **Step 2: Run** `npx vitest run tests/boundary/calendar-sync.test.ts` — the first two fail
      (bart row is not `ext:` / bart survives the rename).
- [ ] **Step 3: Implement** inside the existing transaction: delete rows for the event where
      `id NOT LIKE 'ext:%' OR member_id NOT IN (requested)`; then insert a `randomUUID()` row only for
      requested members with no remaining row. Use `json_each(?)` with `JSON.stringify(ids)` for the
      `NOT IN` so an empty set works.
- [ ] **Step 4: Run** the sync and `tests/boundary/calendar-assign.test.ts` — all pass.
- [ ] **Step 5: Docs** — OpenAPI: add a `description` to the PUT saying title-derived (`ext:`) rows
      for members still in the set are kept so feed syncs keep owning them. Feature spec: rewrite the
      edge case's last sentence to say the Calendar screen offers participant editing on external events
      and saving keeps title-derived members title-derived.
- [ ] **Step 6: Commit** `fix(calendar): keep title-derived assignments when replacing an external event's people`.

### Task 2: Client — Edit participants panel on external events

**Files:**

- Modify: `src/client/calendar/CalendarView.tsx`
- Modify: `src/client/i18n/messages.ts`
- Modify: `docs/ui/household-contract.md` (Calendar paragraph)
- Test: `tests/client/calendar-view.test.tsx`

**Interfaces:**

- Consumes: Task 1 server semantics (no client-visible change).
- Produces: `submitParticipants(event: FeedItem): Promise<void>` inside `CalendarView`.

- [ ] **Step 1: Write failing tests** (replace the existing "keeps external events readable…" test,
      extend the imported-event test):
  - "offers only participant editing on an external event": note text
    "From an external calendar — its title, time, location and description are read only.";
    `calendar-edit-btn` and `calendar-delete-btn` absent; click `calendar-edit-participants-btn` →
    pills present, hint "People named in the title are added again at the next sync." present, no
    `calendar-edit-title-input`, no textbox in the dialog.
  - "saves an external event's participants with one PUT": external event with
    `assignedTo: []`, click Alice pill, Save → exactly one `PUT …/external-1/assignments` with
    `{memberIds: ["m1"]}`, zero PATCH, dialog closes.
  - "closes without a request when the participants did not change": Save directly → no PUT.
  - "keeps the participants panel open when the save fails": `assignments: () => json(null, 500)`
    → alert "Failed to update assignment.", save button still present.
- [ ] **Step 2: Run** `npx vitest run tests/client/calendar-view.test.tsx` — new tests fail.
- [ ] **Step 3: Implement** — i18n keys (en+es together); `openParticipants(event)` sets the
      `showEdit` key, `editingEvent`, `editMemberIds`; `submitParticipants` compares sets, PUTs when
      changed, then `closeEdit(); setSelectedEvent(null); setReloadKey(k+1)`, else on `!ok` sets
      `calendar.assignmentError`. In the external branch render the note, then either the panel
      (muted rounded container, `<form>` with the participants `fieldset` reusing the loading / error /
      `MemberPills` branches, hint `<p className="text-muted-foreground text-sm">`, `ErrorNotice`,
      Save/Cancel) or the outline `sm` button with the `Users` icon. Extract the participants
      `fieldset` into a local render helper shared with the local edit form.
- [ ] **Step 4: Run** the client calendar tests (`npx vitest run tests/client/calendar`) — pass;
      update any density census count that shifted.
- [ ] **Step 5: Docs** — household contract Calendar paragraph: inline create, assign, edit and
      delete on local events, and participant editing on external events whose feed fields stay read
      only.
- [ ] **Step 6: Commit** `feat(calendar): edit participants on external events`.

### Task 3: E2E and gates

**Files:**

- Test: `tests/e2e/calendar-feed-sync.spec.ts` (one case if its tracer fixture yields a visible
  external event on `/calendar`; otherwise skip and say so in the report)
- Modify: `tests/fixtures/assembly-cohort.json`

- [ ] **Step 1:** If cheap, add "assigns a participant to a synced event": open the tracer event,
      Edit participants, pick a member, Save, reopen → member chip shown.
- [ ] **Step 2:** `npm run check:standard` in a clean detached checkout; then
      `npm run check:aggregate-only` with the given ports.
- [ ] **Step 3:** Resync `assembly-cohort.json` (vitest cases, Playwright ids, coverage; lower
      `minimumTotals` only where code shrank, never `minimumRates`); commit
      `test: resync assembly cohort`.
