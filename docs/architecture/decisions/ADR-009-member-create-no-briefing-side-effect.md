# ADR-009 Member Create Has No Daily Briefing Side Effect

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

Creating a member in v2 creates only the member profile. It must not create, seed, or repair Daily Briefing settings as a side effect.

Members and Daily Briefing are independent domains. Daily Briefing owns its own per-member opt-in and configuration lifecycle, and those settings are created or updated only through Daily Briefing behavior.

## Rationale

The old implementation performed member creation and Daily Briefing default-setting creation as separate writes. That could leave partial state if the member write succeeded and the briefing-setting write failed.

The v2 product model now treats Daily Briefing as explicit per-active-member opt-in. That makes cross-domain provisioning from member creation unnecessary and misleading.

## Affected Specs

- `../../01-members.md`
- `../../11-daily-briefing.md`
- `ADR-027-daily-briefing-per-user-opt-in.md`

## Data / Setup Implications

Fresh v2 member setup starts with a member profile only. A newly created member has no Daily Briefing eligibility until Daily Briefing opt-in/configuration is explicitly set.

No legacy member or Daily Briefing rows are imported under `ADR-026`.

## Acceptance Criteria

- Given a member create request, when it succeeds, then the member profile exists and no Daily Briefing settings are created by that operation.
- Given a member create request, when Daily Briefing storage or configuration logic is unavailable, then member creation is unaffected.
- Given a member needs a Daily Briefing, when opt-in/configuration is set through Daily Briefing behavior, then Daily Briefing owns the resulting settings.

## Open Questions

- Broader multi-step atomicity rules for other domains remain open under the overall atomic update contract.
- Daily Briefing still needs to decide default opt-in UX and configuration defaults.

## Traceability

- Conflicts: `CR-009-multistep-atomicity`
- Pre-v2: `ADR-009`
- Domain grill: `../domain-grills/members.md`
