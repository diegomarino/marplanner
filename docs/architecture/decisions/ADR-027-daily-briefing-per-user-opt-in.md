# ADR-027 Daily Briefing Per-User Opt-In

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

Daily Briefing eligibility should be per active member opt-in, independent of whether the member role is `child` or `parent`.

Active members can be eligible for Daily Briefing generation only when they have explicit Daily Briefing opt-in/configuration. Archived members remain ineligible. This supersedes the Daily Briefing-specific `active-child only` portion of `ADR-002`; other child-facing domains remain governed by `ADR-002`.

## Rationale

The old parent-linked Daily Briefing rows are no longer a migration constraint under `ADR-026`, but they are still useful evidence that parent/adult briefings are plausible product behavior. A per-user opt-in model is more direct than encoding age/role into the Daily Briefing domain.

Daily Briefing is better modeled as a personalized daily packet that may be useful for any active household participant, while child-only chores/routines can remain role-gated elsewhere.

## Affected Specs

- [members](../../features/members.md)
- [daily-briefing](../../features/daily-briefing.md)
- [printing](../../features/printing.md)
- [kiosk-shell-navigation](../../features/kiosk-shell-navigation.md)
- `ADR-002-active-member-targets.md`
- `ADR-026-no-legacy-database-migration.md`

## Data / Setup Implications

Fresh setup should not auto-generate Daily Briefings merely because a member is active. Eligibility requires an explicit per-member Daily Briefing opt-in/configuration.

Legacy parent-linked Daily Briefing rows remain evidence only; no rows are imported.

## Acceptance Criteria

- Given an active parent with Daily Briefing opt-in enabled, when scheduled or manual generation runs, then the parent is eligible for a briefing.
- Given an active child with Daily Briefing opt-in disabled, when scheduled generation runs, then no briefing is generated for that child.
- Given an archived member, when Daily Briefing generation runs, then the member is ineligible even if old configuration exists.
- Given a member role change between `parent` and `child`, when Daily Briefing opt-in remains unchanged, then eligibility follows opt-in and archive state rather than role.

## Open Questions

- Should new members default Daily Briefing opt-in to off for everyone, on for children, or be chosen during member creation?
- Does auto-print remain child-oriented, or does it follow Daily Briefing opt-in for any active member?

## Traceability

- Conflicts: narrows `CR-002-active-child-targets`; affects `CR-003-parent-briefing-history`
- Related: `ADR-002` (active targets), `ADR-009` (profile-only creation), `ADR-026` (fresh store).
- Domain grill: `domain-grills/members.md` (historical record, not preserved in this repository)
