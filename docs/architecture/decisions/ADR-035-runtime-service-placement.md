# ADR-035 Runtime Service Placement: Capability-Based, Decision/Execution Split

Status: accepted
Owner: architecture
Decision date: 2026-06-28

## Decision

Runtime services are placed by the capability they require. Server capabilities own persistent decisions and jobs; browser capabilities own local hardware execution. Time announcements are the explicit exception: the browser evaluates and fires them locally under ADR-065. This reconciliation supersedes the server-queued announcement language preserved below as historical rationale.

### Principle 1 — Placement by required capability

- **Global server-side services** run once regardless of whether any UI is open: daily-briefing generation, external calendar sync, backups, and printing decisions and jobs. Time announcements are browser-local under ADR-065.
- **UI-bound services** run per connected browser because they need a browser capability: audio output (Web Speech), Bluetooth print delivery (Web Bluetooth), PWA/service-worker updates, browser telemetry.

### Principle 2 — Decision/execution split for hardware-bound behaviors

- The "what and when" for printing is owned **server-side** as the single source of truth. Announcement timing is browser-local under ADR-065.
- The "execute on hardware" (speak the time, send bytes to the printer) is **UI-bound**: a connected browser claims pending work and executes it.
- This replaces the legacy browser leader-election (BroadcastChannel) and single-tab print assumptions.

### Principle 3 — Capability registration (required)

For server-dispatched hardware work such as printing, a connected browser registers the matching capability (for example, `hasBluetoothPrinter`). The server offers a print job only to a capable session. Speech capability and announcement timing are evaluated locally by the browser under ADR-065.

### Principle 4 — Coordination and queuing

- **Exactly-once dispatch via atomic claim.** The server hands out each unit of work once using an atomic compare-and-swap claim (`UPDATE ... WHERE claimed_by IS NULL RETURNING ...`). Two connected tabs cannot both claim the same job.
- **At-least-once execution, made safe per behavior.** A browser can execute a side effect and then crash before acknowledging, causing re-issue after lease expiry. Printing tolerates this via idempotency/dedup by job id (or a server-side "side-effect executed" flag before ack). Time announcements do not use this server queue; the browser drops stale local slots under ADR-065.
- **Zero connected browsers.** Printing work waits in a server queue. On reconnect, a capable browser drains it, subject to staleness. Announcements have no server backlog.
- **Server-side staleness expiry and compaction.** A periodic server cleanup removes stale queued printing work. After the kiosk is off, its browser must not replay old announcement slots.

### Principle 5 — Route scope collapses

UI-bound services run whenever the browser is connected, regardless of route (time announcements are not paused on admin routes). On the not-connected provisioning screen, nothing household-runtime runs. The exact presence/keepalive transport is owned by the feature using server-dispatched work.

### Plugin interaction

Per `ADR-029`, a service belongs to its plugin. An inactive plugin mounts neither its server-side scheduler nor its UI-bound executor. Time Announcements and Printing are plugins; their runtime services exist only when active.

## Operational Requirements (from peer review)

- The kiosk must surface a prominent alert when a Bluetooth printer connection is lost. Reconnecting to a remembered device needs no user gesture, but re-pairing after a printer factory-reset requires a physical tap — the architecture does not assume automatic recovery and must make the loss visible.

## Rationale

The legacy system placed these services ad hoc in the browser, producing multi-tab leader-election for announcements and a single-tab assumption for printing. Capability placement keeps persistent printing decisions on the server and hardware execution in a capable browser. ADR-065 later placed announcement timing and speech execution in the browser.

The original review favored server scheduling for announcements to avoid a browser lease gap near a slot boundary. ADR-065 superseded that placement. Its original reasoning remains here to explain the tradeoff, while implementation and tests must follow the browser-local decision.

## Affected capabilities

Printing uses the server decision and browser hardware execution split. Daily Briefing, external Calendar sync and Backups remain server-owned jobs when their owning batches import them. Time Announcements use browser-local scheduling and speech under ADR-065. The [scheduler contract](../contracts/background-jobs-scheduler.md) covers process-local jobs.

## Relationship to ADR-014

This decision substantially shapes `ADR-014` (background job singleton/status ownership): server-side printing jobs use a persisted queue with atomic claim/lease and server-side staleness compaction. `ADR-014` remains open for non-hardware background job details, but the hardware-bound dispatch model is settled here.

## Acceptance Criteria

- Given two connected tabs, when a print job is queued, then exactly one tab executes it (atomic claim).
- Given a phone session without the paired printer and a tablet session with it, when a print job is queued, then only the tablet session is offered the job (capability registration).
- Given no connected browser, a missed announcement slot is not replayed late when a browser reconnects.
- Given the kiosk was off for two weeks, its browser does not replay a backlog of stale announcements.
- Given a brief (<5 min) Wi-Fi drop, when it recovers, then UI-bound services resume without having been considered disconnected.
- Given a lost Bluetooth printer connection, then the kiosk surfaces a visible alert rather than silently failing.
- Given an inactive Printing plugin, then neither its server scheduler nor its UI executor is mounted.

## Open Questions

- Printing work-dispatch transport is an implementation detail of its owning batch.
- Non-hardware background job details remain under `ADR-014`.

## Traceability

- Conflicts: `CR-014`, `CR-018`
- Pre-v2: `ADR-014`
- Related: `ADR-029` (plugins own services), `ADR-005` (household-tz scheduling)
- Peer review: codex-peer-review blind-debate (2026-06-28) — model validated; capability registration, atomic claim, server-side compaction, connected-definition, Bluetooth alert incorporated.
