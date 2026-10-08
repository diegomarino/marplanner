# ADR-002 Active Member Targets

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

In v2, new downstream assignment and recipient targets use active members by default.

Child-facing domains use active children only. This includes routines/chores and kiosk/dashboard child-work surfaces.

Daily Briefing is excluded from this child-only rule by `ADR-027`: its eligibility is per active member opt-in, independent of `parent` / `child` role.

Archived members are invisible and inassignable in ordinary flows. Historical records that already reference archived members remain readable as read-only history in the owning domain.

## Rationale

The old inactive behavior was mostly a technical convenience to preserve references without deleting people. `ADR-025` replaces that ambiguity with explicit active/archive semantics.

Using active members for new targets prevents archived household participants from reappearing in normal pickers. Using active children for child-facing domains preserves the current product intent that routines and child-work kiosk surfaces are for children, not parents. Daily Briefing uses its own opt-in model under `ADR-027`.

## Affected Specs

- `../../01-members.md`
- `../../05-routines-chores.md`
- `../../06-calendar.md`
- `../../07-reminders.md`
- `../../08-daily-messages.md`
- `../../10-network-devices.md`
- `../../11-daily-briefing.md`
- `../../13-printing-pipeline.md`
- `../../15-kiosk-shell-navigation.md`
- `ADR-025-member-lifecycle-archive.md`

## Data / Setup Implications

No legacy member rows or downstream target rows will be imported into this system under `ADR-026`.

Legacy inactive-member and historical-reference evidence supports the v2 archive concept and read-only-history behavior, but it is not a row preservation/import requirement.

New v2 writes must reject archived targets. Child-facing writes/generation must also reject active parent targets.

## Acceptance Criteria

- Given an archived member, when a new assignment or recipient picker loads, then the archived member is not selectable.
- Given an active parent, when a child-facing routine or kiosk child-work target is created, then the target is rejected or omitted according to the owning domain.
- Given historical data referencing an archived member, when the owning domain renders history, then the member label remains readable and read-only.
- Given new Calendar, Network Devices, Reminders, or Daily Messages targets, when a member is selected, then the member must be active.

## Open Questions

- Parent-linked legacy briefing migration is superseded by `ADR-026`; current opt-in eligibility is governed by `ADR-027`.
- Orphan-reference policy is resolved by `ADR-054`: archive-only members, strict writes and tolerant historical reads.

## Traceability

- Conflicts: `CR-002-active-child-targets`
- Related prior: `ADR-002`
- Domain grill: `../domain-grills/members.md`
