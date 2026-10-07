# ADR-022 Generated Output Snapshot & Regeneration Contract

Status: accepted
Owner: product / architecture
Decision date: 2026-06-28

## Decision

Resolved via the Daily Briefing + Printing cluster grill (Q3); the snapshot
principle generalizes to other generated outputs (Meals, Daily Messages,
Weather, etc.).

### Snapshot model (ratified)

A generated output is a **per-subject/date snapshot**: generation reads other
domains' state _at generation time_, records the resulting payload + render
state, and **never silently mutates** when source data changes later (Daily
Briefing spec lines 7, 235, 287). For Daily Briefing: one current snapshot per
member/date, under a **stable briefing ID preserved across regeneration**
(line 21).

### No per-regeneration versioning

Regeneration **replaces the payload in place** under the same ID. There is **no
version history of past payloads** — a household only needs the current output;
"history" is across _dates_, not across regenerations of the same date.

### No staleness tracking

v2 does **not** detect or surface "source data changed since this was
generated." There is no staleness flag, no source-diffing, no
regenerate-suggested prompt. Refresh happens only via **scheduled regeneration +
explicit manual regeneration**. (Anti-over-engineering: staleness detection is
real complexity for near-zero family value.)

### Regeneration and printing are orthogonal

Regeneration and printing are **separate actions**. Regeneration:

- "clears the print acknowledgement (`printedAt`)" — since the producer does not
  own Printing's record (ADR-039), this means: invalidate the producer's local
  derived print status **and** call Printing's `supersedePrintRecord(outputRef,
date)` host API, which also **resets Printing's per-output idempotency** so the
  regenerated output is re-printable (resolves the peer-review root cause;
  consistent with ADR-019);
- **cancels any pending OR claimed-not-yet-fetched print job** for that output
  (revokes the claim), so a stale, about-to-be-replaced artefact never prints —
  including a job already atomically claimed (ADR-035) but not yet fetched;
- does **not** auto-enqueue a print. Printing is governed by the normal triggers
  (scheduled / event / manual, Q1); a mid-day regeneration is reprinted manually.

### Which artefact prints

The print job binds to the _output_ (subject/date); the executing browser
**fetches the artefact at send time** ("fetch-at-execute"). A print therefore
never emits something older than what is current at the moment it prints. This is
race-free precisely because the artefact is immutable until explicit
regeneration, and regeneration cancels the pending job (so a superseded version
has no live job pointing at it).

### Shared block cache

The once-per-date shared-content cache (e.g. `onThisDay`, quote-of-day; Daily
Briefing spec lines 16, 222) is retained as a generation optimization,
invalidated only at date rollover / regeneration — consistent with
no-staleness-tracking.

## Rationale

The snapshot model and ADR-019's "success = transmitted" reinforce each other:
immutability-until-explicit-regen makes fetch-at-execute safe and removes any
"which version was queued?" race, which is why versioning is unnecessary. Keeping
regeneration and printing orthogonal honors "no surprise paper" and matches a
family kiosk where the admin is present to reprint when they regenerate.

## Affected Specs

- `docs/rewrite-spec/11-daily-briefing.md` — snapshot, regeneration, shared cache
- `docs/rewrite-spec/13-printing-pipeline.md` — fetch-at-execute, regen cancels
  pending jobs, `printedAt` cleared on regen
- Generalizes to other generated-output domains (Meals, Daily Messages, Weather)

## Data / Setup Implications

Fresh deployment: one current row per subject/date (stable ID, replaced in place); no
payload version table; no staleness metadata. No legacy import (ADR-026).

## Acceptance Criteria

- Given source data changes after generation, then the existing snapshot is
  unchanged until an explicit regeneration.
- Given a regeneration, then `printedAt` is cleared and any pending print job for
  that output is cancelled.
- Given a regeneration, then no print is automatically enqueued.
- Given a print executes, then it emits the artefact current at send time.
- Given the system, then it exposes no staleness flag or "source changed" signal.

## Open Questions

- Per-domain regeneration triggers for non-briefing generated outputs — handled
  when those domains are grilled (principle inherited from here).

## Traceability

- Related prior: `ADR-022`
- Related: `ADR-019` (printedAt/idempotency), `ADR-035` (job claim/cancel),
  `ADR-008` (block order applies to future generation), `ADR-027` (per-user
  opt-in), `ADR-040` (outcome events)
- Domain grill: `../domain-grills/daily-briefing-printing.md` (Q3)
