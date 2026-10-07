# Printing Domain Contract

Status: maintained contract
Depends on decisions: `ADR-019`, `ADR-021`, `ADR-022`, `ADR-028`, `ADR-035`, `ADR-038`, `ADR-039`, `ADR-040`, `ADR-041`, `ADR-066`

## Purpose

Printing is a **plugin** (ADR-029) providing a **general, producer-agnostic
delivery pipeline**: it takes a printable raster from any producer, converts it
to device-specific bytes, and delivers it to a connected printer. It owns
readiness, queueing, device conversion, delivery, attempt records, and success
acknowledgement. It owns **no producer content** and holds no producer-specific
knowledge. Daily Briefing is its only producer in this system; others (e.g. Calendar) are
additive.

## Vocabulary

- **Print job** — one unit of delivery work for one output (subject/date),
  owned in Printing's namespace.
- **Output ref** — producer-agnostic reference to what is being printed.
- **Device render context** — Printing-owned descriptor of the target device's
  capabilities/constraints (`paperWidthDots` now; extensible; ADR-041), passed to
  producers at render time.
- **Transport** — delivery channel (Bluetooth now; additional transports are undecided).
- **printedAt** — server-stamped timestamp of a successful transmission.
- **errorCode** — closed permanent-failure vocabulary:
  `render_failure | unsupported_transport | secure_context`. Recoverable failures
  carry a free-text reason and an attempt count, not a permanent code.

## Invariants

1. **PRINTING-INV-01** The pipeline is **producer-agnostic**: it receives a printable raster + a
   device render context; it never knows the raster depicts a briefing (ADR-041).
2. **PRINTING-INV-02** **Server is the single source of truth** for "did this print" (ADR-019); no
   client-localStorage authority.
3. **PRINTING-INV-03** The print record lives in **Printing's namespace** (ADR-039); Printing never
   reads a producer's tables (it fetches the raster via the producer's interface
   at execute — ADR-041/ADR-022).
4. **PRINTING-INV-04** **Success = successfully transmitted to a connected, ready printer** (byte
   write completed). Physical paper outcome (jam/out) is **out of scope**;
   recovery is human manual reprint (ADR-019).
5. **PRINTING-INV-05** Exactly-once dispatch via ADR-035 atomic claim; **idempotency is server-side
   per output/date** — no duplicate enqueue for an already-printed output. This
   idempotency is **reset by `supersedePrintRecord(outputRef, date)`** (called by
   the producer on regeneration, ADR-022), so a regenerated output is
   re-printable. Rare double-print on crash-after-send-before-ack is the accepted
   ADR-035 at-least-once trade.
6. **PRINTING-INV-06** "Printing available at all" = the **Printing plugin is active** (ADR-038/029).
   There is no master switch and no `autoPrint` flag; "automatic" is an active
   automatic trigger bound by the producer (Q1).
7. **PRINTING-INV-07** An output incompatible with the available device is an **absence-tolerant
   skip** (unavailable), not a forced print (ADR-041).

## Behaviors

- **Enqueue:** a trigger (time/manual/event; Q1) calls the producer-agnostic
  `enqueue(outputRef)`. At most one pending job per output (invariant 5).
- **Deliver (UI-bound, ADR-035):** a capability-registered browser claims a job,
  fetches final printer-ready bytes from the server and sends them over the
  established connection. At payload fetch, the server obtains the producer's
  **current raster** through its registered provider (ADR-041/ADR-022) and
  Printing wraps it as ESC/POS (ADR-066).
- **Acknowledge:** on successful transmission the server stamps `printedAt` and
  emits `printing.completed`. Permanent failures carry `errorCode`; recoverable
  failures record their reason and increment `attempts`.
- **Retry / dead-letter:** recoverable failures release the lease and increment
  `attempts`; the current-date job is immediately claimable again, without a
  numeric attempt limit. Jobs from earlier household dates become dead-lettered;
  permanent failures (`render_failure`, `unsupported_transport`,
  `secure_context`) dead-letter immediately; `attempts` increments on recoverable
  failure only. Queued jobs are **delivery work, not history** — pruned by
  ADR-035 staleness compaction / date rollover.
- **Manual reprint:** a manual trigger re-enqueues the current output (recovery
  for physical failures, invariant 4).
- **Connection loss:** surface a visible alert (ADR-035); reconnect to a
  remembered device needs no gesture, re-pair after factory reset needs a tap.

## Interfaces

- `enqueue(outputRef)` — producer-agnostic, called by triggers.
- `supersedePrintRecord(outputRef, date)` — invalidates the canonical print
  record for an output so it is re-printable; called by a producer on
  regeneration (ADR-022). Keeps Printing producer-agnostic (it learns nothing
  about _why_, only that the record is superseded).
- Provide the **device render context** to producers at render time (ADR-041).
- Settings objects (ADR-028): `printer` (`paperWidthDots`) + `printerTransport`
  (flat Bluetooth pairing fields: `deviceId`, `name`, `serviceUuid`,
  `characteristicUuid`; all-empty means unpaired). Nested `type`/`config`
  payloads are rejected as `invalid_settings`. No master/autoPrint keys.
- Admin: pair device, test print, print attempt log / history.

## Events

(ADR-040; in-memory, at-most-once, post-commit, immutable payload.)

- **Emits:**
  - `printing.completed { jobId, outputRef, printedAt }`.
  - `printing.failed { jobId, outputRef, errorCode }` on permanent failure only.
    Recoverable failures persist their reason and attempt count without an event.
- **Subscribes:**
  - None required in this system (triggers call `enqueue` directly; a future event-based
    trigger has the _producer_ subscribe and enqueue, not Printing — ADR-040).

## Data / Setup Contract

Fresh deployment: print job/attempt records (job id, output ref, status, attempts,
errorCode, byteCount, printedAt) in Printing's namespaced tables. `printer`
settings object via ADR-028 with Bluetooth transport. No `printed_at` on producer
rows. Inactive plugin → no settings object, no services (ADR-029/038). Uninstall
drops Printing's tables incl. print history (ADR-039). No legacy import (ADR-026).

## Acceptance Criteria

- **PRINTING-AC-01** Given a successful transmission to a connected printer, `printedAt` is stamped
  and `printing.completed` emitted.
- **PRINTING-AC-02** Given no connected/ready printer, no `printedAt`; job retries/dead-letters per
  ADR-035.
- **PRINTING-AC-03** Given paper runs out after a successful send, the system still reports success
  (out of scope); the human uses manual reprint.
- **PRINTING-AC-04** Given two connected tabs, exactly one claims a job (ADR-035).
- **PRINTING-AC-05** Given an output already printed for the date, the trigger does not enqueue a
  duplicate.
- **PRINTING-AC-06** Given the Printing plugin is inactive, no new jobs are enqueued or claimed; a
  job already claimed at deactivation completes its current lease then stops
  (ADR-035/plugin-system drain semantics); it is invisible everywhere except
  `admin/plugins` (ADR-038).
- **PRINTING-AC-07** Given a future producer rendering to the device render context, delivery is
  unchanged.
- **PRINTING-AC-08** Given a producer calls `supersedePrintRecord` on regeneration, the print record is superseded (re-printable) and any pending or claimed-not-yet-fetched print job is cancelled. _(split from DAILY-BRIEFING-AC-02; see boundary-ledger.yaml.)_

## Open Decisions

- Full device-context + transport-union schema beyond Bluetooth/`paperWidthDots`
  — added when a second device/transport exists.

## Peer Review

codex-peer-review blind-debate (2026-06-28), reviewed jointly with the Daily
Briefing contract. No critical/over-engineering findings. Incorporated:
`supersedePrintRecord` host API (resets per-output idempotency on regen),
idempotency-reset note, `secure_context` added to errorCode vocab, inactive-plugin
criterion tightened to lease-drain semantics, settings aligned to ADR-028
`printer` + `printerTransport` (dropped `enabled`/`autoprint`).
