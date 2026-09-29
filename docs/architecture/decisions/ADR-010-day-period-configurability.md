# ADR-010 Day Period Configurability and Day Model

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

Day periods are a **fixed set of four** system-vocabulary periods — `morning`,
`afternoon`, `evening`, `night` (`night` newly added). The **set** is not
user-mutable (no add / delete / merge / reorder). Their **start times are editable**;
their **labels are i18n translation keys** (not user-editable text).

**Circular day model (no stored end times):** periods tile a 24-hour cycle. A period
is defined only by its `start` (local `HH:MM`); its end is **derived** as the next
period's start. No end time is stored, so gaps and overlaps are unrepresentable. The
last period (`night`) **owns the midnight crossing** (wraps past `00:00`), so no
`00:00` anchor is required.

**Constraints on start-time edits:** start times are strictly ordered and unique
(each strictly between its neighbours), validated at the write boundary.

**Active-period selection:** the latest `start <= now` in household timezone
(ADR-005); if none (now is before the first start), the **last** period (the wrapping
`night`). This corrects the v1 fallback that wrongly selected the first period. The
wrap is a UI convenience only and does not redefine the household date (still the
ADR-005 calendar date with a midnight boundary).

## Rationale

v1 has exactly three seeded periods, no edit UI, and edit schemas **marked as dead
code pending removal** — empirical evidence that full configurability was built and
abandoned. A fixed set captures 100% of the observed value (stable order, predictable
grouping) with 0% of the unused cost (delete-with-routines cascade, history
reinterpretation). Adding `night` is purely additive (routines reference IDs; history
is keyed by chore/member/date). Modeling the day as a closed cycle defined by cut
points makes invalid partitions (gaps/overlaps) impossible by construction, mirroring
ADR-020's "choose a representation where the wrong state can't be written."

## Affected Specs

- `../../02-day-periods.md`, `../../05-routines-chores.md`

## Data / Setup Implications

Four periods are seeded with stable IDs/slugs and i18n label keys; start times are
editable household settings. No legacy import (ADR-026). Existing routines reference
period IDs unchanged; `night` is available as a new target.

## Acceptance Criteria

- Given the period catalog, when read, then it returns exactly four ordered periods
  and exposes no add/delete/merge/reorder operation.
- Given a start-time edit, when it would break strict ordering or uniqueness, then it
  is rejected.
- Given a time before the first period's start, when the active period is selected,
  then the last (wrapping `night`) period is chosen.
- Given no stored end times, when periods are read, then each period's end equals the
  next period's start with no gap/overlap.

## Open Questions

- None blocking. Future full configurability (add/delete) remains an additive option
  if real demand appears.

## Traceability

- Pre-v2: `ADR-010`
- Domain grill: `../domain-grills/day-periods.md`
- Related: `ADR-011` (default start times), `ADR-005`, `ADR-029`, `ADR-020`
