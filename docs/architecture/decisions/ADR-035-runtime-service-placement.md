# ADR-035 Runtime Service Placement: Capability-Based, Decision/Execution Split

Status: accepted
Owner: architecture
Decision date: 2026-06-28

## Decision

Runtime services are placed by the capability they require. Server capabilities own persistent decisions and jobs; browser capabilities own local hardware execution. Time announcements are the explicit exception: the browser evaluates and fires them locally under ADR-065. Persistent Printing claims do not apply to announcement timing.

### Principle 1 — Placement by required capability

- **Global server-side services** run once regardless of whether any UI is open: daily-briefing generation, external calendar sync, backups, and printing decisions and jobs. Time announcements are browser-local under ADR-065.
- **UI-bound services** run per connected browser because they need a browser capability: audio output (Web Speech), Bluetooth print delivery (Web Bluetooth), PWA/service-worker updates, browser telemetry.

### Principle 2 — Decision/execution split for hardware-bound behaviors

- The "what and when" for printing is owned **server-side** as the single source of truth. Announcement timing is browser-local under ADR-065.
- Hardware execution is **UI-bound**: a capable browser claims Printing work and sends printer bytes; announcement speech and timing run locally without a server claim.

### Principle 3 — Capability registration (required)

For server-dispatched hardware work such as printing, a connected browser registers the matching capability (for example, `hasBluetoothPrinter`). The server offers a print job only to a capable session. Speech capability and announcement timing are evaluated locally by the browser under ADR-065.

### Principle 4 — Coordination and queuing

- **One claimant per active lease.** The server serializes claims for each unit of work using an atomic compare-and-swap claim (`UPDATE ... WHERE claimed_by IS NULL RETURNING ...`). Two connected tabs cannot both claim the same job.
- **At-least-once execution with an accepted duplicate risk.** A browser can execute a side effect and then crash before acknowledging, causing re-issue after lease expiry. Server-side enqueue/ack deduplication prevents duplicate records, but cannot atomically cover a Bluetooth side effect. A crash after send and before acknowledgement can cause a duplicate physical print; this is accepted. A pre-send flag would instead risk a lost print and is not an exactly-once solution. Time announcements do not use this server queue; the browser drops stale local slots under ADR-065.
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

Duplicate speech across devices is an accepted household tradeoff. Printing retains server claims because duplicate physical delivery wastes paper; the two behaviors therefore require different coordination guarantees (`ADR-051`/`ADR-065`).

## Affected capabilities

Printing uses the server decision and browser hardware execution split. Daily Briefing, external Calendar sync and Backups remain server-owned jobs when their owning batches import them. Time Announcements use browser-local scheduling and speech under ADR-065. The [scheduler contract](../contracts/background-jobs-scheduler.md) covers process-local jobs.

## Relationship to ADR-014

This decision substantially shapes `ADR-014` (background job singleton/status ownership): server-side printing jobs use a persisted queue with atomic claim/lease and server-side staleness compaction. `ADR-014` governs process-local concurrency and domain-owned status; this ADR specifies the hardware-bound claim/lease model.

## Acceptance Criteria

- Given two connected tabs, when a print job is queued, then only one holds its active lease. Expiry and reclaim after an unacknowledged send may repeat physical transmission.
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
- Related prior: `ADR-014`
- Related: `ADR-029` (plugins own services), `ADR-005` (household-tz scheduling)
- Peer review: codex-peer-review blind-debate (2026-06-28) — model validated; capability registration, atomic claim, server-side compaction, connected-definition, Bluetooth alert incorporated.
