# ADR-024 External Calendar Provider Vocabulary

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Decision

The canonical external-source provider set is **`google` | `microsoft` | `apple` |
`ics_generic`**. `provider` is a **display/UX hint only** (icon, label) and **never
affects parsing** — all feeds are ICS underneath. An unrecognized provider degrades to
`ics_generic`, never breaks ingest. The legacy `outlook` value maps to `microsoft`
(documented mapping only; no data migrated under ADR-026).

## Rationale

v1 is inconsistent: code uses `microsoft`, production validation also allows
`apple`/`outlook`, docs mention both. Because parsing is provider-agnostic (everything
is ICS), provider should be cosmetic and fail-soft: an unknown feed still imports as
`ics_generic`. This removes a class of "unsupported provider → broken source" failures
and reconciles the split vocabulary.

## Affected Specs

- `../../06-calendar.md`

## Data / Setup Implications

No legacy rows imported (ADR-026). If a future import/export ingests legacy sources,
`outlook` → `microsoft` and any unknown value → `ics_generic`.

## Acceptance Criteria

- Given an external source with an unrecognized provider, when synced, then it imports
  as `ics_generic` rather than failing.
- Given `provider`, when used, then it affects only display, never parse behavior.

## Open Questions

- None blocking.

## Traceability

- Related prior: `ADR-024`
- Domain grill: `../domain-grills/calendar-reminders-routines.md` (C1)
