# ADR-023 Members Admin Route Placement

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

Member profile management is an admin-protected feature in this system.

Creating, editing, archiving, restoring, or otherwise mutating family/member profiles must live behind the admin access boundary. A child-facing or ordinary kiosk route such as `/members` must not mount the member-management UI or allow profile mutation. `/members` must not exist in its old form.

If v2 later has a household-visible member surface, it must be designed as a new read-only experience scoped to the information needed by that experience. It must not be a relocated or lightly hidden copy of admin member management.

## Rationale

The old `/members` route mounting the same management component as `/admin/members` was accidental route exposure, not product intent. Editing family profiles changes core household identity and downstream eligibility, so it should require deliberate admin access.

The old `/members` route should therefore be treated as a route-design bug to remove, not as a v2 surface to preserve.

This decision defines the product boundary. The exact admin authorization mechanism remains owned by Auth & Sessions.

## Affected Specs

- `../../01-members.md`
- `../../12-auth-sessions.md`
- `../../15-kiosk-shell-navigation.md`

## Data / Setup Implications

Fresh deployment routing/navigation should place member management under admin-only surfaces.

No legacy route behavior should be copied as a v2 permission model. The old `/members` route is evidence of an ambiguity to avoid.

## Acceptance Criteria

- Given an unauthenticated or child-facing kiosk session, when the user navigates ordinary kiosk routes, then member profile create/edit/archive controls are unavailable.
- Given an admin-authorized session, when the user opens member management, then profile mutation actions are available according to Members rules.
- Given v2 route design, when ordinary kiosk routes are defined, then the old `/members` management route does not exist.
- Given a future `/members`-like household-visible route is deliberately introduced, when it renders, then it is a new read-only experience and cannot mutate member profiles.

## Open Questions

- Resolved by `ADR-013`/`ADR-058`: admin UI uses a client-only PIN gate; backend API credentials carry household authority, with no backend admin session.
- Whether a read-only members route is useful in this system remains a Kiosk/navigation design question.

## Traceability

- Conflicts: `CR-024-kiosk-admin-entry`
- Related prior: `ADR-023`
- Domain grill: `../domain-grills/members.md`
