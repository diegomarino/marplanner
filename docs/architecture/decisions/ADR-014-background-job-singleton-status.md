# ADR-014 Background Job Scheduler: Single-Instance Concurrency & Status

Status: accepted
Owner: architecture / ops
Decision date: 2026-06-28
Supersedes: an earlier multi-instance draft of this decision (deployment-wide
lease), which contradicted ADR-040's single-instance premise and over-built for a
deployment topology marplanner does not have.

## Decision

### Deployment premise: single instance

marplanner runs as a **single server instance** (one self-hosted family
kiosk). This is the premise the rest of the architecture already assumes —
ADR-040's in-memory event bus, ADR-035's _browser_-side atomic claim (multiple
browsers, one server), and the family-kiosk threat/scale model. There is no
horizontal scaling or multi-instance/HA deployment. (If that ever changes, this
decision **and** ADR-040 must be reopened together — the in-memory bus would need
a broker.)

### Scope

Background Jobs / Scheduler is a thin **core scheduler primitive** owning the
**lifecycle contract for recurring server-side work** (spec §1): registration,
cadence (interval / household-local wall-clock), triggers (startup / interval /
wall-clock / manual), stop handles, startup catch-up, and failure surfacing. It
does **not** own job content — each feature/plugin owns its job's domain action
(ADR-029), which must be retry-safe per its own idempotency rules.

### Concurrency: in-process guard, no distributed lease

A singleton mutating job must not overlap **itself**. This is enforced by an
**in-process in-flight guard** (a slow run still executing when the next tick
fires is skipped/coalesced). There is **no persisted deployment-wide lease** —
with one instance there is no second process to coordinate with, so a lease would
guard a boundary that does not exist.

Browser-contended **hardware dispatch** keeps ADR-035's atomic claim/lease: that
is a genuine multi-client case (many browsers, one server), distinct from
server-side recurring jobs.

### Manual and scheduled share one boundary

Manual and scheduled invocations of the same logical job go through the **same
execution path and the same in-flight guard / idempotency boundary** — a manual
sync cannot run concurrently with a scheduled sync of the same source (resolves
the spec's open manual-vs-scheduled question, lines 100/116).

### Status & observability: domain-owned, not a scheduler layer

The scheduler does **not** maintain a separate persisted run-status table. Where
operational status matters, the **owning domain persists it as product state**
(e.g. calendar source `lastSyncAt` / `lastError` / `consecutiveFailures`, which
already exist). The global health indicator (ADR-035 / Kiosk Shell) aggregates
domain-reported status. Best-effort in-memory `lastRunAt`/`lastError` for
diagnostics is allowed but not durable (consistent with ADR-040's calibration).

### Catch-up: domain-state-driven

Startup catch-up is driven by **domain state, not a scheduler log**: a date-
bearing job generates what is _missing_ for the household-local date (e.g. absent
briefing rows for active opted-in members), subject to staleness/threshold rules.
This generalizes beyond Daily Briefing to any date-bearing job that can detect
its own missing output. There are **no lazy-on-read generation triggers** (dropped
with the printing cluster; reads are pure).

### Timezone & lifecycle

Wall-clock jobs fire on **household-local time** (ADR-005), fixing the legacy
host-local `Date#setHours` bug. Recurring jobs start only after migrations/startup
succeed and stop on graceful shutdown (idempotent stop handles). Plugin jobs run
only while the plugin is active; deactivation stops new runs and drains in-flight
work within the guard (ADR-039).

## Rationale

The legacy scheduler used process-local timers/guards. For a single-instance v2
that is _almost_ the right model already — it only needs the host-local-timezone
bug fixed, a consistent in-flight guard shared by manual+scheduled runs, and
domain-owned status for visibility. A persisted deployment-wide lease would be
complexity defending against a second instance that does not exist, and it
contradicts ADR-040. Keeping status domain-owned avoids inventing a scheduler
persistence layer that duplicates product state domains already keep.

## Affected Specs

- [background-jobs-scheduler](../../features/background-jobs-scheduler.md)
- [calendar](../../features/calendar.md), [daily-briefing](../../features/daily-briefing.md), [backups](../../features/backups.md),
  [network-devices](../../features/network-devices.md) (each owns its job content + status)

## Data / Setup Implications

No scheduler-owned lease/status store. Job _definitions_ are code/plugin-manifest
(ADR-039). Domain status lives in each domain's namespaced tables. No legacy
scheduler runtime state migrated (ADR-026).

## Acceptance Criteria

- Given a singleton mutating job whose previous run is still executing, when the
  next tick fires, then the new run is skipped/coalesced (in-process guard).
- Given a manual invocation while a scheduled run of the same job is in flight,
  then the manual run shares the guard and does not run concurrently.
- Given a wall-clock job, then it fires at the configured household-local time
  (ADR-005), correct across DST and host-tz differences.
- Given a missed date-bearing run, when the server starts, then it generates only
  the missing output for the household-local date (domain-state-driven catch-up).
- Given a job's operational status matters, then the owning domain persists it and
  the health indicator surfaces it; the scheduler keeps no separate durable log.
- Given an inactive plugin, then its jobs acquire no new runs; in-flight work
  drains per ADR-039.

## Open Questions

- Per-domain classification of which jobs need the in-flight guard vs. are
  harmless to duplicate — settled in each domain's grill.
- Restore quiescing/restart behavior — owned by `ADR-017` (Backups).
- Weekday/recurrence encoding — `ADR-020`. External calendar vocabulary —
  `ADR-024`.

## Traceability

- Conflicts: `CR-014`
- Related prior: `ADR-014`
- Related: `ADR-005`, `ADR-009`, `ADR-017`, `ADR-020`, `ADR-024`, `ADR-029`,
  `ADR-035` (browser dispatch claim), `ADR-039`, `ADR-040` (single-instance bus)
