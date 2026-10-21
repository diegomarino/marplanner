# ADR-043 Multi-Step Atomicity and Derived-State-on-Read

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Decision

Generalizes the ADR-009 atomicity umbrella into two classes that determine when a
multi-step operation needs a transaction:

**Class 1 — primary-state compound writes → atomic DB transaction (all-or-nothing).**
Operations that mutate the domain's own source-of-truth in multiple steps: Calendar
assignment-set replace, local event delete + assignment cleanup, external source
delete + imported-event + `ext:`-assignment cleanup, Reminders rule + member-targets
create/edit, Routines chore reorder. A partial primary state is _corruption_ (the
intent is unrecoverable), so it must be atomic. Trivial on single-instance local
SQLite.

**Class 2 — derived state → compute on-read, no cache.** State reconstructable from
primary data is **not persisted**. The Routines member streak / "last all-complete
date" is a derived query over `chore_completions`, not a stored field on Members. No
persisted derived state ⇒ nothing to desync ⇒ no completion+recalc atomicity ⇒ no
cross-domain Routines→Members write. Add a cache later only if recomputation cost ever
justifies it.

**External-data exception to Class 1:** data _mirrored_ from an external system is
reconciled **idempotently, not atomically** (Calendar external sync: upsert per
`(source, uid, recurrenceId)`, skip+log malformed events, source health metadata).
The source of truth lives outside; convergence (retry reaches the same state), not
atomicity, is the right guarantee. Forcing a giant transaction lets one bad event
block the whole sync.

**Delete-vs-sync coordination (peer-review C1):** a source-delete (Class 1 atomic) and
an in-flight idempotent sync of the _same_ source must not run concurrently, or the
running sync resurrects orphan rows after the delete commits. **The source-delete path
acquires the same per-source in-flight sync guard before its transaction** (reuse the
existing mutex; no tombstone machinery). Baseline safety net: **`PRAGMA foreign_keys =
ON` per connection** so a future code path that forgets the guard cannot leave dangling
`ext:` rows.

**Consistent read snapshot for generation (peer-review I1):** when a consumer makes
multiple cross-module reads that must agree, Daily Briefing gathers all local inputs
synchronously inside **one SQLite read transaction**, using the shared `getDb()`
connection. This includes the business date, member label, block order and settings,
household language, weather location/timezone, and local domain block outcomes.
Routines derives streaks on that same connection; Calendar and Reminders share a
request-scoped `CalendarReadContext` to fetch events once per member/date and reuse
private query metadata across reminder rules. The context is valid only inside the
caller's synchronous transaction and is discarded after gathering.

The transaction closes before external fetching and rendering. Those phases consume
captured local inputs; they never reopen domain reads to complete the snapshot.
Weather cache admission uses the eviction epoch captured with its local inputs:
a settings edit during earlier external work cannot republish a stale forecast.
External content keeps its independent once-per-date cache and provider timing, so
this is a coherent **local** snapshot, not a distributed snapshot of upstream systems
or an all-members batch snapshot. Eligibility is checked again before rendering and
inside the atomic persistence/print-supersession transaction: a concurrent archive or
opt-out can still prevent publication of captured content.

A controlled quote-source pause with an atomic local edit reproduces the prior
mixed-state result (old member identity alongside newly read content/settings).
Generation regressions cover captured content, settings, Calendar/Reminders and
render language; regeneration observes the new local state under the stable ID.

## Rationale

"The best cache is no cache": eliminating derived state removes the entire
synchronization problem rather than managing it (no stale field, no recalc trigger,
no cross-domain write). The class split prevents both over-engineering (transaction
around mirrored external ingest) and under-engineering (partial primary writes). The
distinguishing question is **source-of-truth vs derived vs mirrored**: atomic for your
own primary state, recompute for derived, idempotent for mirrored.

## Affected Specs

- [routines-chores](../../features/routines-chores.md), [calendar](../../features/calendar.md), [reminders](../../features/reminders.md),
  [members](../../features/members.md) (drops stored streak summary fields)

## Data / Setup Implications

Members no longer stores `last_completed_all_tasks_date` / streak summary fields as
authoritative state; they become a Routines read interface
(`Routines.getMemberStreak(memberId)`) computed from completions. No legacy import
(ADR-026).

## Acceptance Criteria

- Given a Calendar assignment-set replace, when any step fails, then no partial
  assignment set persists (atomic).
- Given a completion toggle, when it succeeds, then no derived member field is written;
  streak is computed on read.
- Given an external sync with one malformed event, when it runs, then other events
  still reconcile and the source records the failure (idempotent best-effort).
- Given a source delete, when it runs, then source + imported events + `ext:`
  assignment rows are removed together (atomic), leaving no orphans.

- Given local state changes while an external source is paused, then the generated
  local content and render language reflect the pre-await read snapshot; regeneration
  observes the edit without changing the briefing ID.
- Given several calendar-gated rules in one gather, then one event read supplies their
  independently filtered queries without exposing private metadata in the public feed.
- Given external fetching or rendering, then no local read transaction remains open.

## Open Questions

- Streak retroactivity (on-read against current-active config reinterprets past dates)
  is **inherent and accepted** (see cluster grill Ro2).

## Traceability

- Related prior: `ADR-009` (this refines/extends it for the cluster)
- Related: `ADR-022`, `ADR-040`, `ADR-039`
