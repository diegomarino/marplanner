# ADR-001 Member Role Model

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

In v2, `admin` is not a member role. `member.role` is limited to `parent` and `child`.

Admin authority is a non-person-scoped capability for performing admin tasks when the caller has the required credential or access state, such as knowing the PIN code or holding the API key. It must not be modeled as a household participant or tied to one specific member profile.

## Rationale

Production member-role validation recognizes only `parent` and `child`, and current member management UI only offers those roles. Current Auth & Sessions evidence models admin access through global PIN/session/API boundaries with nullable member links, not through member-profile login.

Separating household identity from admin authority keeps Members responsible for household participants and leaves credential/session policy to Auth & Sessions.

## Affected Specs

- `../../01-members.md`
- `../../12-auth-sessions.md`
- `../../15-kiosk-shell-navigation.md`

## Data / Setup Implications

No legacy member rows will be imported into this system under `ADR-026`.

Legacy evidence still supports the rule: current production member roles are `parent` / `child`, and legacy schema/API allowance for `admin` as `member.role` should not be copied into the v2 member model.

Existing nullable `pin_codes.member_id` and `sessions.member_id` links are evidence for Auth & Sessions. They do not imply that admin is a member role.

## Acceptance Criteria

- Given a v2 member create or update request, when `role = admin`, then the request is rejected as an invalid member role.
- Given an admin-capable caller, when admin tasks are authorized, then authorization is evaluated through Auth & Sessions/API-boundary rules rather than through `member.role`.
- Given v2 member data, when role validation runs, then `parent` and `child` are accepted and `admin` is rejected.

## Open Questions

- Which admin tasks require PIN-derived backend admin session, API key only, or another authorization boundary remains open under `ADR-007` and `ADR-013`.

## Traceability

- Conflicts: `CR-001-member-role-admin`
- Related prior: `ADR-001`
- Domain grill: `../domain-grills/members.md`
