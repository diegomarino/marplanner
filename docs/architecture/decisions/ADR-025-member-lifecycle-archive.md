# ADR-025 Member Lifecycle Archive

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

In v2, member lifecycle uses `active` and `archived` states instead of treating current `inactive` as a vague product state.

An active member participates in ordinary member lists, assignment pickers, and eligible generated flows according to role-specific rules. An archived member is invisible and inassignable in ordinary flows, but remains available for historical records and read-only reference resolution.

There is no separate `normal` lifecycle state; any prior use of "normal" in grill notes means `active`.

## Rationale

Current inactive behavior was primarily a convenience to avoid conflicts and avoid deleting people, not a deliberate product state. Making archive semantics explicit preserves history without letting removed household participants appear as active choices.

This also makes downstream rules clearer: assignment/recipient creation should use active members only, while historical records can still resolve archived member labels.

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

## Data / Setup Implications

No legacy member rows will be imported into this system under `ADR-026`.

Legacy inactive-member evidence supports the archive concept, but the product starts with fresh member data. Any archived member in this system is created by v2 lifecycle behavior, not imported from the old database.

Historical references to archived members must remain readable. New assignments, recipients, child-facing generated content, and ordinary pickers must not target archived members.

## Acceptance Criteria

- Given an active member, when ordinary member lists and assignment pickers load, then the member can appear according to the owning domain's role/eligibility rules.
- Given an archived member, when ordinary member lists and assignment pickers load, then the member is omitted.
- Given historical data referencing an archived member, when a history or audit view renders the record, then the member reference remains legible rather than disappearing or becoming assignable again.

## Traceability

- Conflicts: related to `CR-002-active-child-targets`
- Related prior: new improvement decision from Members grill
- Domain grill: `../domain-grills/members.md`
