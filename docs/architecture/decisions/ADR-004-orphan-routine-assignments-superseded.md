# ADR-004 Orphaned Routine Assignments

Status: superseded
Owner: product + architecture
Decision date: 2026-06-27

## Decision

The old question "how should v2 migrate routine assignments that point at missing members?" is superseded.

v2 will not migrate legacy database rows under `ADR-026`. The v2 product rule is that new routine assignments must validate member existence and eligibility before persistence.

## Rationale

The legacy orphaned assignment rows are evidence that the old system allowed or accumulated broken references. Since those rows are not imported, v2 does not need a delete/archive/repair/quarantine policy for them.

The useful design lesson is validation: routine assignment writes should not create references to missing, archived, or otherwise ineligible members.

## Affected Specs

- `../../01-members.md`
- `../../05-routines-chores.md`
- `ADR-002-active-member-targets.md`
- `ADR-026-no-legacy-database-migration.md`

## Data / Setup Implications

No orphaned legacy routine assignment rows are imported into v2.

Fresh v2 setup and writes must ensure routine assignment targets are valid v2 members and satisfy the owning domain's eligibility rules.

## Acceptance Criteria

- Given a routine assignment request with a missing member ID, when the write is attempted, then the request is rejected and no partial assignment state is persisted.
- Given a routine assignment request with an archived member, when the write is attempted, then the request is rejected.
- Given a routine assignment request with an active but ineligible member according to Routines rules, when the write is attempted, then the request is rejected.

## Open Questions

- ~~Exact Routines eligibility~~ — resolved by the Calendar/Reminders/Routines cluster grill (Routines owns eligibility; `ADR-002` active-targeting).
- ~~Atomicity of replacing assignment sets~~ — resolved by `ADR-043` (Class 1 atomic txn).
- ~~In-v2 runtime orphan handling~~ — **closed by `ADR-054`**: v2 is archive-only (no member hard delete), so dangling references are unrepresentable; the universal rule is strict-on-write (INSERT/UPDATE → active member) / tolerant-on-read (archived rendered read-only).

## Traceability

- Conflicts: `CR-004-orphan-routine-assignments`
- Pre-v2: `ADR-004`
- Superseded by: `ADR-026` (migration thread) + `ADR-054` (in-v2 runtime thread); v2 validation rule covered by `ADR-002`
- Domain grill: `../domain-grills/members.md`
