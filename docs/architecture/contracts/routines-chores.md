# Routines & Chores Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-009`, `ADR-020`, `ADR-022`, `ADR-040`, `ADR-043`

## Purpose

Defines repeatable child-facing household work: routines (templates grouped by day
period), chores (ordered tasks within a routine), assignments (routine→child on
weekdays), and chore completions (a child marking a chore done for a local date).

## Vocabulary

- **Routine** — named active/inactive template attached to one day period.
- **Chore** — named active/inactive task in one routine, with sort order.
- **Assignment** — rule linking one routine to one active child on a set of weekday
  codes (ADR-020).
- **Completion** — raw evidence that a member marked a chore done for a household-local
  date. Not a validated-against-history fact; an evidence row.
- **Streak / last-all-complete** — **derived, computed on-read** from completions
  (ADR-043); not stored on Members.

## Invariants

1. **ROUTINES-CHORES-INV-01** **Targeting:** new assignments target **active children only** (ADR-002); archived
   members are inassignable and drop out of active reads (historical rows read-only).
2. **ROUTINES-CHORES-INV-02** **Weekdays** are the canonical string-code set `mon..sun` (ADR-020); derivation via
   `weekdayOf(date, tz)` in household tz (ADR-005).
3. **ROUTINES-CHORES-INV-03** **Dates** are strict calendar-valid `YYYY-MM-DD` (ADR-006); rejected, not normalized.
4. **ROUTINES-CHORES-INV-04** **Completion eligibility is evaluated against current state**, not reconstructed
   history (ADR-043): a completion/uncompletion is allowed iff the chore is currently
   markable for that member/date — the day's board shows it now (member active+child,
   chore + routine active, an active assignment covering that date's weekday). "If you
   can see it on the board for that date, you can toggle it."
5. **ROUTINES-CHORES-INV-05** **No historical reconstruction, no admin override path** for normal date
   corrections — past-date edits work because the board can navigate to a past date and
   shows what currently applies.
6. **ROUTINES-CHORES-INV-06** **Streak/summary is derived-on-read** (ADR-043); Members stores no streak fields.
7. **ROUTINES-CHORES-INV-07** **Multi-step primary writes are atomic** (ADR-043 class 1): chore reorder, and any
   set-replace, are all-or-nothing transactions (no fire-and-forget per-chore writes).
8. **ROUTINES-CHORES-INV-08** Soft-deleted routines/chores/assignments stay readable for history but are excluded
   from active reads and from on-read streak interpretation.
9. **ROUTINES-CHORES-INV-09** **Live streak is a current-progress indicator, not history.** Because it recomputes
   against current-active config, soft-deleting/reassigning a routine retroactively drops
   those days from the live streak (accepted). UX guard (peer-review M1): do **not**
   surface the live streak on past-date/history views, and warn admins that
   reorganizing routines changes the live streak before they act. Past celebrations
   remain preserved in immutable briefing snapshots (ADR-022).

## Behaviors

- **Configure** routines/chores/assignments (parent/admin): create/edit/soft-delete,
  reorder (atomic), toggle assignment weekdays. Assignment reactivation reuses the
  existing routine/member logical row.
- **Daily chores read** for member/date: derive weekday (`weekdayOf`), find active
  assignments for that weekday, keep active routines+chores, return all day periods
  ordered by start time (empty periods included).
- **Complete / uncomplete:** validated per invariant 4; a completion is an evidence
  row; emits `routines.completion_changed`.
- **Streak / celebration:** consumers of completion evidence/events; computed on-read.

## Interfaces

- Inbound (host API): routine/chore/assignment CRUD, daily-chores query, complete/
  uncomplete, `Routines.getMemberStreak(memberId)` (derived read consumed by Daily
  Briefing/Members).

## Events

(ADR-040.) **Emits** `routines.completion_changed` with full context (member, chore,
routine, date, completed bool, timestamp) so consumers (on-read streak, Daily Briefing,
celebration overlay) decide. **Subscribes** to none. The anticipated
`routines.morning_completed`-style trigger for "print briefing when morning routines
complete" is a consumer-side derivation over completion events, not new scheduler state.

## Data / Setup Contract

Owned: routines, chores, assignments, completions (namespaced). Members streak summary
fields are dropped (ADR-043). No legacy import (ADR-026); the 9 orphaned
`routine_assignments` are evidence only, never imported as active rules. In-v2 orphan
handling is resolved by `ADR-054`: members are archive-only (never hard-deleted), so a
dangling assignment is unrepresentable — strict-on-write (assign only active members) /
tolerant-on-read (archived assignee renders read-only).

## Acceptance Criteria

- **ROUTINES-CHORES-AC-01** A completion is accepted iff the chore is currently markable for that member/date;
  uncompletion of an existing completion is always allowed.
- **ROUTINES-CHORES-AC-02** Past-date corrections succeed without an admin override.
- **ROUTINES-CHORES-AC-03** Reorder persists atomically or rolls back; no partial order.
- **ROUTINES-CHORES-AC-04** Streak reflects current-active config at read time (retroactive reinterpretation is
  expected).
- **ROUTINES-CHORES-AC-05** Weekday writes outside the 7-code enum are rejected; impossible dates are rejected.

## Open Decisions

- Whether future-dated completions are allowed (default: past+today only) — deferred to
  UI build. (`ADR-004` in-v2 orphan handling resolved by `ADR-054`; `ADR-010`/`ADR-011`
  day-period vocabulary/start times accepted in the Day Periods domain.)
