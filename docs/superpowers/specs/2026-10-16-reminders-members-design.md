# Reminders — member pills and several members on calendar-gated rules (design)

Date: 2026-10-16 · Branch: `feat/reminders-members` · Source: owner brief "Final admin touches", Worker B (item 4).

Written autonomously (the owner asked for no questions); every decision below is the worker's call
unless quoted from the brief.

## Intent

The owner wants to see at a glance who each reminder reaches, in the same member-colour language the
rest of admin now uses (variant "D": filled member colour + white text), and to be able to aim a
calendar-gated reminder ("bring shin pads") at several children, not one.

## Findings (current state, verified in code)

- **Data model**: `reminder_assignment` holds N rows per rule; a `calendar_gated` + `specific` rule
  already stores one membership-only row per member. No schema change is needed.
- **Server**: `createCalendarGatedReminder` → `validateCalendarGatedAssignmentSet` accepts a
  non-empty array with no duplicate members; `PATCH` (`planAssignmentSet` →
  `validateCalendarGatedAssignmentSetForReplace`) and `PUT /assignments` do the same full-set
  replace. Emission (`getReminders`) joins `reminder_assignment` per member, so every assigned
  member is gated independently against their own assigned events. FR-010/FR-018 already say "N
  assignments". **Nothing to extend server-side**; OpenAPI and shared types already model an array.
- **Gap 1**: no test proves a calendar-gated rule with two members (all existing boundary tests use
  one member).
- **Dialog**: the calendar-gated "Members" control is already a multi-select `MemberPills`
  (`cgMemberIds`). Only one member is ever selected in tests.
- **Row summary**: `summarize()` renders one muted text line ("Match text: vet · Ari",
  "Ari: Mon, Wed · Bea: Fri", "All members · Mon") — names are plain text.
- **Gap 2 (dry-run)**: the dry-run member `<select>` lists every active member. The server's
  `dryRun` does not check targeting, so asking about a member a `specific` rule does not target
  reports "would emit" when an event matches — misleading once rules name several members.

## Goals

1. Each list row shows who it applies to as member-colour pills, one per member (filled colour,
   white text), for scheduled and calendar-gated rules alike. "All members" stays a neutral label.
2. Calendar-gated rules demonstrably accept, persist, edit and emit for several members (tests at
   the boundary and client level).
3. The dialog's calendar-gated member control is a multi-select `MemberPills` (already true; locked
   by tests: pick two → body carries two membership-only assignments; edit preselects both).
4. Dry-run/explain keeps working with several members: for a `specific` rule the member picker
   offers only the rule's targeted active members; for `apply_to_all` it offers all active members.

## Non-goals

- No migration, no server validation change, no new OpenAPI fields, no new dry-run reason.
- No change to the scheduled per-member weekday editor (`ReminderMemberDays`).
- No restyle of the kind / Active badges or row actions.

## Anti-goals

- Colour must never be the only signal: pills carry the member's name as text.
- Never show an archived member's pill (they drop from emission, FR-002); unknown ids are skipped as
  today.

## Design

### Row "who" line (worker's call)

Replace the single muted string with a wrapping flex line (`data-testid="reminder-who-<id>"`):

| Rule | Rendering |
| --- | --- |
| scheduled · apply_to_all | neutral label "All members" · weekday list (muted text) |
| scheduled · specific | per member: `[Ari pill]` "Mon, Wed" — groups separated by gap |
| calendar_gated · apply_to_all | "Match text: vet" · neutral "All members" |
| calendar_gated · specific | "Match text: vet" · `[Ari pill]` `[Bea pill]` |

- The pill is the existing `MemberChip` (`src/client/routines/admin/MemberChip.tsx`), which already
  renders exactly variant D's selected look (`bg-[var(--member-color)]`,
  `text-member-avatar-foreground`, semibold, rounded-full). It is imported where it lives rather
  than moved: it is non-interactive, so by the component contract's admission rule it is not a
  `components/` member, and moving it would collide with the parallel briefing worker.
- The neutral "All members" label keeps the existing muted pill look used by the kind badge
  (`bg-muted rounded-full`), so it reads as a label, not a member.
- Lookup uses all members (archived included) as today, but archived members are filtered out of
  the pills because their assignments are inactive-in-effect; the server already returns only
  active assignments, so the rule is: render a pill for each returned assignment whose member is
  known and `lifecycle === "active"`.

### Dry-run member options (worker's call)

`DryRunPanel` receives `members`: for `specific` rules, active members holding an assignment on the
rule (rule order = members order); for `apply_to_all`, all active members. The `<select>` stays
(behaviour, density counts and e2e selectors unchanged).

### Docs

- `docs/ui/household-contract.md`: the reminders paragraph names the member-colour pills in rows
  and the calendar-gated multi-member choice.
- `docs/features/reminders.md`: User Story 2 says "one or several members"; no new FR (FR-010 and
  FR-018 already cover N members).

### Tests

- Boundary: create a calendar-gated `specific` rule with two members → 201 with two assignments;
  emissions for each member on a day each has a matching assigned event; PATCH replacing the set
  with two different members; dry-run for each member.
- Client: row pills (names as pill elements within the who-line, neutral "All members"); dialog
  pick two members → POST body two assignments; edit preselects both; dry-run options limited to
  targeted members.
- E2E (`tests/e2e/reminders-calendar-gated.spec.ts`): extend an existing spec only if it already
  creates a specific rule; no new spec files beyond need. Density tests: update counts only.

## Left to the builder

Exact class names, test ids beyond `reminder-who-<id>`, and i18n keys (none expected: all strings
already exist).

## Builder self-check (autonomous)

- "Is a server change needed?" — answered: no (see Findings).
- "Pill component?" — answered: `MemberChip`, imported in place.
- "What about the dry-run for a non-targeted member via the API?" — minor: server behaviour kept;
  recorded as an open issue in the report rather than widening the contract (AC-10 lists three
  reasons).
