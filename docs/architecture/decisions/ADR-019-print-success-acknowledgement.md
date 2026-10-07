# ADR-019 Print Success Acknowledgement & Idempotency

Status: accepted
Owner: architecture / product
Decision date: 2026-06-28

## Decision

### Server is canonical; client-localStorage truth is eliminated

v2 has a **single source of truth** for "did this print": the server-side print
record. The legacy split-brain — server `daily_briefing.printed_at` (exists but
never called by web code) vs. client `localStorage.printedToday` (the de facto
marker) — is removed. The client holds no authoritative print state, no local
queue-as-truth, no `printedToday` flag. This resolves the spec's flagged
must-fix (13-printing-pipeline.md line 26) and the regenerate/manual divergence
bugs (lines 223–224).

### The canonical record lives in Printing's namespace

The print-job / attempt record is owned by the **Printing plugin's namespaced
tables** (ADR-039), not hung on the Daily-Briefing-owned `daily_briefing` row as
in legacy (line 275). It holds: job id, output ref, status, attempts, errorCode,
byteCount, and `printedAt`. This is producer-agnostic — the same record shape
serves a future "print today's calendar" producer (Q1 cluster model).

### Success definition

**Success = the artefact was successfully transmitted to a connected, ready
printer** (the transport byte-write completed over an established connection).
That is the last fact the planner can verify. **Physical print outcome — paper
out, jam, cut-then-late-failure — is explicitly out of the planner's scope**;
Web Bluetooth thermal printers expose no reliable paper-level acknowledgement
(lines 165, 221). Recovery for a physical failure is a human action (manual
reprint, Q1), not a tracked system state. No `printedAt` ever claims something
the software did not witness.

### `printedAt` and idempotency

- `printedAt` = the server-stamped timestamp when the executing browser
  acknowledges a successful send.
- Idempotency is **server-side per job/output-date**, guarded by ADR-035's
  atomic claim — replacing the legacy client per-member/date suppression. The
  Q1 trigger does not enqueue a duplicate for an output/date already marked
  printed.
- The rare double-print on crash-after-send-before-ack is the **already-accepted
  ADR-035 at-least-once trade**: an unacked job re-issues on lease expiry. No
  separate "printed but ack-failed" state is introduced; misses are covered by
  manual reprint.

### Outcome flows to producers via events (ADR-040)

Printing emits `printing.completed{jobId, outputRef}` / `printing.failed{...}`.
Producers learn the result by subscribing; they do **not** own `printedAt`. Daily
Briefing's "printed at HH:MM" history is a **derived** reflection (updated via
the event or by querying Printing's interface). If Printing is inactive, print
status is simply unavailable — absence-tolerant per ADR-039 (and uninstalling
Printing drops its print history with its tables).

Because the event bus is at-most-once (ADR-040), a dropped `printing.completed`
across a reboot can leave the derived value stale; producers **recover by
querying Printing's host API** for the canonical record when the derived value is
absent (the read stays pure). Resetting the printed mark on regeneration is done
via Printing's **`supersedePrintRecord(outputRef, date)`** host API (a producer
never writes Printing's namespace, ADR-039), which also resets per-output
idempotency so the regenerated output is re-printable.

## Rationale

All legacy double-print / missed-print bugs trace to two independently
authoritative idempotency stores. ADR-035 already provides a single server-side
claim as the coordination point; making it also the idempotency truth gives
"did this print?" exactly one answer. Relocating the record into Printing's
namespace lets that one answer serve any producer. Defining success as what the
software can verify (transmission) rather than what it cannot (paper) keeps the
contract honest and pushes physical-failure recovery to the human, which is
appropriate for a family kiosk.

## Affected Specs

- `docs/rewrite-spec/13-printing-pipeline.md` — success rule, acknowledgement,
  idempotency store, record ownership
- `docs/rewrite-spec/11-daily-briefing.md` — derived printed-status, no
  `printed_at` ownership

## Data / Setup Implications

Fresh deployment: print records live in Printing's namespaced tables; no `printed_at`
column on the briefing row; no client localStorage authority. No legacy import
(ADR-026).

## Acceptance Criteria

- Given a successful transmission to a connected printer, then the server stamps
  `printedAt` and emits `printing.completed`.
- Given a transmission that never reaches a connected/ready printer, then no
  `printedAt` is stamped and the job retries/dead-letters per ADR-035.
- Given paper runs out after a successful send, then the system still reports
  success (out of scope) and the human uses manual reprint.
- Given an output/date already marked printed, then the trigger does not enqueue
  a duplicate (server-side idempotency).
- Given Printing is inactive, then a producer's printed-status is unavailable
  rather than erroring.

## Open Questions

- Which snapshot prints vs. regeneration/staleness clearing `printedAt` — Q3 of
  the cluster (ADR-022 interaction).

## Traceability

- Related prior: `ADR-019`
- Related: `ADR-035` (claim/at-least-once/idempotency), `ADR-040` (outcome
  events), `ADR-039` (namespace ownership, absence-tolerance), `ADR-009`
  (atomicity), `ADR-022` (regeneration — Q3)
- Domain grill: `../domain-grills/daily-briefing-printing.md` (Q2)
- Peer review: not separately run; builds on peer-reviewed ADR-035 + ADR-040.
  Cluster contracts (Printing, Daily Briefing) to be reviewed when written.
