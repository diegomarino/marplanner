# ADR-020 Canonical Weekday Model

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Decision

The canonical weekday representation for this system (Routines assignments and Reminders
rules alike) is a **set of string codes** `mon | tue | wed | thu | fri | sat | sun`.
Reminders migrates off ISO `1..7`.

- Stored as a **set**, validated against the 7-value enum at the write boundary
  (eliminates v1's "weekday is an arbitrary non-empty string" so invalid tokens can't
  be stored).
- A **single derivation utility** `weekdayOf(localDate, tz)` returns the canonical
  code in household timezone (ADR-005), replacing scattered Sunday-first `getDay()`
  remapping.
- **`weekStartDay` (App Settings) is presentation-only** — where the week grid starts
  — and never affects matching. `mon` matches Monday regardless of grid start.

**All weekday writes use the canonical validator (peer-review I2).** API and public
seed writers share `src/shared/weekdays.ts`; domain-specific empty-set, duplicate and
ordering policies remain unchanged. SQLite's weak typing can otherwise store integer
`1` or JSON `[1]`, which never matches the derived code `"mon"`.

The seed runner checks persisted weekday data before committing each module, including
private modules that insert directly. After migrations and before authentication
reconciliation, serving or scheduling, startup checks all weekday-bearing tables:
routine assignments, reminders and their assignments, briefing block masks, time
announcements and meal entries. Invalid JSON, non-array masks and noncanonical tokens
abort startup with the table, column and row identifier; no data is repaired or deleted.
Nullable masks retain their domain meaning, and empty arrays remain valid where defined.
Live restore applies the same check after migrations and before runtime activation;
a failure rolls back to the pre-restore snapshot, whose integrity is also checked
before traffic and jobs resume.
Tests intentionally bypass write validation to prove integer rejection and seed rollback.
The current baseline migration contains no weekday recurrence rows; future data
migrations must validate weekday writes before committing.

## Rationale

v1 holds two incompatible encodings: Routines uses `mon..sun` (Monday-first), while
Reminders uses ISO `1..7`, and server weekday derivation uses JS `getDay()`
(Sunday-first) then remaps — a documented off-by-one source. A string code carries no
implicit base/origin convention to forget and is invariant under locale, timezone,
and week-start. When the type cannot represent the wrong state, no runtime validation
is needed. Bonus: aligns with ICS/RRULE `MO,TU,…` for any future recurrence interop.

## Affected Specs

- [routines-chores](../../features/routines-chores.md), [reminders](../../features/reminders.md)

## Data / Setup Implications

No legacy rows imported (ADR-026). Reminders rule weekdays adopt the string-set form;
Routines already uses string codes. Shared `weekdayOf` utility lives with the
household-tz contract (ADR-005).

## Acceptance Criteria

- Given a weekday write, when it contains a value outside the 7-code enum, then it is
  rejected.
- Given a household-local date, when its weekday is derived, then `weekdayOf` returns
  the canonical code consistently across Routines and Reminders.
- Given a `weekStartDay` change, when matching runs, then which weekday a rule matches
  is unchanged (presentation-only).

## Open Questions

- None blocking. Full RRULE recurrence vocabulary (beyond weekday sets) remains future
  scope.

## Traceability

- Related prior: `ADR-020`
- Related: `ADR-005`, `ADR-006`
