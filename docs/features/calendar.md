# Feature: Calendar (the household feed)

Behavior reference. The [owning contract](../architecture/contracts/calendar.md) defines invariants and extension limits.

Calendar is the **sole owner of "the feed"**: it merges local events
(household-managed) with external events (ingested from subscribed ICS feeds),
assigns events to members by parsing names from titles, and decorates titles
with highlight emoji at read time without ever rewriting stored data. Every
other module reads the feed only through the parameterized
`Calendar.getEvents({source, assignedTo, query, queryFields, range})`
interface — never by touching Calendar tables.

## User workflows

### User Story 1 — Subscribe to and sync an external ICS feed

A parent subscribes the household to an external ICS feed (e.g. a school
calendar). Calendar validates the feed URL on write and again on every fetch
(rejecting private/loopback addresses), polls it, expands recurrence in a
documented window, and merges those external events into the feed — masking
the feed URL so its embedded token never reaches a client.

### User Story 2 — Read the merged, member-scoped feed

A consumer module (e.g. Reminders) or a household view requests events through
`getEvents`, optionally filtering by `assignedTo: member`. Calendar returns the
merged local+external feed with status applied, highlight decoration applied at
read time, and — when `assignedTo` is set — only events explicitly assigned to
that member.

### User Story 3 — Delete an external source without orphans

A parent deletes a subscribed source. Calendar acquires the per-source sync
guard first so an in-flight sync cannot resurrect the source's events, then
atomically removes the source, its imported events, and their `ext:`
assignments — leaving no orphaned rows.

### Edge Cases

- A sync containing one malformed event still reconciles every other event and
  records source health rather than failing the whole poll.
- An all-day event written with `start == end` is rejected at the boundary.
- An archived member drops from active reads while their historical assignment
  rows remain readable but read-only.
- A reconcile that crashes mid-write leaves no partial event set and surfaces the
  failure in the source's status.
- Manual assignments on an imported event are additive only. A member added by
  hand survives every later sync, because a sync replaces only the `ext:` rows it
  derived from the title. A member the title names cannot be removed for good:
  the removal holds until the next re-derivation (the feed changed, or a
  household member was edited), which reads the title again and restores them.
  There is no per-event opt-out from title-derived assignment. The Calendar
  screen offers participant editing on external events (their feed fields stay
  read only). Saving keeps a member the title names title-derived rather than
  turning them into a manual assignment, so a later title change can still drop
  them, and never stores the same member twice.

## Requirements

### Functional Requirements

- **FR-001**: Given another module needs calendar data, when it reads events, then it MUST call `Calendar.getEvents({source, assignedTo, query, queryFields, range})` and MUST NOT access Calendar tables directly, and Calendar merges local+active-external, resolves `ext:`, applies status, and normalizes text behind that interface, which exposes capabilities only and MUST NOT vary its response by the identity of the calling module. Contract: CALENDAR-INV-01.

- **FR-002**: Given an event assignment is written, when it targets a member, then the member MUST be active (any role), and archived members MUST drop from active reads while their historical rows remain read-only. Contract: CALENDAR-INV-02.

- **FR-003**: Given a date value, when it is written or used as a range boundary, then it MUST be a strict calendar-valid `YYYY-MM-DD` in household tz, with the range's upper boundary the exclusive next-midnight. Contract: CALENDAR-INV-03.

- **FR-004**: Given an all-day event, when it is stored, then it MUST be date-only `YYYY-MM-DD` half-open with `end` exclusive and `end > start` enforced (`start == end` rejected), reads MUST be pure date comparison with no tz conversion, and the inclusive end is shown only in the UI via a single conversion at the form edge. Contract: CALENDAR-INV-04.

- **FR-005**: Given an external feed, when its URL is written and again on resolution before every fetch, then it MUST be validated (non-HTTP(S), localhost/loopback, private/link-local/reserved rejected, guarding DNS rebinding), external titles/descriptions MUST be sanitized at render, and feed URLs MUST be masked so the raw token-bearing URL never reaches a client. Contract: CALENDAR-INV-05.

- **FR-006**: Given an external source's provider field, when it is imported, then provider MUST be display-only (`google|microsoft|apple|ics_generic`), an unknown value MUST map to `ics_generic`, and provider MUST never affect parsing. Contract: CALENDAR-INV-06.

- **FR-007**: Given a mutating calendar operation, when it is a local-event delete + assignment cleanup, an assignment-set replace, an external-source delete + imported-events + `ext:` cleanup, or a highlight reorder, then it MUST run as an atomic transaction, whereas external sync reconciliation MUST instead be idempotent best-effort (upsert per `(source, uid, recurrenceId)`, skip+log malformed, record source health) rather than one giant transaction. Contract: CALENDAR-INV-07.

- **FR-008**: Given a source delete, when it runs, then it MUST acquire the per-source sync guard before its transaction so an in-flight sync cannot resurrect orphans after the delete commits, and `PRAGMA foreign_keys = ON` MUST be set per connection as a baseline net. Contract: CALENDAR-INV-08.

- **FR-009**: Given a `getEvents` call, when `assignedTo` is set to a member, then it MUST return only events with an explicit assignment for that member, and an unassigned event MUST match only when `assignedTo` is omitted — preventing reminder gates from firing on unassigned family events. Contract: CALENDAR-INV-09.

- **FR-010**: Given a generation read, when it queries events, then it MUST accept a caller-supplied read-transaction context for a consistent snapshot, and per-member/date events MUST be fetched once. Contract: CALENDAR-INV-10.

- **FR-011**: Given a consumer such as Reminders, when it obtains events, then it MUST do so only via `getEvents` and never via a table. Contract: CALENDAR-AC-01.

- **FR-012**: Given an all-day event, when it is stored, then it MUST be date-only half-open with `start == end` rejected, and it MUST render on the correct local day in any host timezone. Contract: CALENDAR-AC-02.

- **FR-013**: Given a feed URL, when it resolves to a private or loopback address, then it MUST be rejected before the fetch. Contract: CALENDAR-AC-03.

- **FR-014**: Given an external source delete, when it runs, then it MUST remove the source, its events, and their `ext:` assignments atomically, and it MUST be serialized with any in-flight sync of the same source so no orphan is resurrected. Contract: CALENDAR-AC-04.

- **FR-015**: Given a sync containing one malformed event, when it reconciles, then it MUST still reconcile the rest of the events and record source health. Contract: CALENDAR-AC-05.

- **FR-016**: Given `getEvents({assignedTo: m})`, when it returns, then it MUST exclude every event that has no assignment row for `m`. Contract: CALENDAR-AC-06.

- **FR-017**: Given an external event whose provider is unknown, when it is imported, then it MUST import as `ics_generic`. Contract: CALENDAR-AC-07.

- **FR-018**: Given a calendar reconcile, when it fails mid-way, then no partial event set MUST persist and the failure MUST be recorded in the source's status. Contract: BACKGROUND-JOBS-SCHEDULER-AC-05.

### Key Entities

- **Event**: a dated household commitment, either a **local event** (household-
  managed) or an **external event** (ingested from a subscribed feed,
  feed-controlled). **Timed events** are UTC instants displayed in household tz;
  **all-day events** are date-only `YYYY-MM-DD` half-open (`end` exclusive).
- **External source**: a subscribed ICS feed with a masked URL, enabled flag,
  poll interval, sync health metadata, and a display-only provider.
- **Assignment**: an explicit link from an event to an active member, produced by
  title-derived parsing on create or by manual assignment replace.
- **Highlight rule**: an ordered, read-time keyword→emoji title decoration that
  never rewrites stored titles.

## Success Criteria

- **SC-001**: 100% of cross-module event reads go through `getEvents`; zero direct
  Calendar-table reads by any other module.
- **SC-002**: A feed URL resolving to a private/loopback address is rejected
  before any network fetch is performed, on both write and every resolution.
- **SC-003**: An external source delete leaves zero orphaned events or `ext:`
  assignments, even under a concurrent sync of the same source.
- **SC-004**: A sync with one malformed event reconciles 100% of the remaining
  valid events and records source health.

## Assumptions

- ICS parsing/expansion (`RRULE/RDATE/EXDATE`, `VTIMEZONE`/DST → UTC instants or
  date-only) is delegated to a mature library (resolved via Context7 at impl);
  Calendar owns reconciliation, safe fetch, and merge — no hand-rolled parser.
- Fresh data store; no legacy events are imported (ADR-026); the migration
  mapping `outlook→microsoft` / unknown→`ics_generic` is documented only.
- Recurrence is expanded in a documented `−30d/+365d` window; cancelled events are
  retained but purged once past the window.
- Local-event `rrule` is limited to `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` with
  `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH` and `WKST`; writes
  reject anything else with 400 and reads expand a previously stored unsupported
  rule to no occurrences, because rrule.js expansion is synchronous and a sub-daily
  or never-occurring rule would block the shared event loop
  (`supportedRruleProblem`, `src/server/modules/calendar/recurrence.ts`).
- Atomicity and date/weekday primitives are provided per ADR-043/ADR-005/ADR-006.
