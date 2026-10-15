# Feature: Daily Briefing (snapshot generation, render, print trigger)

Behavior reference. The [owning contract](../architecture/contracts/daily-briefing.md) defines invariants and extension limits.

Daily Briefing is the v2 **print producer** plugin (ADR-041): it generates a
per-member/date **snapshot** of household content, renders it to a device-independent
printable raster, and exposes it for viewing and printing. It owns _what_ is printed
and _when its output is triggered_; it does not own delivery, and it does not own
the Printing record. A briefing is an immutable snapshot under a stable ID —
refreshed only by explicit regeneration — and generation is opt-in per member.

## User workflows

### User Story 1 — Scheduled generation of a member's briefing

At the household-configured time (in the household timezone), the server-scheduled job
generates each opted-in active member's briefing for the current business date: it reads
the source domains once, renders blocks in isolation, derives a status, and renders the
printable raster when Printing is active. A run missed across a restart is caught up on
startup for the same date.

### User Story 2 — View and reprint after regeneration

A parent views a member's briefing and its derived printed-status. After an admin
regenerates the briefing (same stable ID, payload replaced in place), the local derived
print status is invalidated and no auto-print occurs; a subsequent print trigger can
re-enqueue because Daily Briefing called Printing's `supersedePrintRecord`.

### User Story 3 — Eligibility and degraded-environment reads

Generation produces a briefing only for active members with the opt-in enabled; a child
without opt-in gets no briefing. When the Printing plugin is inactive, content is still
generated (viewable) but the raster is skipped (not printable) and printed-status is
reported as unavailable rather than an error. A read of a never-generated briefing returns
not-generated without creating a row, and a read recovers canonical printed-status from
Printing when the local derived value was lost.

### User Story 4 — Admin page: pause, history, regenerate, view and print

A parent pauses a member's briefing on chosen weekdays, browses that member's last 30 briefings,
regenerates any date, opens its image, and sends it to the printer queue on demand. A paused
weekday produces no briefing and no automatic print; a manual regenerate on that day reports that
the member is paused instead of generating.

### Edge Cases

- A single block failing does not abort the run: surviving blocks render and the status
  reflects survivors (`partial` / `failed` / `render-failed` / `ready`).
- A `printing.completed` event dropped across a reboot (at-most-once bus) leaves the
  derived value absent; the read falls back to Printing's host API.
- A regenerated raster must never be printed by an in-flight job claimed before regeneration.
- A corpus-absent block offers no language selector and never degrades to English.

## Requirements

### Functional Requirements

- **FR-001**: Given source data in another domain changes after a briefing was generated, when no regeneration has occurred, then the snapshot MUST remain unchanged and MUST refresh only via explicit regeneration, never silently mutating on the later source change. Contract: DAILY-BRIEFING-INV-01.

- **FR-002**: Given a regeneration of an existing briefing, when the payload is replaced, then the briefing ID MUST remain stable, the payload MUST be replaced in place, and per-regeneration version history MUST NOT be retained. Contract: DAILY-BRIEFING-INV-02.

- **FR-003**: Given concurrent generation requests for the same member/date, when rows are written, then there MUST be exactly one current row per member/date and a `pending` reservation MUST prevent duplicate rows under concurrency. Contract: DAILY-BRIEFING-INV-03.

- **FR-004**: Given a member, when briefing generation is considered, then it MUST proceed only if that member has opted in, because briefing generation is opt-in per user. Contract: DAILY-BRIEFING-INV-04.

- **FR-005**: Given a briefing payload, when block order and repetition are determined, then they MUST be owned by Daily Briefing as an ordered list of block instances in which a type may appear multiple times, and they MUST NOT be governed by an App Setting. Contract: DAILY-BRIEFING-INV-05.

- **FR-006**: Given a block being rendered, when it is structural copy (labels/templates) it MUST render in the household language via keys, and when it is corpus-backed a per-block `language` override MAY select an available corpus variant (default household when available, otherwise English; explicit unavailable overrides are rejected) frozen with the effective language in the snapshot at generation time, then a block without a corpus MUST have no language override and MUST render in the household language with no English degradation for corpus absence. Contract: DAILY-BRIEFING-INV-06.

- **FR-007**: Given a block fails during generation, when other blocks are processed, then the failed block MUST be recorded, the remaining blocks MUST continue, and status MUST be derived from survivors — `render-failed` on render failure with surviving data, `failed` when no block survives, `partial` when some survive, and `ready` when all enabled blocks succeed. Contract: DAILY-BRIEFING-INV-07.

- **FR-008**: Given a generated briefing, when its render artefact is stored, then Daily Briefing MUST own that artefact in its own namespace, MUST NOT own `printedAt`, and printed status MUST be derived. Contract: DAILY-BRIEFING-INV-08.

- **FR-009**: Given generation runs, when business dates are computed, then they MUST respect the household timezone. Contract: DAILY-BRIEFING-INV-09.

- **FR-010**: Given source data changes after generation, when no regeneration has occurred, then the snapshot MUST be unchanged until regeneration. Contract: DAILY-BRIEFING-AC-01.

- **FR-011**: Given a dropped `printing.completed` event left the local derived printed-status absent, when a read is performed, then the read MUST recover the canonical printed-status by querying Printing's host API. Contract: DAILY-BRIEFING-AC-04.

- **FR-012**: Given the Printing plugin is inactive, when generation runs, then it MUST still produce content but MUST skip the printable raster, so the briefing is viewable but not printable. Contract: DAILY-BRIEFING-AC-05.

- **FR-013**: Given a block with no corpus, when it is configured and rendered, then a language selector MUST NOT be offered and it MUST render in the household language, never English-degraded for corpus absence. Contract: DAILY-BRIEFING-AC-06.

- **FR-014**: Given a corpus-backed block, when its language selector is presented and a variant is chosen, then the selector MUST offer only languages with an available corpus and the chosen corpus variant MUST be frozen in the snapshot. Contract: DAILY-BRIEFING-AC-07.

- **FR-015**: Given a missing briefing, when a read is performed, then it MUST return not-generated without creating a row. Contract: DAILY-BRIEFING-AC-08.

- **FR-016**: Given a block fails, when generation continues, then the other blocks MUST still render and the status MUST reflect survivors. Contract: DAILY-BRIEFING-AC-09.

- **FR-017**: Given the Printing plugin is inactive, when printed-status is requested, then it MUST be reported as unavailable and MUST NOT be treated as an error. Contract: DAILY-BRIEFING-AC-11.

- **FR-018**: Given a scheduled generation time in the household timezone, when that time arrives, then generation MUST run then, or on startup catch-up if the same-date run was missed. Contract: DAILY-BRIEFING-AC-10.

- **FR-019**: Given a regeneration, when the briefing is replaced, then the snapshot ID MUST be preserved, Daily Briefing's local derived print status MUST be invalidated, and the regeneration MUST NOT auto-print. Contract: DAILY-BRIEFING-AC-12.

- **FR-020**: Given a regeneration after a successful print, when a subsequent trigger fires, then it MUST be able to re-enqueue because Daily Briefing called Printing's `supersedePrintRecord`, where the per-output idempotency reset is Printing's guarantee consumed here. Contract: DAILY-BRIEFING-AC-03.

- **FR-021**: Given an active parent with Daily Briefing opt-in, when Daily Briefing generation runs, then that parent MUST be eligible for a briefing. Contract: MEMBERS-AC-05.

- **FR-022**: Given an active child without Daily Briefing opt-in, when Daily Briefing generation runs, then a briefing MUST NOT be generated for that child. Contract: MEMBERS-AC-06.
- **FR-023**: Given a member's weekday schedule, when one of their weekdays is switched off, then scheduled, catch-up, retry and Generate-all generation MUST skip that member on that weekday and the auto-print trigger MUST NOT evaluate them; a member with no stored schedule runs every day. Contract: none (admin parity, 2026-10-15).
- **FR-024**: Given a manual generate for a member paused on that date's weekday, then no row MUST be written and the API MUST answer `200 {skipped: true, reason: "paused", memberId, date}`. Contract: none (admin parity).
- **FR-025**: Given a schedule write, then weekdays MUST be canonical tokens (stored in mon..sun order, duplicates collapsed, an empty list allowed), the member MUST be active, unknown body fields MUST be rejected, and the write MUST NOT regenerate or invalidate any briefing. Contract: none (admin parity).
- **FR-026**: Given a history read for a member, then it MUST return the household business date and at most 30 of the member's briefings, newest date first, without writing. Contract: none (admin parity).
- **FR-027**: Given a manual print of a stored briefing, then Daily Briefing MUST enqueue it through Printing's producer seam under the record key `daily-briefing:<memberId>:manual:<date>` with the household today as target date and the dated output reference, MUST reuse a job still waiting, MUST supersede and re-enqueue a record already printed, MUST NOT change the automatic print's dedup or the briefing's derived printed-status, and MUST refuse with 404 (no briefing), 409 `plugin_inactive`, 409 `printable_raster_missing` or 400 (inactive member, bad date). Contract: none (admin parity).
- **FR-028**: Given a preview read while a generation for that member/date is in flight and no PNG is stored, then it MUST answer `202 {status: "rendering"}`; a stored PNG is served even during a regeneration. Contract: none (admin parity).

### Key Entities

- **Briefing**: a per-member/date snapshot with a stable ID across regeneration; one current
  row per member/date. Holds the payload and the printable raster in Daily Briefing's
  namespace; no `printed_at` column (that is Printing's record per ADR-019).
- **Payload**: a versioned envelope — schema version, member identity snapshot, date, and an
  ordered list of block instances (block order/repetition owned here, ADR-008/ADR-044).
- **Block instance**: one configured content unit in the ordered list; a type may repeat, and
  a corpus-backed instance carries an optional `language` override.
- **Shared daily block cache**: one generated payload per date + shared block type, reused
  across members.
- **Status**: `pending | ready | partial | failed | render-failed`, derived from surviving blocks.
- **Member schedule**: the weekdays on which a member's briefing runs, stored with the opt-in (NULL = every day); pausing a weekday never deletes existing briefings.

## Success Criteria

- **SC-001**: A generated briefing is unchanged by later source-domain changes; only an explicit
  regenerate alters it, preserving the stable ID with no version history.
- **SC-002**: Generation produces briefings for exactly the active, opted-in members — a child
  without opt-in receives none.
- **SC-003**: With Printing inactive, content generates and remains viewable, the raster is skipped,
  and printed-status reads as unavailable rather than erroring.
- **SC-004**: After regeneration, a subsequent trigger can re-enqueue a print and no auto-print occurs.

## Assumptions

- Printing is a separate domain that owns the Printing record, per-output idempotency, and job
  supersession; Daily Briefing consumes its `supersedePrintRecord` host API and `printing.*` events
  (ADR-019/039/041).
- The event bus is in-memory, at-most-once, post-commit (ADR-040); reads tolerate a dropped event by
  querying Printing's host API.
- Business-date and timezone primitives are provided per ADR-005; the generation job is a persisted
  scheduled job per ADR-035.
- Fresh data store; no legacy import (ADR-026).

## Current retry behavior

Scheduled retry passes select already-generated rows in partial, failed or
render-failed states. Each selected member receives a complete regeneration using
current block settings and order. Successful blocks from the original pass are
not carried forward independently. A settings reorder between passes therefore
applies to the retry. External daily caches still bound repeated provider calls.
