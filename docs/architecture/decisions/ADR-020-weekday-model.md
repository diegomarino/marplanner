# ADR-020 Canonical Weekday Model

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Reconciliation (2026-10-08)

The canonical weekday model remains required. API paths validate tokens, but separate domain validators and the absence of the specified startup persisted-token check leave the shared-validation/integrity requirement below incomplete. Track it as implementation work; no direct-data corruption probe was executed during the coherence review.

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

**All write paths must use the shared validator (peer-review I2):** SQLite's weak typing
will silently store an integer `1` if a seed/fixture/migration/direct insert bypasses the
API validator; then read-time `weekdayOf` returns `"mon"` which never equals `1`, so the
assignment/rule **silently matches no day** (chores vanish, reminders stop emitting, no
error). Defenses: (a) every write path (API, seeds, fixtures, migrations) goes through the
shared weekday schema — make it impossible to write weekday data otherwise; (b) a startup
integrity check selects any non-string/out-of-enum weekday token and fails loudly;
(c) tests exercise the integer-rejection path.

## Rationale

v1 holds two incompatible encodings: Routines uses `mon..sun` (Monday-first), while
Reminders uses ISO `1..7`, and server weekday derivation uses JS `getDay()`
(Sunday-first) then remaps — a documented off-by-one source. A string code carries no
implicit base/origin convention to forget and is invariant under locale, timezone,
and week-start. When the type cannot represent the wrong state, no runtime validation
is needed. Bonus: aligns with ICS/RRULE `MO,TU,…` for any future recurrence interop.

## Affected Specs

- `../../05-routines-chores.md`, `../../07-reminders.md`

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
