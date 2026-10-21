# ADR-001 Member Role Model

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

In v2, `admin` is not a member role. `member.role` is limited to `parent` and `child`.

Admin UI access uses the household PIN gate; backend authority uses API credentials (`ADR-013`/`ADR-058`). Neither is a member-profile login, and the PIN creates no backend admin session. It must not be modeled as a household participant or tied to one specific member profile.

## Rationale

Production member-role validation recognizes only `parent` and `child`, and current member management UI only offers those roles. Legacy Auth & Sessions evidence used PIN/session/API boundaries with nullable member links. The current model uses a client-only PIN gate and API credentials (`ADR-013`/`ADR-058`), not member-profile login.

Separating household identity from admin authority keeps Members responsible for household participants and leaves credential/session policy to Auth & Sessions.

## Affected Specs

- [members](../../features/members.md)
- [auth-sessions](../../features/auth-sessions.md)
- [kiosk-shell-navigation](../../features/kiosk-shell-navigation.md)

## Data / Setup Implications

No legacy member rows will be imported into this system under `ADR-026`.

Legacy evidence still supports the rule: current production member roles are `parent` / `child`, and legacy schema/API allowance for `admin` as `member.role` should not be copied into the v2 member model.

Existing nullable `pin_codes.member_id` and `sessions.member_id` links are evidence for Auth & Sessions. They do not imply that admin is a member role.

## Acceptance Criteria

- Given a v2 member create or update request, when `role = admin`, then the request is rejected as an invalid member role.
- Given an admin-capable caller, when admin tasks are authorized, then authorization is evaluated through Auth & Sessions/API-boundary rules rather than through `member.role`.
- Given v2 member data, when role validation runs, then `parent` and `child` are accepted and `admin` is rejected.

## Traceability

- Conflicts: `CR-001-member-role-admin`
- Related prior: `ADR-001`
- Domain grill: `domain-grills/members.md` (historical record, not preserved in this repository)
