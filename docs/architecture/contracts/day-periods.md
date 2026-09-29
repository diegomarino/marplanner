# Day Periods Domain Contract

Status: maintained contract
Depends on decisions: `ADR-010`, `ADR-011`, `ADR-005`, `ADR-029`, `ADR-006`, `ADR-040`

## Purpose

A fixed, household-wide vocabulary of four ordered parts of the day
(`morning`/`afternoon`/`evening`/`night`) that Routines & Chores use to group and
order work consistently everywhere. Core domain (ADR-029).

## Vocabulary

- **Day period** — a system-defined part of the day, identified by a stable ID/slug,
  an i18n label key, and an editable `start` time (local `HH:MM`).
- **Start** — the only stored boundary; a period's **end is derived** = the next
  period's start.
- **Active period** — the period currently in effect by household-tz wall-clock.

## Invariants

1. **DAY-PERIODS-INV-01** **Fixed set of four** (ADR-010): `morning`, `afternoon`, `evening`, `night`. No
   add/delete/merge/reorder. Household-wide, not member-specific.
2. **DAY-PERIODS-INV-02** **Circular tiling, no stored end times:** periods partition a 24h cycle by their
   `start` points; `night` owns the midnight crossing. Gaps/overlaps are
   unrepresentable.
3. **DAY-PERIODS-INV-03** **Start times editable**, strictly ordered and unique (each strictly between its
   neighbours), validated at write.
4. **DAY-PERIODS-INV-04** **Labels are i18n translation keys**, not user-editable text.
5. **DAY-PERIODS-INV-05** **Active-period selection** = latest `start <= now` in household tz (ADR-005); if
   none, the last (wrapping `night`) period. Wrap is UI-only; the household date stays
   the ADR-005 calendar date (midnight boundary).
6. **DAY-PERIODS-INV-06** A routine must reference an existing period ID; chores inherit grouping via routine
   (Routines owns this). Empty periods still render as stable anchors.

## Behaviors

- **List periods:** return the four periods ordered by start; reachable on the
  API-key surface for kiosk/admin cold start (no PIN required to read vocabulary).
- **Edit start time** (parent/admin): validated for strict order/uniqueness; moves one
  shared boundary (the previous period's derived end follows automatically).
- **Seed/bootstrap:** insert the four periods with stable IDs, i18n label keys, and
  the ADR-011 default start times.

## Interfaces

- Inbound: list periods; edit period start time (parent/admin). No create/delete.

## Events

(ADR-040.) Day Periods emits and subscribes to **no** domain events — it is pure
household vocabulary. Consumers (Routines daily-chores aggregate, kiosk board) read the
catalog directly via its read interface.

## Data / Setup Contract

Owned: `day_periods` (four rows). No legacy import (ADR-026); existing routine→period
references map by stable ID. Labels are i18n keys, not migrated text.

## Acceptance Criteria

- **DAY-PERIODS-AC-01** The catalog returns exactly four ordered periods and exposes no add/delete.
- **DAY-PERIODS-AC-02** A start-time edit breaking strict order/uniqueness is rejected.
- **DAY-PERIODS-AC-03** At a time before the first start, the active period is the wrapping `night`.
- **DAY-PERIODS-AC-04** Every instant maps to exactly one period (no gap/overlap); each period's end equals
  the next period's start.
- **DAY-PERIODS-AC-05** Empty periods render as stable anchors in period-grouped views.

## Open Decisions

- Future full configurability (add/delete periods) — additive, only if real demand
  appears (ADR-010).
- Localization of label keys is owned by i18n / Localization.
