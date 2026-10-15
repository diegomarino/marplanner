# Feature: Routines & Chores (repeatable child-facing household work)

Behavior reference. The [owning contract](../architecture/contracts/routines-chores.md) defines invariants and extension limits.

Routines are named templates attached to one **day period**; chores are ordered tasks
within a routine; **assignments** link one routine to one active child on a set of
weekday codes; **completions** are raw evidence rows recording that a member marked a
chore done for a household-local date. A member's **streak / last-all-complete** is
**derived, computed on-read** from completion evidence against the current-active
configuration — never stored on Members.

## User workflows

### User Story 1 — Configure a child's daily routine

A parent creates a "morning" routine, adds ordered chores ("make bed", "brush teeth"),
and assigns it to an active child on weekdays `mon..fri`; the child's daily board for
those weekdays shows those chores in order under the morning day period.

### User Story 2 — A child completes (and corrects) chores

A child marks a chore done for today; the toggle is accepted only because the chore is
currently markable on that date's board. A parent later navigates the board to a past
date and corrects a missed mark — no admin override, because the board shows what
currently applies for that date.

### User Story 3 — Streak reflects current configuration

A parent reorganizes routines; the child's live streak recomputes against the new
current-active config and is shown only on present/forward views, with a warning that
reorganizing changes the live streak. Past celebrations remain in immutable briefing
snapshots.

### Edge Cases

- A new assignment targeting an archived (inactive) member is rejected at write; an
  assignee archived later renders read-only and drops from active reads.
- A weekday write outside the `mon..sun` enum, or an impossible date like `2025-02-30`,
  is rejected — never normalized.
- A chore reorder that fails midway rolls back entirely; no partial ordering persists.
- The live streak is never surfaced on past-date / history views.

## Requirements

### Functional Requirements

- **FR-001**: Given a new assignment write, when its target member is not an active child, then the write MUST be rejected (archived members are inassignable), and when a member is archived later, then existing rows MUST drop from active reads and render read-only history. Contract: ROUTINES-CHORES-INV-01.

- **FR-002**: Given a weekday value on an assignment, when it is written or read, then it MUST be one of the canonical string codes `mon..sun` (ADR-020), and when a weekday must be derived from a date, then it MUST be computed via `weekdayOf(date, tz)` in the household timezone (ADR-005). Contract: ROUTINES-CHORES-INV-02.

- **FR-003**: Given any date value, when it is written, then it MUST be a strict calendar-valid `YYYY-MM-DD` string (ADR-006), and impossible dates MUST be rejected rather than normalized. Contract: ROUTINES-CHORES-INV-03.

- **FR-004**: Given a complete or uncomplete request for a member/chore/date, when eligibility is evaluated, then it MUST be checked against current state (not reconstructed history), and a completion MUST be allowed iff the chore is currently markable — the member is active and a child, the chore and its routine are active, and an active assignment covers that date's weekday — except that uncompletion of an already-recorded completion is always allowed (the AC-01 refinement realized by FR-010). Contract: ROUTINES-CHORES-INV-04.

- **FR-005**: Given a past-date correction, when it is performed, then it MUST succeed without any admin override path and without historical reconstruction, because the board navigates to the past date and shows what currently applies. Contract: ROUTINES-CHORES-INV-05.

- **FR-006**: Given a member's streak or summary, when it is requested, then it MUST be derived on-read from completion evidence (ADR-043), and Members MUST store no streak fields. Contract: ROUTINES-CHORES-INV-06.

- **FR-007**: Given a multi-step primary write such as a chore reorder or a set-replace, when it is persisted, then it MUST be applied atomically as an all-or-nothing transaction, and per-chore fire-and-forget writes MUST NOT be used. Contract: ROUTINES-CHORES-INV-07.

- **FR-008**: Given a soft-deleted routine, chore, or assignment, when active reads or on-read streak interpretation run, then it MUST be excluded from them, while remaining readable for history. Contract: ROUTINES-CHORES-INV-08.

- **FR-009**: Given the live streak as a current-progress indicator, when a routine is soft-deleted or reassigned, then those days MUST retroactively drop from the recomputed live streak (accepted), the live streak MUST NOT be surfaced on past-date/history views, admins MUST be warned that reorganizing routines changes the live streak before they act, and past celebrations MUST be preserved in immutable briefing snapshots (ADR-022). Contract: ROUTINES-CHORES-INV-09.

- **FR-010**: Given a completion request, when the chore is currently markable for that member/date, then the completion MUST be accepted, and when an existing completion is uncompleted, then the uncompletion MUST always be allowed. Contract: ROUTINES-CHORES-AC-01.

- **FR-011**: Given a past-date correction, when it is submitted, then it MUST succeed without an admin override. Contract: ROUTINES-CHORES-AC-02.

- **FR-012**: Given a chore reorder, when it is persisted, then it MUST persist atomically or roll back, leaving no partial order. Contract: ROUTINES-CHORES-AC-03.

- **FR-013**: Given a streak read, when it is computed, then it MUST reflect the current-active config at read time, and retroactive reinterpretation MUST be expected. Contract: ROUTINES-CHORES-AC-04.

- **FR-014**: Given a write, when a weekday outside the 7-code enum is supplied, then it MUST be rejected, and when an impossible date is supplied, then it MUST be rejected. Contract: ROUTINES-CHORES-AC-05.

- **FR-015**: Given a routine edit that names a `dayPeriodId`, when it is applied, then the id MUST be a non-blank string naming an existing day period or the whole edit MUST be rejected (400) with nothing written; when accepted, the routine moves to that period and the board shows it there immediately. Admins MUST be warned that moving a routine changes the live streak before they confirm (FR-009).

- **FR-016**: Given the admin routine list, when it is read, then active routines MUST be ordered by their day period's start time, then by name (case-insensitive).

### Key Entities

- **Routine**: a named active/inactive template attached to exactly one day period, which an admin may change (FR-015).
- **Chore**: a named active/inactive task within one routine, carrying a sort order.
- **Assignment**: a rule linking one routine to one active child on a set of weekday
  codes (`mon..sun`); reactivation reuses the existing routine/member logical row.
- **Completion**: a raw evidence row recording that a member marked a chore done for a
  household-local date — not validated against history; emits
  `routines.completion_changed`.
- **Streak / last-all-complete**: a derived-on-read indicator computed from completion
  evidence against current-active config; never stored on Members.

## Success Criteria

- **SC-001**: 100% of completion/uncompletion toggles are accepted iff the chore is
  currently markable for that member/date (uncompletion of an existing row always
  allowed).
- **SC-002**: 100% of chore reorders either persist the full new order or leave the
  prior order intact — no partial ordering is ever observable.
- **SC-003**: 0 weekday writes outside `mon..sun` and 0 impossible dates are persisted.

## Assumptions

- Day-period vocabulary and start times are owned by the Day Periods domain
  (ADR-010/ADR-011); this spec attaches routines to those periods.
- Atomicity and date/weekday derivation primitives are provided per ADR-043/ADR-005/
  ADR-006/ADR-020.
- Fresh data store; no legacy import (ADR-026) — the orphaned `routine_assignments`
  are evidence only, never imported as active rules (ADR-054).
- Members are archive-only (never hard-deleted, ADR-054), so a dangling assignment is
  unrepresentable: strict-on-write (assign only active members), tolerant-on-read
  (archived assignee renders read-only).
