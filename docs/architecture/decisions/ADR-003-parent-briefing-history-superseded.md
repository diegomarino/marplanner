# ADR-003 Parent-Linked Daily Briefing History

Status: superseded
Owner: product + architecture
Decision date: 2026-06-27

## Decision

The old question "how should v2 migrate parent-linked Daily Briefing rows/settings?" is superseded.

v2 will not migrate legacy database rows under `ADR-026`. Daily Briefing eligibility is now defined by `ADR-027`: any active member can be eligible when explicitly opted in, independent of `parent` / `child` role.

## Rationale

The legacy parent-linked `daily_briefing` and `member_block_settings` rows no longer require a preservation, quarantine, or transformation rule because the product starts with a fresh data store.

Those rows remain useful evidence that adult/parent briefings are plausible product behavior. That product question is resolved by the per-active-member opt-in model in `ADR-027`.

## Affected Specs

- `../../01-members.md`
- `../../11-daily-briefing.md`
- `../../16-background-jobs-scheduler.md`
- `ADR-026-no-legacy-database-migration.md`
- `ADR-027-daily-briefing-per-user-opt-in.md`

## Data / Setup Implications

No parent-linked legacy Daily Briefing rows or settings are imported into this system.

Fresh deployment Daily Briefing setup should expose opt-in/configuration per active member. Role alone must not grant or deny briefing eligibility.

## Acceptance Criteria

- Given legacy parent-linked Daily Briefing evidence, when v2 data setup is designed, then no legacy row import path is required.
- Given an active parent with Daily Briefing opt-in enabled, when generation runs, then the parent can receive a briefing.
- Given an active child with Daily Briefing opt-in disabled, when generation runs, then no briefing is generated for that child.

## Open Questions

- Resolved by `ADR-009`/`ADR-027`: creating a member creates no briefing configuration or eligibility; opt-in is owned by Daily Briefing.
- Producer print triggers are owned by Daily Briefing and Printing; this superseded migration record defines no role-specific printing rule.

## Traceability

- Conflicts: `CR-003-parent-briefing-history`
- Related prior: `ADR-003`
- Superseded by: `ADR-026`, `ADR-027`
- Domain grill: `../domain-grills/members.md`
