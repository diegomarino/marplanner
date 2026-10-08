# Feature: Printing (producer-agnostic delivery pipeline)

Behavior reference. The [owning contract](../architecture/contracts/printing.md) defines invariants and extension limits.

Printing is a plugin that provides a general, producer-agnostic delivery pipeline:
it takes a printable raster from any producer, converts it to device-specific bytes
(ESC/POS for the configured paper width/transport), and delivers it to a connected
printer. It owns readiness, queueing, device conversion, delivery, attempt records,
and success acknowledgement — but owns no producer content and holds no
producer-specific knowledge. Daily Briefing is its only producer in this system.

## User workflows

### User Story 1 — Print an output to a connected printer

A trigger enqueues an output; a capability-registered browser claims the job and
fetches printer-ready bytes. The server obtains the producer's current raster and
wraps it as ESC/POS (ADR-066); the browser sends the bytes over the established
connection. On a successful byte write the server stamps `printedAt` and
emits `printing.completed`, so "did this print" has a single server-side answer.

### User Story 2 — Tolerate an absent or unready printer

With no connected/ready printer, a recoverable report accepted by `/fail` releases
the lease and increments `attempts`. Network failures during payload fetch, or
failure reports that cannot reach the server, instead wait for the 120-second
lease to expire without updating the reason or incrementing `attempts`. The
current-date job can retry without a numeric attempt limit; earlier household
dates and permanent failures are dead-lettered. No
`printedAt` is stamped. Physical paper outcomes (jam / out) are out of scope and recovered by a
human manual reprint, which re-enqueues the current output.

### User Story 3 — Regenerate and re-print a superseded output

A producer regenerates an output and calls `supersedePrintRecord(outputRef, date)`;
the canonical print record is superseded (re-printable) and any pending or
claimed-not-yet-fetched job for that output is cancelled, so the regenerated output
can be printed again without a stale duplicate slipping through.

### Edge Cases

- Two connected tabs racing for the same job: one claimant per active lease; later expiry/reclaim can repeat a lost-acknowledgement transmission.
- An output already printed for the date: the trigger does not enqueue a duplicate.
- A crash after send but before ack: rare double-print is the accepted at-least-once trade.
- An output incompatible with the available device: an absence-tolerant skip, not a forced print.
- The Printing plugin is inactive: no jobs enqueue or claim; a mid-lease job drains then stops.

## Requirements

### Functional Requirements

- **FR-001**: Given a printable raster and a device render context, when the pipeline processes a job, then it MUST remain producer-agnostic and MUST NOT know that the raster depicts a briefing (or any specific producer's content). Contract: PRINTING-INV-01.

- **FR-002**: Given the question "did this print", when it is answered, then the server MUST be the single source of truth and client-localStorage MUST NOT hold any authority over the answer. Contract: PRINTING-INV-02.

- **FR-003**: Given a print record, when it is stored, then it MUST live in Printing's namespace and Printing MUST NOT read a producer's tables, and when the raster is needed at execute it MUST be fetched via the producer's interface. Contract: PRINTING-INV-03.

- **FR-004**: Given a job, when the bytes have been written to a connected, ready printer, then success MUST be defined as that completed transmission, and the physical paper outcome (jam / out) MUST be treated as out of scope with recovery left to a human manual reprint. Contract: PRINTING-INV-04.

- **FR-005**: Given an output already printed for a date, when a trigger fires, then only one claimant MUST hold the active lease via the atomic claim and the system MUST NOT enqueue a duplicate, and when `supersedePrintRecord(outputRef, date)` is called the per-output/date idempotency MUST be reset so the regenerated output is re-printable, and a rare double-print on crash-after-send-before-ack MAY occur as the accepted ADR-035 at-least-once trade. Contract: PRINTING-INV-05.

- **FR-006**: Given the question of whether printing is available at all, when it is determined, then availability MUST be defined as the Printing plugin being active, and the system MUST provide no master switch and no `autoPrint` flag. Contract: PRINTING-INV-06.

- **FR-007**: Given an output incompatible with the available device, when it is encountered, then it MUST be treated as an absence-tolerant skip (unavailable) and MUST NOT be forced to print. Contract: PRINTING-INV-07.

- **FR-008**: Given a successful transmission to a connected printer, when it completes, then `printedAt` MUST be stamped and `printing.completed` MUST be emitted. Contract: PRINTING-AC-01.

- **FR-009**: Given no connected/ready printer, when a job is processed, then `printedAt` MUST NOT be stamped and the job MUST retry/dead-letter per ADR-035. Contract: PRINTING-AC-02.

- **FR-010**: Given paper runs out after a successful send, when the outcome is reported, then the system MUST still report success (out of scope) and the human MUST use manual reprint to recover. Contract: PRINTING-AC-03.

- **FR-011**: Given two connected tabs, when they contend for one job, then only one MUST hold the active lease; expiry/reclaim can repeat an unacknowledged send (per ADR-035). Contract: PRINTING-AC-04.

- **FR-012**: Given an output already printed for the date, when the trigger fires, then it MUST NOT enqueue a duplicate. Contract: PRINTING-AC-05.

- **FR-013**: Given the Printing plugin is inactive, when triggers and claims are attempted, then new jobs MUST NOT be enqueued or claimed, and a job already claimed at deactivation MUST complete its current lease then stop and MUST be invisible everywhere except `admin/plugins`. Contract: PRINTING-AC-06.

- **FR-014**: Given a future producer rendering to the device render context, when it delivers a raster, then delivery MUST be unchanged. Contract: PRINTING-AC-07.

- **FR-015**: Given a producer calls `supersedePrintRecord` on regeneration, when it is processed, then the print record MUST be superseded (re-printable) and any pending or claimed-not-yet-fetched print job MUST be cancelled; already-fetched bytes MAY finish transmitting, but their acknowledgement MUST NOT mark the replacement generation printed. Contract: PRINTING-AC-08.

### Key Entities

- **Print job**: one unit of delivery work for one output (subject/date), owned in
  Printing's namespace. Attributes: job id, output ref, status, attempts, errorCode,
  byteCount, printedAt. At most one pending job per output.
- **Output ref**: a producer-agnostic reference to what is being printed.
- **Device render context**: a Printing-owned descriptor of the target device's
  capabilities/constraints (`paperWidthDots` now; extensible), passed to producers at
  render time.
- **Transport**: the delivery channel (Bluetooth now; wifi/usb future union arms),
  expressed via the `printerTransport` discriminated-union settings object.
- **Print attempt record**: the per-attempt outcome (errorCode, attempts, byteCount,
  printedAt) in Printing's namespaced tables.

## Success Criteria

- **SC-001**: 100% of successful transmissions stamp `printedAt` server-side and emit
  `printing.completed`; the server is the only authority for "did this print".
- **SC-002**: For any output/date already printed, 0 duplicate jobs are enqueued, and a
  `supersedePrintRecord` call makes that output re-printable.
- **SC-003**: With two or more connected tabs contending, each job has at most one
  claimant holding a valid active lease (0 concurrent double-claims). After lease
  expiry, another tab may reclaim the job; a lost acknowledgement can therefore
  cause duplicate physical transmission.

## Assumptions

- Atomic claim, retry/dead-letter, staleness compaction, and lease-drain semantics are
  provided per ADR-035.
- The producer owns its content and exposes a raster-fetch interface invoked at execute
  (ADR-041/ADR-022); Printing reads no producer tables.
- Settings are provided via ADR-028 (`printer` with `paperWidthDots`, plus
  `printerTransport` with Bluetooth now); there is no master/`autoPrint` key.
- Fresh data store; no legacy import (ADR-026). Uninstall drops Printing's tables
  including print history (ADR-039).
