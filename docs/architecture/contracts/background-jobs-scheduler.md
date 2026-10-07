# Background Jobs / Scheduler Domain Contract

Status: maintained contract
Depends on decisions: `ADR-014`, `ADR-005`, `ADR-009`, `ADR-029`, `ADR-035`, `ADR-039`, `ADR-040`

## Purpose

A thin **core scheduler primitive** owning the lifecycle contract for recurring
server-side work (spec §1). It fires jobs on a cadence/trigger and provides
concurrency + catch-up rules; it does **not** own job content — each feature/plugin
owns its retry-safe domain action (ADR-029). marplanner is a **single
self-hosted instance**.

## Vocabulary

- **Job** — a registered unit of recurring/startup/manual server-side work.
- **Trigger** — startup / interval tick / household-local wall-clock / manual.
- **Cadence** — fixed interval or household-local wall-clock time (ADR-005).
- **Domain action** — the callable the owning feature provides; must be retry-safe.
- **In-flight guard** — in-process lock preventing a job overlapping itself or a
  manual+scheduled collision.
- **Dispatch queue** — distinct mechanism (ADR-035): persisted work-units that
  _browsers_ atomic-claim for hardware execution. A scheduled job may enqueue into
  it.

## Invariants

1. **BACKGROUND-JOBS-SCHEDULER-INV-01** **Single instance.** No deployment-wide lease; concurrency is an **in-process
   in-flight guard**. (If multi-instance is ever adopted, this and ADR-040 reopen.)
2. **BACKGROUND-JOBS-SCHEDULER-INV-02** A singleton mutating job never overlaps itself; **manual and scheduled
   invocations share one guard / idempotency boundary**.
3. **BACKGROUND-JOBS-SCHEDULER-INV-03** The scheduler owns **no job content** and **no domain status table**; status is
   **domain-owned product state** (ADR-014).
4. **BACKGROUND-JOBS-SCHEDULER-INV-04** Wall-clock jobs fire on **household-local time** (ADR-005), correct across DST
   and host-tz differences.
5. **BACKGROUND-JOBS-SCHEDULER-INV-05** **No lazy-on-read generation** — reads are pure.
6. **BACKGROUND-JOBS-SCHEDULER-INV-06** A multi-step mutating job completes as a recoverable unit or leaves **no
   partial user-visible state** (ADR-009).
7. **BACKGROUND-JOBS-SCHEDULER-INV-07** Plugin jobs run only while the plugin is active; deactivation stops new runs
   and drains in-flight work within the guard (ADR-039).
8. **BACKGROUND-JOBS-SCHEDULER-INV-08** Durable deferred work is a scheduled/queued job, **not** a persisted event
   (ADR-040).

## Behaviors

- **Register / stop:** jobs register after migrations/startup succeed; idempotent
  stop handles run on graceful shutdown.
- **Fire:** on cadence/trigger, run the domain action under the in-flight guard.
- **Catch-up (by job shape):**
  - _Output-producing / date-bearing_ (Daily Briefing, Backups) → **domain-state
    driven**: produce only the missing/overdue output for the household date.
    Backups use this so irregular kiosk uptime never silently skips a backup.
  - _Interval freshness_ (Calendar sync, cache warming) → **run-soon-on-startup,
    then resume cadence**; missed ticks self-heal on next reconcile.
- **Atomicity:** calendar reconcile in a single DB transaction (status metadata
  written separately/always); backups temp-write + atomic rename, prune only after
  a confirmed-good new backup.
- **Observability:** none of its own UI; domains expose status in their panels;
  the global health indicator (ADR-035/Kiosk Shell) aggregates.

## Interfaces

- Job registration API (code/plugin-manifest; ADR-039 manifest declares plugin
  jobs).
- In-flight guard + manual-trigger entry shared with scheduled path.
- May call `enqueue(...)` into the ADR-035 dispatch queue (e.g. print triggers).

## Events

(ADR-040.) The scheduler primitive itself emits/subscribes **no** domain events;
job _actions_ emit their domain's events (owned by those domains). Cross-domain
reactions that need to _trigger_ a job use the event bus at the domain level (a
producer subscribes and acts), not the scheduler.

## Data / Setup Contract

No scheduler-owned lease or status store. Job definitions are code / plugin
manifest. Domain status lives in each domain's namespaced tables. No legacy
scheduler runtime state migrated (ADR-026).

## Acceptance Criteria

- **BACKGROUND-JOBS-SCHEDULER-AC-01** Given a job's previous run is still executing, the next tick is skipped/coalesced.
- **BACKGROUND-JOBS-SCHEDULER-AC-02** Given a manual run during a scheduled run of the same job, they do not run
  concurrently (shared guard).
- **BACKGROUND-JOBS-SCHEDULER-AC-03** Given a wall-clock job, it fires at the household-local time across DST.
- **BACKGROUND-JOBS-SCHEDULER-AC-04** Given the kiosk was off at the backup hour, on next startup the scheduler fires the domain-state catch-up trigger for any job whose window was missed (the backup-creation outcome is the Backups domain action).

<!-- BACKGROUND-JOBS-SCHEDULER-AC-05 moved to calendar.md, AC-06 moved to backups.md (domain-action outcomes, not scheduler's); see boundary-ledger.yaml. -->

- **BACKGROUND-JOBS-SCHEDULER-AC-07** Given an inactive plugin, its jobs acquire no new runs (ADR-039).

## Open Decisions

- Restore quiescing/restart behavior — `ADR-017` (Backups).
- Weekday/recurrence encoding — `ADR-020`. External calendar vocabulary — `ADR-024`.
- Per-domain classification of guarded vs. harmless-to-duplicate jobs — each
  domain's grill.
