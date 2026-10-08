# Members Domain Contract

Status: maintained contract
Depends on decisions: `ADR-001`, `ADR-002`, `ADR-009`, `ADR-012`, `ADR-023`, `ADR-025`, `ADR-026`, `ADR-027`, `ADR-040`, `ADR-054`

## Purpose

Members owns household participant identity in this system.

The domain defines who a household participant is, whether they are active or archived, what role they have, what profile data can be edited, and which member references other domains may use for new work.

Members does not own admin authorization, Daily Briefing opt-in/configuration, routine assignment internals, calendar assignment behavior, printing delivery, or kiosk route protection. Those domains consume Members rules through explicit eligibility checks.

## Vocabulary

| Term             | Meaning                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Member           | A household participant profile.                                                           |
| Active member    | A member who participates in ordinary member lists, pickers, and eligible feature flows.   |
| Archived member  | A member preserved for history/reference but invisible and inassignable in ordinary flows. |
| Parent           | A member role for an adult/parent household participant. It is not admin authority.        |
| Child            | A member role for a child household participant.                                           |
| Admin capability | A credential/access capability owned by Auth & Sessions, not a member role.                |
| Birth date       | Optional member profile data containing month/day and optionally year.                     |

## Invariants

- **MEMBERS-INV-01** `member.role` is limited to `parent` and `child`.
- **MEMBERS-INV-02** `admin` is never a member role and must not be tied to one member profile.
- **MEMBERS-INV-03** Admin authority belongs to Auth & Sessions / API-boundary rules.
- **MEMBERS-INV-04** Member lifecycle states are `active` and `archived`. **There is no hard delete of a
  member** (`ADR-054`): a member row is never physically removed, so no domain can ever hold a
  dangling member reference. The path away from `active` is `archived` (and restore, if
  exposed); a mis-created member is archived, not deleted.
- **MEMBERS-INV-05** Archived members are invisible and inassignable in ordinary flows.
- **MEMBERS-INV-06** **Cross-cutting member referential-integrity rule (`ADR-054`):** _strict on write,
  tolerant on read._ Any write that establishes or replaces a `memberId` — **INSERT or
  UPDATE** — must validate the target member is **active** (`ADR-002`); you cannot create or
  re-point a reference to an archived/non-existent member. A pre-existing reference to a
  now-archived member **renders read-only ("archived member"), never breaks** — and because
  the row is never deleted, read-tolerance only ever faces an existing archived row, never a
  missing row. Core member FKs use `ON DELETE RESTRICT` (backstop only; never exercised);
  plugin references are soft (no cross-namespace FK, `ADR-039`) and governed by the same
  archived-row read-tolerance.
- **MEMBERS-INV-07** New downstream assignment and recipient targets use active members by default.
- **MEMBERS-INV-08** Child-facing domains use active children only, except Daily Briefing.

<!-- MEMBERS-INV-09 retired: Daily Briefing owns the per-member opt-in eligibility rule (see the Coordinate-With-Daily-Briefing behavior); boundary-ledger.yaml. -->

- **MEMBERS-INV-10** Creating a member creates only the member profile and has no Daily Briefing side effects.
- **MEMBERS-INV-11** Member profile management is admin-protected.
- **MEMBERS-INV-12** `/members` must not exist in its old member-management form.
- **MEMBERS-INV-13** the product starts from a fresh data store and does not migrate current production database rows.
- **MEMBERS-INV-14** A member's on-screen identity colour is stored as a key from a closed curated palette, never as a free colour value; it is presentation identity only and does not alter monochrome printed output.

## Behaviors

### Create Member

Creating a member persists only the member profile.

The new member has role `parent` or `child`, lifecycle `active`, required display name, optional display/profile fields, and optional birth date. It does not create Daily Briefing settings, schedules, block settings, print state, routine assignments, or other downstream rows.

### Edit Member

Editing a member changes member-owned profile data only.

Editable profile data includes role, display name, visual/profile fields, lifecycle where permitted by admin flows, and optional birth date. Role changes do not by themselves create or delete Daily Briefing configuration.

### Archive Member

Archiving a member removes the member from ordinary lists and assignment pickers without making historical references illegible.

Archived members cannot be chosen for new downstream assignments or recipients. Domains that retain product-created history may resolve archived member labels read-only.

### Read Members

Ordinary active member reads return active members only. Child-facing reads narrow to active children where the consuming domain requires children.

Admin/member-management reads may include archived members when needed for management or restoration flows.

### Manage Birth Date

Birth date is optional. Forms and APIs must support read, set on create, update, and clear operations.

Month/day is sufficient. Year is optional and must not be invented. Birthday logic may use month/day; age-specific output may run only when year exists.

### Coordinate With Daily Briefing

Members does not decide Daily Briefing eligibility beyond providing active member identity and role/profile data.

Daily Briefing owns per-member opt-in and configuration. Any active member can become eligible through Daily Briefing opt-in, independent of role. Archived members remain ineligible.

## Interfaces

Conceptual member commands:

- Create member profile.
- Update member profile.
- Archive member.
- Restore archived member, if v2 exposes restoration.
- Set or clear member birth date.

Conceptual member queries:

- List active members.
- List active children.
- Read member profile for admin management.
- Resolve member label/profile snapshot for this system-created history.

## Events

(ADR-040; in-memory, at-most-once, post-commit, immutable payload.)

- **Emits:** member lifecycle notifications — `members.created`, `members.updated`,
  `members.archived`, `members.restored` (member id + minimal label snapshot), fired
  post-commit. These are **notifications, not state**, and **do not authorize** any
  consumer to create hidden side effects during member creation/update.
- **Subscribes:** none.

**Not load-bearing for this system correctness.** Current consumers (Routines/Reminders targeting,
Daily Briefing eligibility) enforce active/archived state by **read-time checks
(read-tolerance)** — e.g. a reminder self-heals on member reactivation by re-reading
active state, not by handling an event (`ADR-002`, Reminders R2). The lifecycle events
are an available signal for future/optional proactive reactions; dropping one (the bus is
at-most-once) never corrupts state because the authoritative check is at read time.

## Data / Setup Contract

the product does not import legacy member rows, Daily Briefing rows, routine assignments, sessions, or other current production database data.

Legacy data remains evidence only:

- Production role evidence supports `parent` / `child` as the member role model.
- Old inactive-member behavior supports explicit `active` / `archived` lifecycle semantics.
- Old parent-linked Daily Briefing rows support the per-active-member opt-in product model, not a migration rule.
- Old orphaned routine assignments are validation-risk evidence, not rows to repair.
- Old `/members` route behavior is a route-design bug to avoid, not a v2 surface to preserve.

Fresh setup starts with clean member data created through v2 flows.

## Acceptance Criteria

- **MEMBERS-AC-01** Given a member create/update request with `role = admin`, when validation runs, then the request is rejected.
- **MEMBERS-AC-02** Given a member create request, when it succeeds, then no Daily Briefing configuration is created by that operation.
- **MEMBERS-AC-03** Given an archived member, when ordinary member pickers load, then the archived member is omitted.
- **MEMBERS-AC-04** Given product-created history referencing an archived member, when a history view renders, then the member reference remains legible and read-only.
- **MEMBERS-AC-07** Given birth date with month/day only, when the profile is saved, then birthday matching can work without exact age.

<!-- MEMBERS-AC-05, MEMBERS-AC-06 moved to daily-briefing.md (Daily Briefing owns eligibility outcomes); see boundary-ledger.yaml. -->

- **MEMBERS-AC-08** Given a member-management route, when it is accessed outside admin protection, then profile mutation controls are unavailable.
- **MEMBERS-AC-09** Given v2 route design, when ordinary kiosk routes are defined, then old `/members` member management is absent.
- **MEMBERS-AC-10** Given the curated palette contains sixteen identity colours, when a member colour is assigned, then an unused active-member colour is preferred; when all sixteen are already in use, reuse remains allowed rather than rejecting the member.

## Open Decisions

- Exact admin credential/session enforcement belongs to Auth & Sessions.
- Broader multi-step atomicity remains open outside the Members-specific create rule.
- Daily Briefing still owns opt-in defaults, block settings, schedules, and generation semantics.
- Routines & Chores owns exact routine assignment eligibility and replacement atomicity, constrained by Members active/archived rules.
- Kiosk Shell & Navigation owns whether any newly designed read-only member surface exists outside admin.
