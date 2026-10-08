# ADR-040 Domain Event System (Cross-Module Decoupling)

Status: accepted
Owner: architecture
Decision date: 2026-06-28

## Reconciliation (2026-10-08)

Typed best-effort delivery and fault containment exist, but `src/server/lib/event-bus.ts` currently swallows subscriber failures without the failure counters/health exposure required below. That is an outstanding implementation gap, not a relaxation of this requirement.

## Decision

v2 modules (core domains and plugins) communicate across boundaries in exactly
**two sanctioned ways**, and never by direct cross-module calls or imports:

1. **Calling defined host-API interfaces** (a module's declared "inbound" API).
2. **Emitting / subscribing to domain events** (a module's declared "outbound"
   API).

This makes the event surface a first-class, documented part of every domain. It
turns Rule B (ADR-039) from a prohibition into a positive contract: cross-module
coupling happens only through declared interfaces + events.

### Why events (not direct calls) for cross-domain reactions

A cross-domain reaction such as "print the daily briefing when the morning
routines are completed" crosses a forbidden dependency edge: Routines is **core**;
Daily Briefing and Printing are **plugins**; core cannot depend on plugins
(ADR-029/039). Direct calls would couple core→plugin and break when a plugin is
inactive. Events decouple it correctly: the **state-owner emits** a generic event
knowing nothing about listeners; the **output-owning producer subscribes** and
acts via the absence-tolerant interface (ADR-039). A missing/inactive subscriber
is simply an **unheard event** — graceful degradation falls out for free, which
is exactly the absence-tolerance the plugin architecture requires.

### Semantics (calibrated to a single-process family kiosk)

- **In-process, in-memory, real-time.** Single kiosk server; no broker, no
  cross-machine delivery.
- **Fire-and-forget async emit.** The emitter never blocks on, waits for, or is
  affected by subscribers.
- **At-most-once, best-effort.** Events are NOT persisted. A reboot in the small
  window between emit and consume may drop an event. This is an accepted,
  recoverable trade — we do not complicate the architecture for a rare
  reboot-in-the-gap.
- **Events are notifications, never state.** Canonical state lives in domain
  tables; events only _announce transitions_. No event sourcing, no
  replay-as-truth, no ordering guarantees beyond best-effort per emitter.
- **Subscriber faults are contained** (ADR-039 fault isolation extends to event
  handlers): a throwing subscriber never propagates to the emitter or other
  subscribers.

### Correctness guards (from peer review)

- **Emit post-commit only.** Emitters MUST call `emit()` only **after** their DB
  transaction commits, never inside an open transaction. Otherwise a rolled-back
  transaction can still trigger a durable side effect (e.g. a subscriber enqueues
  a persisted print job, then the emitter's transaction rolls back → a "phantom
  event" prints a briefing for routines that were never completed). An event must
  describe a transition that actually happened.
- **Immutable payload delivery.** The bus MUST deliver an
  `Object.freeze(structuredClone(payload))` copy to each subscriber. This closes
  the one fault-isolation gap that try/catch does not cover: a _non-throwing_
  subscriber that mutates a shared payload object would otherwise corrupt input
  to later subscribers. Cost is microseconds.
- **Subscriber-failure observability.** Fault containment without observability
  makes a permanently-broken subscriber invisible (the emitter succeeds, events
  are swallowed, the family silently stops getting briefings). The bus MUST keep
  a per-subscriber delivery-failure counter and expose it on the plugin health
  endpoint; a subscriber throwing N consecutive times SHOULD surface as
  `degraded` (ties to ADR-039 `errored` state + Kiosk Shell global health
  indicator). A simple atomic counter — not a dead-letter queue.

### Durability division of labor

**Durability lives in the scheduler (ADR-035), not the event bus.** If work must
survive a reboot, it is a **persisted scheduled/queued job** (ADR-035/ADR-014),
not an event. The event bus stays trivially simple. Escape hatch: if an
event-driven action needs durability, the **subscriber enqueues a persisted
scheduler job in its handler** — durability is opt-in via the scheduler.

### Identity and payload

- Events are **namespaced by emitter**: `routines.morning_completed`,
  `members.created`.
- Each event carries a **documented payload**: IDs + minimal data (consistent
  with ADR-039 "reference core entities by ID"), not whole entity graphs.

### Documentation contract

Every domain contract gains an **Events** section documenting:

- **Emits:** event name, payload, and when it fires.
- **Subscribes:** which events it listens to and why.

This is the module's declared outbound coupling surface, paired with its
interfaces (inbound).

## Rationale

A fully event-decoupled module graph removes hard dependencies between modules,
which is what makes the core/plugin split (ADR-029) and the third-party seam
(ADR-039) actually hold: producers, subscribers, and future plugins compose
additively. In-memory at-most-once is the right calibration because the durable
path already exists (the persisted scheduler), so the event bus only needs to
carry transient real-time notifications. Most events fire and are consumed within
seconds; persisting them would add complexity solely for a rare reboot window.

## Affected Specs

- Each imported domain contract documents its event surface.
- [the background jobs scheduler feature](../../features/background-jobs-scheduler.md) — durability boundary
  (scheduler persists; events do not).
- Printing / Daily Briefing — first consumer (event-driven print trigger).

## Data / Setup Implications

No new persisted store for events (they are in-memory). The contract-template
change adds an Events section; existing contracts are backfilled as they are
revisited.

## Acceptance Criteria

- Given a core domain and an inactive plugin subscriber, when the domain emits an
  event, then the emitter completes normally and the event is simply unheard.
- Given a subscriber that throws, when it handles an event, then neither the
  emitter nor other subscribers are affected.
- Given an event that drives a durable action, then durability is achieved by the
  subscriber enqueuing a persisted scheduler job — not by persisting the event.
- Given two modules that need to interact, then they do so via a host-API
  interface or an event, never a direct cross-module import/call (enforced by the
  ADR-039 import-boundary check).
- Given any domain contract, then it documents the events it emits (name/payload/
  when) and subscribes to.
- Given an emitter whose transaction rolls back, when it would have emitted an
  event, then no event is emitted (post-commit-only) and no subscriber side
  effect occurs.
- Given a subscriber that mutates its received payload, when a later subscriber
  handles the same event, then the later subscriber sees the original payload
  (immutable delivery).
- Given a subscriber that throws on every delivery, then its failure count is
  observable on the plugin health endpoint and it surfaces as `degraded`.

## Refined by

- **`ADR-050` Typed event catalog:** event names + payloads are a declared typed catalog
  (core) / manifest-declared (plugins); a magic-string/undeclared name is a build error.
  Closes the silent-typo footgun inherent to at-most-once + absent-subscriber-is-fine.
  Delivery semantics here are unchanged.

## Open Questions

- Exact in-process pub/sub API shape — implementation detail (now constrained by the
  `ADR-050` typed catalog).
- ~~Backfill of Events sections into the five already-written contracts~~ — **DONE
  (2026-06-29):** Members (emits lifecycle, not load-bearing), App Settings / Auth / Kiosk
  Shell / Plugin System (deliberate non-participants — pull/registry/settings-mechanism).

## Traceability

- Related prior: new cross-cutting decision (surfaced by the Daily Briefing + Printing
  cluster grill).
- Related: `ADR-029` (core/plugin split), `ADR-039` (Rule B / absence-tolerant
  interfaces / fault isolation), `ADR-035` (persisted scheduler = durability
  home), `ADR-014` (background jobs).
- Peer review: codex-peer-review blind-debate (2026-06-28) — no critical findings,
  no over-engineering; event bus confirmed as the right primitive for the
  core-cannot-call-plugin inversion. Three cheap contract gaps incorporated:
  emit-post-commit-only (phantom-event guard), immutable payload delivery,
  subscriber-failure observability. Accepted non-goals confirmed (at-most-once
  drop, namespacing-only collision handling, no bus-level schema validation).
