# ADR-062 Calendar Timed-Event Storage — UTC Instant Plus Originating TZID

Status: accepted

Owner: architecture

Decision date: 2026-07-30

Peer-reviewed: yes (codex + claude blind-debate on the slice-004 seam, 2026-07-30 — the review
surfaced the mutable-household-timezone trap, ADR-028, that motivates this ADR). The DST
runtime-behavior claim is **empirically probed** (below), per Constitution XIV.

## Context

The `calendar` domain contract phrases a timed event as _"instants (UTC stored, household-tz
displayed)"_ — written for a **single** timed event. Slice-004 (`004-calendar-local-feed`) puts
**recurring** timed local events in scope, and that exposes a gap the "UTC stored" phrasing does not
cover: a UTC instant alone cannot correctly expand a recurring timed series across a DST transition.

A recurring event's intent is **wall-clock** ("09:00 every Monday"), not a fixed UTC offset. If only
a UTC anchor is stored and the rule steps in UTC, occurrences drift by the DST offset (09:00 local
becomes 10:00 after a spring-forward). RFC 5545 encodes this with `DTSTART;TZID`: the series recurs
in its timezone's wall-clock. Two further facts sharpen the need:

- **The household timezone is mutable** (ADR-028: `PUT /settings` persists `locale.timezone`). A
  UTC-only one-off event carries no originating TZID, so if it is later promoted to a recurring
  series _after_ a household-tz change, the originally-intended wall-clock is unrecoverable.
- The shared `RRULE` expander (rrule.js) requires a `tzid` to expand in
  wall-clock, and its return values are wall-clock-in-UTC-fields (a footgun requiring instant
  reconstruction — see Empirical Evidence).

This is a new decision refining the contract's storage wording; it is not previously contemplated.

## Decision

**Every Calendar timed event stores its UTC instant _and_ its originating IANA TZID** — one uniform
representation for both one-off and recurring events. All-day events are unchanged (date-only
`YYYY-MM-DD` half-open; no timezone).

- **Display** uses the household timezone, as the contract requires (unchanged behavior).
- **Recurrence expansion** interprets the stored TZID as the wall-clock zone: the shared expander
  (rrule.js) produces occurrences at the intended local time, converted to true UTC instants
  per-occurrence (DST-correct).
- **One-off events carry the TZID too**, so one-off→recurring promotion is lossless and survives a
  later household-timezone change (each event pins the tz it was authored in).
- The UTC instant remains stored (the contract's "UTC stored" holds); the TZID is **additive**, not
  a replacement. This ADR records the added column and its rationale so it is a traceable refinement,
  not silent drift from the contract.
- **Same model for external events** (slice B): ICS `VTIMEZONE`/`DTSTART;TZID` map onto the identical
  UTC+TZID shape and the same expander — no second recurrence model.

## Empirical Evidence (Constitution XIV)

**Claim probed**: local-start + TZID + `RRULE` expands to UTC instants preserving the local
wall-clock across a DST transition.

**Probe** (`rrule@2.8.1`, Node v22.23.1): weekly Monday 09:00 `Europe/Madrid`, `COUNT=6`, spanning
Spain's 2026 spring-forward (Sun 2026-03-29):

```
RRule.fromString('DTSTART;TZID=Europe/Madrid:20260302T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6').all()
```

**Observed** (after reconstructing each returned Date's UTC-fields as Madrid wall-clock → true
instant): 02–23 Mar → `08:00Z` (CET); 30 Mar & 06 Apr → `07:00Z` (CEST). Every occurrence = 09:00
Madrid local; the UTC instant shifts `08:00Z→07:00Z` exactly at the Mar 29 transition. **Wall-clock
correctness confirmed.**

**Hazard also observed**: rrule.js `.all()` returned `09:00Z` for all six occurrences — the returned
Date's **UTC fields encode the local wall-clock, not the true instant**. The implementation MUST
reconstruct the true UTC instant from the returned wall-clock components and the stored TZID; storing
`.toISOString()` directly would persist a wrong instant. The historical probe is summarized above.

## Rationale

UTC+TZID is the minimal information-complete representation: it stores the instant the contract asks
for **and** the wall-clock intent recurrence needs, in one uniform shape, defeating both the
two-storage-shapes inconsistency and the mutable-tz data-loss trap the peer review surfaced. It keeps
one recurrence engine for local and external events, preserving the slice-004 forward-compat bet.

## Affected Specs

- `docs/architecture/contracts/calendar.md` (Vocabulary: "Timed event — instants (UTC stored…)") — refined, not
  contradicted; TZID is additive. The contract remains the ledger oracle; this ADR records the
  storage detail the contract left to implementation.
- `docs/features/calendar.md` (Key Entities, FR-013, Assumptions).

## Data / Setup Implications

`calendar_events` timed rows carry a `tzid` column (IANA string) alongside the UTC instant(s). No
legacy import (ADR-026). All-day rows have no tzid. See the Calendar module and migration schema.

## Acceptance Criteria

- Given a recurring timed event stored as UTC+TZID, when the feed is read across a DST transition,
  then every occurrence resolves to the same household-local wall-clock time (probed above).
- Given a one-off timed event, when the household timezone is later changed and the event is made
  recurring, then its originating wall-clock is preserved (the stored TZID is authoritative).
- Given the shared expander, when an external ICS `RRULE` is later ingested (slice B), then it uses
  the same UTC+TZID model and expander with no reconciliation.

## Traceability

- Historical motivation: recurring local events, reviewed on 2026-07-30.
- Refines: `docs/architecture/contracts/calendar.md`; related `ADR-005` (household tz), `ADR-006` (dates),
  `ADR-028` (mutable tz), `ADR-043` (derive-on-read), `ADR-018`/`ADR-024` (Calendar interface/vocab),
  `ADR-063` (audit-timestamp encoding & the storage time taxonomy).
- Constitution: IV (time/date discipline), XIV (empirical evidence — probe above).
