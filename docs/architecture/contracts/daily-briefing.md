# Daily Briefing Domain Contract

Status: maintained contract
Depends on decisions: `ADR-005`, `ADR-008`, `ADR-019`, `ADR-022`, `ADR-027`, `ADR-028`, `ADR-035`, `ADR-039`, `ADR-040`, `ADR-041`, `ADR-044`, `ADR-015`

## Purpose

Daily Briefing is a **plugin** (ADR-029) that generates a per-member/date
**snapshot** of household content (routines, messages, reminders, meals,
calendar, weather, etc.), renders it to a printable artefact, and exposes it for
viewing/printing. It is the only **print producer** in v2 (Printing is a general
pipeline; ADR-041). It owns _what_ is printed and _when its output is triggered_;
it does not own delivery.

## Vocabulary

- **Briefing** — a per-member/date snapshot (stable ID across regeneration).
- **Payload** — versioned envelope: schema version, member identity snapshot,
  date, **ordered list of block instances** (ADR-008 block order owned here).
- **Block instance** — one configured content unit in the ordered list. A block
  **type may repeat** (ADR-044); each instance carries its own config including an
  optional **`language`** (default = household language).
- **Block** — one content unit; may be member-specific or shared.
- **Shared daily block cache** — one generated payload per date + shared block
  type, reused across members.
- **Printable raster** — device-independent 1-bit receipt image the briefing
  renders (ADR-041); stored in Daily Briefing's namespace.
- **Status** — `pending | ready | partial | failed | render-failed`.

## Invariants

1. **DAILY-BRIEFING-INV-01** A briefing is a snapshot: it reads other domains **at generation time** and
   never silently mutates on later source changes (ADR-022). Refresh only via
   regeneration.
2. **DAILY-BRIEFING-INV-02** The briefing **ID is stable across regeneration**; regeneration replaces the
   payload in place. **No per-regeneration version history** (ADR-022).
3. **DAILY-BRIEFING-INV-03** Per-member/date uniqueness: one current row per member/date; a `pending`
   reservation prevents duplicate rows under concurrency.
4. **DAILY-BRIEFING-INV-04** Briefing generation is **opt-in per user** (ADR-027).
5. **DAILY-BRIEFING-INV-05** Block order **and repetition** are owned by Daily Briefing (ADR-008/ADR-044),
   never an App Setting. The payload is an ordered list of block instances; a type
   may appear multiple times.
6. **DAILY-BRIEFING-INV-06** **Structural copy** (labels/templates) always renders in the **household language**
   via keys (ADR-015). A **per-block `language` override exists only for corpus-backed
   blocks** (ADR-044) and offers only languages with an available corpus; it selects the
   corpus variant (default household), generated at generation time and frozen in the
   snapshot (ADR-022). Blocks **without a corpus** have no language override and render
   in the household language — **no English degradation for corpus absence** (the
   English fallback is only for a missing translation _key_, a build bug).
7. **DAILY-BRIEFING-INV-07** A block failure is isolated: record the failed block, continue others, derive
   status from survivors. Render failure with surviving data → `render-failed`;
   no surviving block → `failed`; some survive → `partial`; all enabled blocks
   succeed → `ready`.
8. **DAILY-BRIEFING-INV-08** Daily Briefing **owns its render artefact** in its namespace (ADR-039/041);
   it does not own `printedAt` (ADR-019) — printed status is **derived**.
9. **DAILY-BRIEFING-INV-09** Generation respects household timezone for business dates (ADR-005).

## Behaviors

- **Generate:** server-scheduled at a household-configured time in household tz
  (persisted ADR-035 job), plus **startup catch-up** for a missed same-date run,
  plus admin regenerate. **No lazy-on-read generation** — reads are pure.
- **Render:** content → device-independent printable raster at the device render
  context's width (ADR-041); per-block render isolation per invariant 6. If the
  Printing plugin is **inactive** (no device render context available), the
  render step is **skipped** — the briefing is content-ready (status from data
  blocks) but has **no printable raster** and is not printable until Printing is
  active and the briefing is (re)generated.
- **Regenerate:** replace payload/raster in place under the stable ID; set
  `pending`. "Clearing `printedAt`" (ADR-019/022) means two explicit operations,
  since DB does not own Printing's record (invariant 7, ADR-039): (a) **invalidate
  the local derived print status**, and (b) **call Printing's
  `supersedePrintRecord(outputRef, date)` host API** so the regenerated output is
  re-printable (resets Printing's per-output idempotency). Also **cancel any
  pending OR claimed-not-yet-fetched print job** for the output (revoke the
  claim) so an in-flight job cannot print the regenerated raster (ADR-022). Does
  **not** auto-print.
- **Read (view/history):** pure; a missing briefing returns "not generated / not
  scheduled", never a side effect. Derived printed-status: if the local derived
  value is absent (e.g. a `printing.completed` event dropped across a reboot —
  the bus is at-most-once, ADR-040), the read **queries Printing's host API** for
  the canonical record (absence-tolerant, ADR-039; keeps the read pure).
- **Trigger printing:** Daily Briefing binds its output to triggers (time /
  event / manual; Q1). "Automatic printing" = an active automatic trigger is
  bound; there is no `autoPrint` flag.

## Interfaces

- Generate / regenerate (admin; single member or **all active members with
  briefing opt-in enabled** — ADR-027, not role/child-gated).
- Read briefing payload + status (member/date); history across dates.
- Provide current printable raster to Printing **at execute** (host-mediated;
  ADR-041 fetch-at-execute).
- Register settings objects (block schedule, block order, opt-in) via ADR-028.

## Events

(ADR-040; in-memory, at-most-once, post-commit, immutable payload.)

- **Emits:**
  - `daily_briefing.generated { memberId, date, status }` — when a briefing
    finishes generation/render.
  - (optional) `daily_briefing.regenerated { memberId, date }`.
- **Subscribes:**
  - `printing.completed { jobId, outputRef }` / `printing.failed { jobId,
outputRef, errorCode }` — to update derived printed-status (ADR-019).
  - Future: a core domain event (e.g. `routines.morning_completed`) to drive an
    event-based print trigger (subscribe-and-enqueue; ADR-040). Not built in v2.

## Data / Setup Contract

Fresh v2: per-member/date rows under a stable briefing ID; payload + printable
raster live in Daily Briefing's namespaced tables (no `printed_at` column; that
is Printing's record per ADR-019). Shared daily cache per date. Opt-in defaults
per ADR-027. No legacy import (ADR-026).

## Acceptance Criteria

- **DAILY-BRIEFING-AC-01** Given source data changes after generation, the snapshot is unchanged until
  regeneration.
- **DAILY-BRIEFING-AC-12** Given regeneration, the snapshot ID is preserved, Daily Briefing's local derived
  print status is invalidated, and no auto-print occurs. _(split from AC-02; the Printing-record
  supersede / re-printable / job-cancel guarantee is PRINTING-AC-08. See boundary-ledger.yaml.)_
- **DAILY-BRIEFING-AC-03** Given a regeneration after a successful print, a subsequent trigger can
  re-enqueue because Daily Briefing called Printing's `supersedePrintRecord`; the per-output idempotency reset is Printing's guarantee, consumed here.
- **DAILY-BRIEFING-AC-04** Given a dropped `printing.completed` event, a read recovers the canonical
  printed-status by querying Printing.
- **DAILY-BRIEFING-AC-05** Given the Printing plugin is inactive, generation still produces content but
  skips the printable raster (briefing viewable, not printable).
- **DAILY-BRIEFING-AC-06** Given a block with no corpus, no language selector is offered and it renders in the
  household language (never English-degraded for corpus absence).
- **DAILY-BRIEFING-AC-07** Given a corpus-backed block, the language selector offers only languages with an
  available corpus; the chosen corpus variant is frozen in the snapshot (ADR-044/22).
- **DAILY-BRIEFING-AC-08** Given a missing briefing, a read returns not-generated without creating a row.
- **DAILY-BRIEFING-AC-09** Given a block fails, other blocks still render and status reflects survivors.
- **DAILY-BRIEFING-AC-11** Given the Printing plugin is inactive, printed-status is unavailable (not an
  error).
- **MEMBERS-AC-05** Given an active parent with Daily Briefing opt-in, when Daily Briefing generation runs, then the parent can be eligible. _(carried from Members; Daily Briefing owns eligibility, ADR-027.)_
- **MEMBERS-AC-06** Given an active child without Daily Briefing opt-in, when Daily Briefing generation runs, then no briefing is generated for that child. _(carried from Members.)_
- **DAILY-BRIEFING-AC-10** Given a scheduled generation time in household tz, generation runs then (or on
  startup catch-up if missed same-date).

## Open Decisions

- Per-block weekday schedule details and block parameter validation — Daily
  Briefing settings (ADR-028 schemas); refine when block catalogue is specced.
- `ADR-006` strict date validation (shared).

## Peer Review

codex-peer-review blind-debate (2026-06-28), reviewed jointly with the Printing
contract. No critical/over-engineering findings. Incorporated: regen-clears-
`printedAt` mechanism made explicit (supersede host API + derived-cache
invalidation), regen cancels claimed-not-yet-fetched jobs, read-time fallback
query for dropped print events, render skipped when Printing inactive,
regenerate-all targets opted-in active members (ADR-027 not child-gated).
