# ADR-064 Reminder Assignments and Product Surface

Status: accepted
Owner: product + architecture
Decision date: 2026-08-13

## Context

One informational reminder may apply to different members on different weekdays.
Rules are non-completable content read by Daily Briefing, rather than realtime
notifications or a separate household dashboard.

## Decision

Use a discriminated targeting model for both scheduled and calendar-gated rules:

- `apply_to_all`: target every active member. Scheduled rules store the weekdays
  on the rule and have no assignment rows.
- `specific`: target explicitly assigned active members. Scheduled assignments
  carry each member's own weekday set; the rule carries none.
- Calendar-gated rules use Calendar.getEvents at read time. The calendar is their
  schedule; neither rule nor member assignment accepts a weekday gate. Specific
  assignments represent membership only.
- Reject invalid targeting/kind/weekday combinations at the API boundary. Reject
  writes with zero specific assignments; persist rule and assignments atomically.
- Scheduled emission checks the rule weekdays for apply_to_all and the selected
  member's assignment weekdays for specific. Calendar-gated emission applies the
  query to that member's calendar events after checking targeting eligibility.

`admin/reminders` owns rule authoring, assignment matrices and calendar-gated
dry-run/explain. It uses the generic PIN-gated admin route. There is no reminder
dashboard widget or user-facing route; Daily Briefing owns family-facing rendering.
Both rule kinds and their boundary tests are implemented.

Storage uses rule-level weekdays for scheduled apply_to_all and assignment rows
for specific. Calendar-gated assignments share the assignment table with an empty
stored weekday array; that storage detail does not admit weekday fields at the API.

## Rationale

Per-member assignments express household use without duplicating rule text or
adding named-group entities. They reuse the Routines assignment shape while
retaining the distinct scheduled/calendar-gated schedule semantics. Pull-time
evaluation avoids a second notification pipeline and preserves briefing snapshots.

## Acceptance Criteria

- Two members assigned to one scheduled rule can have different weekdays.
- Scheduled apply_to_all evaluates the rule's weekdays for all active members.
- Calendar-gated targeting selects members without any weekday gate.
- Invalid field placement and zero-member specific writes are rejected.
- Rule and assignments commit/rollback together.
- Archived members remain ineligible; existing references remain readable.
- Admin authoring and dry-run work without adding a household dashboard widget.

## Related Decisions

ADR-018/049 (calendar interface and kind split), ADR-002/054 (member targeting),
ADR-020/005/006 (weekdays and dates), ADR-043 (atomicity), ADR-008 (briefing ownership).
