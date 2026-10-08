# Feature: Reminders (briefing content source)

Behavior reference. The [owning contract](../architecture/contracts/reminders.md) defines invariants and extension limits.

> Phase 2.5 reference slice. Realizes the `reminders` domain contract's boundary
> guarantees (REMINDERS-AC-01..08, AC-10; REMINDERS-INV-01..09). Each Functional
> Requirement carries a `Contract: <ID>.` back-reference and the co-located
> `> Source <ID> — …` quote, per the Phase 2.4 traceability convention.

Reminders are parent-authored prompts that appear in a member/date **Daily Briefing**
when relevant. They are a briefing _content source_, not standalone alarms: evaluated
during briefing generation, never notifying in real time, scheduling no background jobs.

## User workflows

### User Story 1 — Author a scheduled reminder

A parent creates a weekday-recurring prompt ("coges el bus") and assigns it to specific
active members on each member's own weekdays (or to all active members on a shared set);
it appears in those members' briefings on their assigned weekdays.

### User Story 2 — Author a calendar-gated reminder

A parent creates a "whenever" prompt ("bring shin pads") that emits only on days a
member has a matching, explicitly-assigned calendar event — fixing the v1 local-only
bug by reading through `Calendar.getEvents`.

### User Story 3 — Diagnose a silent reminder

A parent asks "would this rule emit for (member, date), and if not, why?" and gets a
reason (no matching event / event not assigned / query miss), so a never-firing rule
is not mistaken for a broken feature.

### Edge Cases

- A `specific`-mode rule with zero assignments is rejected at write (use `active:false`).
- Editing or deleting a rule never rewrites an already-generated briefing snapshot.
- An archived member silently drops from emission and self-heals on reactivation.

## Requirements

### Functional Requirements

- **FR-001**: Given a reminder-rule write, when `kind` is `scheduled` it MUST carry `weekdays` (placed per `targeting_mode`: rule-level for `apply_to_all`, per-assignment for `specific`) and no query, and when `kind` is `calendar_gated` it MUST carry query/queryFields and no weekdays, then the opposite field combinations MUST be rejected at the boundary. Contract: REMINDERS-INV-01.

- **FR-002**: Given a `specific`-mode rule, when it is written with zero assignments, then the write MUST be rejected, and archived members MUST drop from active emission and self-heal on reactivation. Contract: REMINDERS-INV-02.

- **FR-003**: Given a `scheduled` rule, when its weekdays are written — at rule level for `apply_to_all` or per assignment for `specific` — then they MUST be the canonical `mon..sun` codes (ADR-020) and ISO `1..7` MUST be rejected, and `calendar_gated` rules have no weekday. Contract: REMINDERS-INV-03.

- **FR-004**: Given any rule date, when it is evaluated at the generation boundary, then it MUST be a strict calendar-valid `YYYY-MM-DD` value (ADR-006). Contract: REMINDERS-INV-04.

- **FR-005**: Given a `calendar_gated` rule, when its condition is evaluated, then events MUST be read only via `Calendar.getEvents` (never Calendar tables) passing `assignedTo: member`, and only events explicitly assigned to that member match. Contract: REMINDERS-INV-05.

- **FR-006**: Given briefing generation for a member/date, when the gate calls `getEvents`, then it MUST use the generation read-transaction context, and events MUST be fetched once per member/date and reused across that member's rules. Contract: REMINDERS-INV-06.

- **FR-007**: Given an already-generated briefing, when a rule is edited or deleted, then the existing snapshot MUST NOT regenerate, and reflecting the change requires the explicit regenerate path. Contract: REMINDERS-INV-07.

- **FR-008**: Given a rule write that also sets assignments, when it is persisted, then the rule and its assignments MUST be written atomically. Contract: REMINDERS-INV-08.

- **FR-009**: Given a rule-create request at the API write boundary, when `kind` is `scheduled` it MUST have weekdays (rule-level for `apply_to_all`, per-assignment for `specific`) and no query and when `kind` is `calendar_gated` it MUST have query/queryFields and no weekdays, then opposite combinations MUST be rejected by discriminated validation before any row is persisted (the create-time acceptance surface; the representational invariant is FR-001/INV-01). Contract: REMINDERS-AC-01.

- **FR-010**: Given a `calendar_gated` rule, when each day is evaluated for its eligible members (`apply_to_all` = all active; `specific` = its assigned members), then it MUST emit iff a matching event exists that is both assigned to the member and matches its query (via `getEvents`, external events included), and no weekday gates it. Contract: REMINDERS-AC-02.

- **FR-011**: Given a `scheduled` rule, when the date's weekday is in the applicable set (rule-level for `apply_to_all`, the member's own assignment set for `specific`), then it MUST emit regardless of calendar state. Contract: REMINDERS-AC-03.

- **FR-012**: Given a `specific`-mode rule, when it is written with zero assignments, then it MUST be rejected, and `active:false` is the non-emitting mechanism. Contract: REMINDERS-AC-04.

- **FR-013**: Given a `calendar_gated` evaluation, when matching events, then member identification MUST NOT be performed by the reminder and only explicit `assignedTo` assignments are honored. Contract: REMINDERS-AC-05.

- **FR-014**: Given an already-generated briefing, when a rule is edited, then the briefing MUST NOT be altered. Contract: REMINDERS-AC-06.

- **FR-015**: Given a rule write with assignments, when it is committed, then the rule and its assignments MUST persist atomically. Contract: REMINDERS-AC-07.

- **FR-016**: Given weekday or date writes, when they are validated, then they MUST follow ADR-020 (weekdays) and ADR-006 (dates). Contract: REMINDERS-AC-08.

- **FR-017**: Given a `calendar_gated` rule that did not emit, when the parent runs the dry-run/explain capability, then the non-emission MUST be explainable (no matching event / unassigned event / query miss). Contract: REMINDERS-AC-10.

- **FR-018**: Given a rule write, when its `targeting_mode` and weekday placement are validated, then a `specific`-mode rule MUST hold N assignments each binding one active member to its own weekday set (`scheduled`) or membership only (`calendar_gated`), and invalid combinations MUST be rejected at the boundary — a rule-level weekday set on a `specific` rule, per-assignment weekdays on an `apply_to_all` rule, or any weekdays on a `calendar_gated` assignment. Contract: REMINDERS-INV-09.

### Key Entities

- **Reminder rule**: a durable instruction that may emit one briefing item. A
  discriminated union on `kind` — `scheduled` (weekday-driven) or `calendar_gated`
  (event-driven). Attributes: text, `targeting_mode`, active flag, priority; plus
  `query`/`queryFields` (`calendar_gated`) or, for `scheduled` + `apply_to_all`, a
  rule-level `weekdays` set (`ADR-004`).
- **Reminder assignment** (`ADR-004`): a `specific`-mode link binding one active member to
  that member's own weekday set (`scheduled`), or member-membership only (`calendar_gated`).
  A reminder holds N assignments — one prompt may reach different members on different days.

## Success Criteria

- **SC-001**: 100% of rule writes with mismatched `kind`/field combinations are rejected.
- **SC-002**: A `calendar_gated` rule emits on exactly the days a matching, member-assigned
  event exists — including events that are external/non-local (the v1 bug is gone).
- **SC-003**: Editing or deleting a rule changes 0 already-generated briefings.

## Assumptions

- Calendar owns member identification, event merge, and text normalization; this spec
  consumes existing explicit `assignedTo` assignments via `Calendar.getEvents` (ADR-018).
- Fresh data store; no legacy reminder rows are imported (ADR-026).
- Atomicity and date/weekday derivation primitives are provided per ADR-043/ADR-005.
