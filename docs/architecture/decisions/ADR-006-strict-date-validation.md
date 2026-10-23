# ADR-006 Strict Calendar-Valid Date Validation

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Decision

At every date boundary across Routines, Calendar, and Reminders (and any domain
consuming household dates), a date-only input must be **syntactically and
calendrically valid** `YYYY-MM-DD` — month `01`–`12`, day existing for that
month/year including leap years — or it is **rejected (400), never normalized**.

- Ban the v1 "slice first 10 chars" + `new Date(str)` pattern that normalizes
  impossible dates (`2026-02-31` → March 3rd). An impossible date is a client error,
  not a different valid date.
- A **single shared validator/schema** is reused per domain, not reimplemented.
- Date-only ranges use an **exclusive next-midnight** boundary in household
  timezone (ADR-005), fixing the v1 inclusive `23:59:59.999` end boundary. Timestamp
  filters are validated as valid instants.

## Rationale

Normalizing an impossible date converts a detectable client error into plausible
but wrong data that propagates silently — the worst kind of bug, because no
exception is ever raised. Strict rejection keeps the error where and when it
originates instead of surfacing layers later as "why is this chore on Tuesday?" or
an all-day event leaking to the wrong day. Cheap to enforce; high correctness value.

## Affected Specs

- [routines-chores](../../features/routines-chores.md), [calendar](../../features/calendar.md), [reminders](../../features/reminders.md)

## Data / Setup Implications

No legacy rows imported (ADR-026). The validator applies to all product-created date
inputs. Pairs with ADR-005 (household-tz) and ADR-020 (weekday derivation).

## Acceptance Criteria

- Given `2026-02-31` (or `2026-13-01`), when any date boundary receives it, then it
  is rejected, not normalized.
- Given a valid date-only range, when queried, then the end boundary is the
  exclusive next local midnight in household tz.
- Given a malformed date, when received, then no downstream weekday/period/streak is
  computed from a coerced value.

## Open Questions

- None blocking; per-domain boundaries enumerated in the cluster contracts.

## Traceability

- Related prior: `ADR-006`
- Domain grill: `domain-grills/calendar-reminders-routines.md` (historical record, not preserved in this repository) (S3)
- Related: `ADR-005`, `ADR-020`
