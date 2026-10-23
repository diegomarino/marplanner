# ADR-011 Day Period Default Start Times

Status: accepted
Owner: product
Decision date: 2026-06-29

## Decision

The seeded default start times for the four periods (ADR-010) are:

| Period      | Default start |
| ----------- | ------------- |
| `morning`   | `05:00`       |
| `afternoon` | `12:00`       |
| `evening`   | `18:00`       |
| `night`     | `21:00`       |

`night` wraps `21:00 → 05:00` across midnight. These are **defaults and editable**
(ADR-010), subject to the strict-ordering/uniqueness constraint.

## Rationale

Supersedes both the prod-seed values (`00:00 / 12:00 / 18:30`, which forced a
midnight-anchored first period) and the Storybook mock values (`06:00 / 12:00 /
18:00`). With `night` owning the midnight crossing, `morning` no longer needs to start
at `00:00`; `05:00` reflects a realistic household wake window, and `21:00` gives
`night` a clean bedtime band.

## Affected Specs

- [day-periods](../../features/day-periods.md)

## Data / Setup Implications

Seed writes these four start times. No legacy import (ADR-026). Because start times are
editable, these are initial values only.

## Acceptance Criteria

- Given a fresh deployment setup, when seeded, then the four periods carry the start times
  above in strict ascending order.

## Open Questions

- None.

## Traceability

- Related prior: `ADR-011`
- Domain grill: `domain-grills/day-periods.md` (historical record, not preserved in this repository)
- Related: `ADR-010`, `ADR-005`
