# Feature: Time Announcements (household spoken time reminders)

Behavior reference. The [owning contract](../architecture/contracts/time-announcements.md) defines invariants and extension limits.

Time announcements are admin-authored wall-clock rules (`HH:MM` + weekdays) that each
connected kiosk browser speaks aloud at the matching local minute. The server owns the
rule data only; speech is a client-side runtime behavior. There is no master switch,
quiet hours, or per-device audio control in v2 — announcements are household-wide.

## User workflows

### User Story 1 — Author a household time announcement

A parent/admin defines a rule with a wall-clock `HH:MM` and the weekdays it should play;
every connected kiosk browser then speaks a short localized phrase at the matching
household-local minute on those weekdays.

### User Story 2 — Keep announcements non-overlapping and toggleable

An admin lists rules (including inactive ones, ordered by time), edits or toggles a rule
active/inactive, or deletes it permanently; the system rejects a second active rule that
collides with an existing active rule at the same time on a shared weekday.

### User Story 3 — Speak reliably without new failure surface

A kiosk speaks the rule once per minute per browser (leader tab + dedupe), tolerates
missing/blocked speech as a harmless no-op, and never crashes the scheduler on a speech,
dedupe, or timezone-format failure.

### Edge Cases

- A malformed `HH:MM` or an empty weekday set is rejected at write — no row is created.
- Two active rules sharing time + a weekday collide; an inactive overlap is allowed.
- Multiple connected devices may each speak the same announcement — double-speak is
  accepted, not coordinated away.
- A speech/voice or dedupe/localStorage failure changes no rule state and is swallowed.

## Requirements

### Functional Requirements

- **FR-001**: Given any rule field, time, weekday, local date, or dedupe key, when it is resolved by either the write boundary or the client scheduler, then it MUST resolve in the household timezone, and it MUST never resolve in UTC and never in the browser timezone. Contract: TIME-ANNOUNCEMENTS-INV-01.

- **FR-002**: Given a rule write carrying a `time`, when the value is validated, then it MUST be a strict 24h `HH:MM` in `00:00`–`23:59`, and a malformed value MUST be rejected at write rather than normalized. Contract: TIME-ANNOUNCEMENTS-INV-02.

- **FR-003**: Given a rule write carrying weekdays, when the set is validated, then it MUST be a non-empty `mon..sun` set (`ADR-020`), and the weekday MUST be obtained via `weekdayOf` derivation. Contract: TIME-ANNOUNCEMENTS-INV-03.

- **FR-004**: Given two active rules, when they share an `HH:MM` and an overlapping weekday, then the write MUST be rejected against the latest persisted rows (LWW by id, conflict re-checked at save), and inactive rules MUST be permitted to overlap because they do not fire. Contract: TIME-ANNOUNCEMENTS-INV-04.

- **FR-005**: Given an existing rule, when `isActive` is toggled off, then it MUST soft-disable, remaining editable and listable while not firing, and a delete MUST be permanent with no archive tier. Contract: TIME-ANNOUNCEMENTS-INV-05.

- **FR-006**: Given a connected browser, when an active rule's local minute matches, then firing MUST be client-side with the server owning rule data only and never firing, and within that browser the tabs MUST elect one leader and dedupe per-browser by the dedupe key. Contract: TIME-ANNOUNCEMENTS-INV-06.

- **FR-007**: Given multiple connected devices, when a rule's minute matches on each, then each device MUST be allowed to speak with no cross-device coordination, and the resulting double-speak MUST be accepted as harmless (unlike printing's atomic claim). Contract: TIME-ANNOUNCEMENTS-INV-07.

- **FR-008**: Given the client scheduler, when speech is missing or blocked, then it MUST treat the failure as a swallowed no-op that never crashes the scheduler and persists no retry/failure state, and a dedupe/localStorage failure MUST never silence a legitimate announcement. Contract: TIME-ANNOUNCEMENTS-INV-08.

- **FR-009**: Given an utterance, when it is built and spoken, then its `lang` MUST always be the household locale (matching voice if present, else browser-default voice with the correct `lang` plus a logged miss), and the phrase wording MUST be localized product copy keys, not hardcoded Spanish. Contract: TIME-ANNOUNCEMENTS-INV-09.

- **FR-010**: Given the v2 feature surface, when announcement settings are considered, then no master switch, quiet hours, volume/rate/pitch, or per-device enablement MUST exist, and the behavior MUST remain household-wide. Contract: TIME-ANNOUNCEMENTS-INV-10.

- **FR-011**: Given the household timezone, when it reaches the scheduler, then an invalid IANA timezone MUST be unreachable because `ADR-028` validates it at the settings boundary, and the scheduler MUST stay defensive so a format failure yields no fire plus a health signal and never crashes. Contract: TIME-ANNOUNCEMENTS-INV-11.

- **FR-012**: Given a rule-create write, when its `HH:MM` is malformed or its weekday set is empty, then the write MUST be rejected, and no row MUST be created. Contract: TIME-ANNOUNCEMENTS-AC-01.

- **FR-013**: Given a new active rule, when it overlaps another active rule at the same time on a shared weekday, then the write MUST be rejected, and an inactive overlap MUST be allowed. Contract: TIME-ANNOUNCEMENTS-AC-02.

- **FR-014**: Given an active rule, when the household-local weekday and `HH:MM` match, then the scheduler MUST fire using tz-aware calendar arithmetic, and the firing MUST be DST-safe. Contract: TIME-ANNOUNCEMENTS-AC-03.

- **FR-015**: Given one browser, when a rule's minute matches, then it MUST speak at most once per minute via leader election plus dedupe, and across devices each device MAY speak. Contract: TIME-ANNOUNCEMENTS-AC-04.

- **FR-016**: Given an utterance, when it is spoken, then its `lang` MUST be the household locale, and the wording MUST be localized rather than hardcoded Spanish. Contract: TIME-ANNOUNCEMENTS-AC-05.

- **FR-017**: Given a speech or dedupe failure, when it occurs during scheduling, then it MUST change no rule state, and it MUST never crash the scheduler. Contract: TIME-ANNOUNCEMENTS-AC-06.

- **FR-018**: Given the rule surface, when CRUD is invoked, then a create/edit/toggle/delete MUST require admin write capability, and listing MUST be kiosk-visible. Contract: TIME-ANNOUNCEMENTS-AC-07.

- **FR-019**: Given the v2 settings surface, when it is inspected, then no master switch, quiet hours, per-device, or audio-control setting MUST exist, and announcements MUST stay household-wide. Contract: TIME-ANNOUNCEMENTS-AC-08.

### Key Entities

- **Time announcement (rule)**: a durable household rule `{ id, time (HH:MM),
weekDays (mon..sun), isActive, createdAt, updatedAt }`. The server owns the row;
  it never fires.
- **Dedupe key**: the browser-local tuple `(household-local date, HH:MM, ruleId)` that
  prevents a second speak within the same browser for the same minute.

## Success Criteria

- **SC-001**: 100% of rule writes with a malformed `HH:MM`, an empty weekday set, or an
  active-overlap collision are rejected with no row created.
- **SC-002**: Each connected browser speaks an active rule at most once per matching
  household-local minute (DST-safe), while multiple devices may each speak.
- **SC-003**: No speech, dedupe, or timezone-format failure crashes the scheduler or
  mutates rule state; the household locale is always the utterance `lang`.

## Assumptions

- Household `timezone` and `language` are consumed from the settings surface
  (`ADR-005`/`ADR-015`), with IANA timezone validated there (`ADR-028`).
- The shell-mounted scheduler, connection state, and best-effort speech placement are
  provided per `ADR-035`/`ADR-051`; firing and dedupe are browser-local.
- Fresh v2 data store (`ADR-026`); legacy prod rows are evidence only and are
  validated/quarantined on import rather than failing the whole list.
