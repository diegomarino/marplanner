# Feature: Day Periods (household time-of-day vocabulary)

Behavior reference. The [owning contract](../architecture/contracts/day-periods.md) defines invariants and extension limits.

Day Periods is a fixed, household-wide vocabulary of four ordered parts of the day
(`morning`/`afternoon`/`evening`/`night`) that Routines & Chores read to group and
order work consistently everywhere. It is a core domain (ADR-029): pure household
vocabulary that emits and subscribes to no domain events — consumers read its catalog
directly. The only stored boundary per period is an editable `start` time; every
period's `end` is derived as the next period's start.

## User workflows

### User Story 1 — Read the period catalog

A kiosk or admin surface lists the four ordered periods at cold start (no PIN required
to read vocabulary), getting exactly four periods in start order with no add/delete
affordance.

### User Story 2 — Edit a boundary start time

A parent/admin moves `afternoon`'s start earlier; the edit is validated for strict
order and uniqueness, moves one shared boundary, and the previous period's derived end
follows automatically. An edit that breaks strict order or uniqueness is rejected.

### User Story 3 — Resolve the active period

The board asks "which period is active now?" in the household timezone and gets the
latest period whose `start <= now`; before the first start of the day it wraps to
`night`, while the household date stays the ADR-005 calendar date.

### Edge Cases

- An instant before the first period's start resolves to the wrapping `night`.
- An empty period (no routines grouped under it) still renders as a stable anchor.
- No request can add, delete, merge, or reorder the four periods.

## Requirements

### Functional Requirements

- **FR-001**: Given the day-periods catalog, when it is read, then it MUST expose exactly the four system-defined periods `morning`, `afternoon`, `evening`, and `night` household-wide, and no add, delete, merge, or reorder operation MUST be exposed. Contract: DAY-PERIODS-INV-01.

- **FR-002**: Given the four periods' `start` points, when the day is partitioned, then they MUST tile a single 24h cycle with no stored end times and with `night` owning the midnight crossing, and gaps or overlaps MUST be unrepresentable. Contract: DAY-PERIODS-INV-02.

- **FR-003**: Given an editable period `start` time, when it is written, then it MUST be validated as strictly ordered and unique (each start strictly between its neighbours), and any write violating that order MUST be rejected. Contract: DAY-PERIODS-INV-03.

- **FR-004**: Given a period's display label, when it is presented, then it MUST resolve from an i18n translation key, and it MUST NOT be user-editable free text. Contract: DAY-PERIODS-INV-04.

- **FR-005**: Given the household wall-clock, when the active period is selected, then it MUST be the latest period whose `start <= now` in household tz (else the last, wrapping `night`), and the wrap MUST stay UI-only so the household date remains the ADR-005 calendar date. Contract: DAY-PERIODS-INV-05.

- **FR-006**: Given a routine's period grouping, when it is resolved, then the routine MUST reference an existing period ID (chores inherit grouping via routine, owned by Routines), and an empty period MUST still render as a stable anchor. Contract: DAY-PERIODS-INV-06.

- **FR-007**: Given the catalog read interface, when it is queried, then it MUST return exactly four ordered periods, and it MUST expose no add or delete affordance. Contract: DAY-PERIODS-AC-01.

- **FR-008**: Given a start-time edit, when it would break strict order or uniqueness, then the edit MUST be rejected at the write boundary. Contract: DAY-PERIODS-AC-02.

- **FR-009**: Given an instant before the first period's start, when the active period is resolved, then it MUST be the wrapping `night` period. Contract: DAY-PERIODS-AC-03.

- **FR-010**: Given any instant in the cycle, when it is mapped to a period, then it MUST map to exactly one period with no gap or overlap, and each period's end MUST equal the next period's start. Contract: DAY-PERIODS-AC-04.

- **FR-011**: Given a period with no grouped work, when a period-grouped view is rendered, then the empty period MUST still appear as a stable anchor. Contract: DAY-PERIODS-AC-05.

### Key Entities

- **Day period**: a system-defined part of the day identified by a stable ID/slug, an
  i18n label key, and an editable `start` time (local `HH:MM`). One of exactly four:
  `morning`, `afternoon`, `evening`, `night`.
- **Start boundary**: the only stored boundary on a period; a period's `end` is derived
  as the next period's start (the shared boundary moved by an edit).

## Success Criteria

- **SC-001**: The catalog always returns exactly four periods in start order and exposes
  no add/delete/merge/reorder operation.
- **SC-002**: Every wall-clock instant maps to exactly one period with no gaps or
  overlaps; before the first start the active period wraps to `night`.
- **SC-003**: 100% of start-time edits that break strict order or uniqueness are rejected
  at the write boundary.

## Assumptions

- Default start times and seeded stable IDs/i18n label keys are provided per ADR-011;
  Day Periods seeds four rows with no legacy import (ADR-026).
- Routines owns chore→period grouping and routine→period references; Day Periods only
  guarantees existing period IDs are referenceable and renders empty periods as anchors.
- Localization of label keys is owned by i18n / Localization; Day Periods stores only
  the keys.
- The household timezone and ADR-005 calendar-date derivation are provided as platform
  primitives; active-period selection consumes them.
