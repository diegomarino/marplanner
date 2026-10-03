# Feature: Members (household participant identity)

Behavior reference. The [owning contract](../architecture/contracts/members.md) defines invariants and extension limits.

Members owns **household participant identity** in this system: who a participant is,
whether they are `active` or `archived`, their role (`parent`/`child`), and what
profile data may be edited. It is the **referential root** other domains point at,
governed by the cross-cutting rule of ADR-054 — **strict on write, tolerant on
read**: a write may only establish a `memberId` to an active member, while a
pre-existing reference to a now-archived member renders read-only and never
breaks. Members are **never hard-deleted**, so no domain can ever hold a dangling
member reference. Members does not own admin authorization, Daily Briefing
opt-in/configuration, routine assignment internals, or kiosk route protection;
those domains consume Members rules through explicit eligibility checks.

## User workflows

### User Story 1 — Create and edit a member profile

An admin creates a `parent` or `child` member with a required display name and
optional profile fields and birth date. Creating the member persists only the
member profile — no Daily Briefing settings, schedules, or downstream rows. The
admin later edits role, display name, or birth date without those edits creating
or deleting any downstream configuration.

### User Story 2 — Archive a member without breaking history

An admin archives a mis-created or departed member. The archived member vanishes
from ordinary lists and assignment pickers and cannot be chosen for new
assignments or recipients, yet product-created history that already references them
still renders the member label read-only ("archived member") rather than breaking.

### User Story 3 — Admin-protected member management

Member profile mutation is reachable only under admin protection; the old
`/members` member-management surface does not exist in this system's ordinary kiosk routes,
so member management cannot be reached or mutated outside admin protection.

### Edge Cases

- A create/update request with `role = admin` is rejected at validation — `admin`
  is never a member role.
- A write that points a `memberId` at an archived or non-existent member is
  rejected; only active members are valid write targets.
- A birth date may carry month/day with no year; age-specific output runs only
  when a year exists, but birthday matching still works on month/day alone.
- the product starts from a fresh data store — no legacy member rows are migrated.

## Requirements

### Functional Requirements

- **FR-001**: Given a member write, when `member.role` is set, then it MUST be one of `parent` or `child` and any other value MUST be rejected. _(Realizes: MEMBERS-INV-01)_

- **FR-002**: Given a member profile, when a role is assigned, then `admin` MUST NOT be a member role and MUST NOT be tied to one member profile. _(Realizes: MEMBERS-INV-02)_

- **FR-003**: Given an admin-authority decision, when access is evaluated, then admin authority MUST be resolved by Auth & Sessions / API-boundary rules and never by a member role. _(Realizes: MEMBERS-INV-03)_

- **FR-004**: Given a member that must leave `active`, when it is removed from ordinary use, then its lifecycle MUST become `archived` (or restored, where exposed) and the row MUST NEVER be hard-deleted, so no domain can hold a dangling member reference. _(Realizes: MEMBERS-INV-04)_

- **FR-005**: Given an archived member, when ordinary flows (lists, pickers, assignment) run, then that member MUST be invisible and inassignable. _(Realizes: MEMBERS-INV-05)_

- **FR-006**: Given a write that establishes or replaces a `memberId` (INSERT or UPDATE), when it is validated, then the target member MUST be active and a reference to an archived/non-existent member MUST be rejected, while a pre-existing reference to a now-archived member MUST render read-only and never break. _(Realizes: MEMBERS-INV-06)_

- **FR-007**: Given a new downstream assignment or recipient target, when it is selected by default, then it MUST be drawn from active members. _(Realizes: MEMBERS-INV-07)_

- **FR-008**: Given a child-facing domain (other than Daily Briefing), when it reads children, then it MUST use active children only. _(Realizes: MEMBERS-INV-08)_

- **FR-009**: Given a member create operation, when it succeeds, then it MUST create only the member profile and have no Daily Briefing side effects. _(Realizes: MEMBERS-INV-10)_

- **FR-010**: Given a member profile management operation, when it is invoked, then it MUST be admin-protected. _(Realizes: MEMBERS-INV-11)_

- **FR-011**: Given v2 route design, when routes are defined, then `/members` MUST NOT exist in its old member-management form. _(Realizes: MEMBERS-INV-12)_

- **FR-012**: Given v2 startup, when the data store is initialized, then it MUST start fresh and MUST NOT migrate current production database rows. _(Realizes: MEMBERS-INV-13)_

- **FR-013**: Given a member create/update request with `role = admin`, when validation runs, then the request MUST be rejected. _(Realizes: MEMBERS-AC-01)_

- **FR-014**: Given a member create request, when it succeeds, then no Daily Briefing configuration MUST be created by that operation. _(Realizes: MEMBERS-AC-02)_

- **FR-015**: Given an archived member, when ordinary member pickers load, then the archived member MUST be omitted. _(Realizes: MEMBERS-AC-03)_

- **FR-016**: Given product-created history referencing an archived member, when a history view renders, then the member reference MUST remain legible and read-only. _(Realizes: MEMBERS-AC-04)_

- **FR-017**: Given a birth date with month/day only, when the profile is saved, then birthday matching MUST be able to work without exact age. _(Realizes: MEMBERS-AC-07)_

- **FR-018**: Given a member-management route, when it is accessed outside admin protection, then profile mutation controls MUST be unavailable. _(Realizes: MEMBERS-AC-08)_

- **FR-019**: Given v2 route design, when ordinary kiosk routes are defined, then old `/members` member management MUST be absent. _(Realizes: MEMBERS-AC-09)_

- **FR-020**: Given a member's on-screen identity colour, when it is stored or displayed, then it MUST be represented by a key from a closed curated palette and MUST NOT accept a free colour value; it MUST remain presentation identity only and MUST NOT alter monochrome printed output. _(Realizes: MEMBERS-INV-14)_

- **FR-021**: Given the curated palette contains sixteen identity colours, when a member colour is assigned, then the system MUST prefer a colour unused by another active member, and when all sixteen are already in use it MUST allow reuse rather than reject the member. _(Realizes: MEMBERS-AC-10)_

### Key Entities

- **Member**: a household participant profile and the referential root other
  domains point at. Attributes: `role` (`parent` | `child`), `lifecycle`
  (`active` | `archived`), required display name, optional display/profile
  fields, and optional birth date (month/day, optional year). Never hard-deleted.
- **Birth date**: optional member profile data — month/day always, year optional
  and never invented; supports read, set-on-create, update, and clear.

## Success Criteria

- **SC-001**: 100% of member writes with `role = admin` (create or update) are
  rejected at validation; `admin` is never persisted as a member role.
- **SC-002**: 100% of writes establishing/re-pointing a `memberId` to an archived
  or non-existent member are rejected, while 100% of pre-existing references to a
  now-archived member still render read-only — zero dangling references.
- **SC-003**: A member create produces exactly one member profile and zero Daily
  Briefing or other downstream rows.
- **SC-004**: Ordinary kiosk routes expose no old `/members` member management and
  no profile mutation outside admin protection.

## Assumptions

- Auth & Sessions owns the exact admin credential/session enforcement that backs
  admin protection (ADR-027); this spec consumes it as an admin gate.
- Daily Briefing owns per-member opt-in, configuration, and eligibility outcomes
  (MEMBERS-AC-05/AC-06 moved there); Members only provides active member identity
  and role/profile data.
- Fresh data store; no legacy member rows, Daily Briefing rows, or routine
  assignments are imported (ADR-026, ADR-054).
- Member FK backstop is `ON DELETE RESTRICT` and is never exercised because rows
  are never deleted; plugin references are soft (ADR-039).
