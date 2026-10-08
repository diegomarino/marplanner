# Calendar Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-006`, `ADR-009`, `ADR-018`, `ADR-024`, `ADR-040`, `ADR-043`

## Purpose

One place for dated household commitments: local events (household-managed) and
external events (ingested from subscribed ICS feeds), with member-aware assignment and
read-time highlight decoration. Calendar is the **sole owner of "the feed"** and serves
it through a parameterized read interface (ADR-018).

## Vocabulary

- **Local event** / **external event** — by source; external is controlled by its feed.
- **Timed event** — instants (UTC stored, household-tz displayed).
- **All-day event** — **date-only `YYYY-MM-DD`, half-open** (`end` exclusive); never an
  instant (see invariant 4).
- **External source** — a subscribed ICS feed with masked URL, enabled flag, poll
  interval, sync health.
- **Title-derived member assignment** — Calendar assigns events to members by parsing
  member names from event titles. (Distinct from the Reminders "calendar gate".)
- **Highlight rule** — read-time keyword→emoji title decoration; never rewrites stored
  titles.

## Invariants

1. **CALENDAR-INV-01** **Cross-module reads go through `Calendar.getEvents({source, assignedTo, query,
queryFields, range})`** — no direct table access by other modules (ADR-018 / Rule B).
   Calendar merges local+active external, resolves `ext:`, applies status, normalizes
   text. The interface exposes capabilities, not consumer policy.
2. **CALENDAR-INV-02** **Targeting:** new assignments target active members (any role) (ADR-002); archived
   members drop from active reads, historical rows read-only.
3. **CALENDAR-INV-03** **Dates** strict calendar-valid `YYYY-MM-DD`, household-tz, exclusive next-midnight
   range boundary (ADR-006/ADR-005).
4. **CALENDAR-INV-04** **All-day = date-only half-open.** A timezone is a property of an instant, not a day;
   all-day events store `YYYY-MM-DD` start/`end`-exclusive (`end > start` enforced;
   `start==end` illegal). Read = pure date comparison; TZ conversion confined to timed
   events. Matches RFC 5545 / Google / CalDAV. UI shows inclusive; conversion once at the
   form edge.
5. **CALENDAR-INV-05** **External feed security (real attack surface):** validate feed URL on write **and on
   resolution before every fetch** (reject non-HTTP(S), localhost/loopback, private/
   link-local/reserved; guards DNS rebinding); sanitize external titles/descriptions at
   render; mask feed URLs (may carry auth tokens) — never raw to clients.
6. **CALENDAR-INV-06** **Provider is display-only** (`google|microsoft|apple|ics_generic`); unknown →
   `ics_generic`; never affects parsing (ADR-024).
7. **CALENDAR-INV-07** **Atomicity (ADR-043):** local event delete + assignment cleanup, assignment-set
   replace, external source delete + imported-events + `ext:` assignment cleanup, and
   highlight reorder are **atomic transactions**. External **sync reconciliation is
   idempotent best-effort** (upsert per `(source, uid, recurrenceId)`, skip+log malformed,
   source health metadata) — not one giant transaction.
8. **CALENDAR-INV-08** **Source-delete acquires the per-source sync guard** before its transaction (so an
   in-flight sync can't resurrect orphans after delete commits); **`PRAGMA foreign_keys =
ON`** per connection as a baseline net (ADR-043 C1).
9. **CALENDAR-INV-09** **`assignedTo` returns only events with an explicit assignment for that member;**
   unassigned events match only when `assignedTo` is omitted (ADR-018 I3) — prevents
   reminder gates firing on unassigned family events.
10. **CALENDAR-INV-10** **Generation reads use the shared DB connection inside the caller's synchronous read transaction.** A request-scoped `CalendarReadContext` reuses per-member/date event entries and their private query metadata across reminder rules; it requires an active transaction and is discarded after gathering (ADR-018/ADR-043 I1).

## Behaviors

- **Read** merged/filtered feed via `getEvents` (highlights + assignment applied at read).
- **Local event** create/update/delete (parent/admin); title-derived assignment runs on
  create.
- **External source** create/update/delete/sync (parent/admin); manual + scheduled share
  one per-source in-flight guard (ADR-014); recurrence expanded in a `−30d/+365d`
  documented window; cancelled events retained but **purged once past the window**.
- **ICS parsing/expansion delegated to a mature library** (parse, `RRULE/RDATE/EXDATE`,
  `VTIMEZONE`/DST → UTC instants or date-only); Calendar owns reconciliation, safe fetch,
  merge. No hand-rolled ICS parser. (Concrete library resolved via Context7 at impl.)
- **Highlight rules** create/edit/reorder (atomic)/toggle/delete; decoration read-time only.

## Interfaces

- Inbound: `getEvents(...)` parameterized read; local event CRUD; external source CRUD +
  sync; highlight rule CRUD/reorder; manual assignment replace.

## Events

(ADR-040.) Calendar may **emit** change notifications for views to refresh; durability is
not on the bus. It **subscribes** to none. Other modules never read Calendar tables — they
call `getEvents`.

## Data / Setup Contract

Owned: events, external sources, imported external events, assignments, highlight rules
(namespaced). External events dominate (prod 1804 external / 0 local). No legacy import
(ADR-026); migration mapping `outlook→microsoft`, unknown→`ics_generic` documented only.

## Acceptance Criteria

- **CALENDAR-AC-01** A consumer (e.g. Reminders) obtains events only via `getEvents`; never a table.
- **CALENDAR-AC-02** All-day event stored date-only half-open; `start==end` rejected; renders on correct
  local day in any host tz.
- **CALENDAR-AC-03** Feed URL resolving to a private/loopback address is rejected before fetch.
- **CALENDAR-AC-04** External source delete removes source + events + `ext:` assignments atomically, and
  is serialized with any in-flight sync of the same source (no orphan resurrection).
- **CALENDAR-AC-05** Sync with one malformed event still reconciles the rest and records source health.
- **CALENDAR-AC-06** `getEvents({assignedTo: m})` excludes events with no assignment row for `m`.
- **CALENDAR-AC-07** Unknown provider imports as `ics_generic`.
- **BACKGROUND-JOBS-SCHEDULER-AC-05** Given a calendar reconcile fails mid-way, no partial event set persists and the failure is recorded in the source's status. _(carried from Background Jobs; reconcile atomicity is Calendar's domain action. See boundary-ledger.yaml.)_

## Open Decisions

- `queryFields` allowed set (title/description/location) — default title+description.
- Highlight match field scope (title vs title+description) — align with `queryFields`.
- Configurable recurrence window / retention — evolution.
