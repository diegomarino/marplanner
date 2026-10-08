# ADR-050 Typed Event Catalog (event-name registry for the domain event bus)

Status: accepted
Owner: architecture
Decision date: 2026-06-29

## Decision

Refines `ADR-040` (domain event bus): event names and payloads are a **declared, typed
catalog**, not free magic strings. This makes a typo'd or drifted event name a
**build/lint error** instead of a silent runtime no-op — the worst footgun of the bus,
because `ADR-040` is at-most-once and "absent subscriber = unheard = graceful
degradation" _by design_, so a misspelled `emit`/`subscribe` is indistinguishable from
"nobody is listening" and nothing detects it.

**Core events — typed catalog (name → payload type).** A single shared module is the
source of truth mapping each core event name (`domain.event_name`, e.g.
`routines.completion_changed`, `printing.completed`) to its payload type. `emit()` and
`subscribe()` reference the catalog; **a magic-string event name is a build/lint error**.
Typing the payload per event also kills a second silent class — **payload drift** (emitter
changes the shape, subscriber reads a stale field) becomes a compile error.

**Plugin events — manifest-declared (ADR-039 aligned).** Each plugin **declares in its
manifest** the events it **emits** and **subscribes** to, namespaced by plugin ID (Rule
B; drop-on-uninstall). Emitting or subscribing to an **undeclared** name is a
declaration/build error. A namespace prefix must match its owner (a plugin cannot emit
under `core.*` or another plugin's namespace). The shared core catalog is implemented, but plugin manifests currently lack these declarations and owner checks; the plugin gate remains required implementation work.

**Semantics unchanged (this is a name/type gate, not a delivery change).** A **registered
event with zero subscribers is still valid** — intentional graceful degradation is
preserved (`ADR-040`). The catalog only distinguishes "intentionally unsubscribed" from
"typo"; it does **not** require a subscriber, and it does not change at-most-once,
in-memory, post-commit, immutable-payload delivery, or subscriber-fault containment.

## Rationale

Same principle that already won in i18n (`dynamicKeyRegistry`), Reminders (dry-run), and
telemetry redaction: **turn a fragile convention into an enforced build gate.** The event
bus is where the absence of this hurts most, precisely because its correct-by-design
tolerance of missing subscribers makes a typo invisible at runtime. For a first-party TS
monorepo a typed `event → payload` map is idiomatic and nearly free — the natural way to
avoid magic strings — so this is the cheap correct default, not over-engineering. The
plugin manifest declaration reuses the existing `ADR-039` namespacing/declare-now pattern,
keeping the third-party seam ready.

## Affected Specs

- `ADR-040` (refined), `../../*` (every contract's Events section references catalog names)

## Data / Setup Implications

No runtime data. A build-time/source artifact: the core typed event catalog + per-plugin
manifest event declarations. No legacy import (`ADR-026`).

## Acceptance Criteria

- An `emit`/`subscribe` with an event name not in the core catalog (or, for a plugin, not
  declared in its manifest) fails the build/lint.
- A subscriber reading a payload field not in the event's typed payload fails to compile.
- A plugin emitting under `core.*` or another plugin's namespace fails the
  declaration/build check.
- A registered event with no subscribers still emits without error (graceful degradation
  preserved).
- Delivery semantics (at-most-once, in-memory, post-commit, immutable payload, fault
  containment) are unchanged from `ADR-040`.

## Open Questions

- Catalog source-of-truth mechanism (shared types vs codegen) — implementation detail.

## Peer Review

codex-peer-review blind-debate (2026-06-29), reviewed with `ADR-016`. **Sound — no
accepted issues.** Confirmed: does **not** undermine `ADR-040`'s "absent subscriber =
graceful degradation" (the catalog gates names/types, not subscriber count; zero-subscriber
events stay valid); typed payload is **proportionate** for a TS monorepo (same cost as
name-only, catches drift too); no hard-coupling from drop-on-uninstall because `ADR-039`
keeps install/uninstall dormant in this system (all plugins in-tree at build/boot).

## Traceability

- Related prior: refines `ADR-040`.
- Related: `ADR-039` (plugin manifest/namespacing), `ADR-015` (registry-as-gate pattern)
