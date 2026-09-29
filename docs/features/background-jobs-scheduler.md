# Feature: Background Jobs / Scheduler (the recurring-work primitive)

Behavior reference. The [owning contract](../architecture/contracts/background-jobs-scheduler.md) defines invariants and extension limits.

Background Jobs / Scheduler is a thin **core scheduler primitive**: it owns the lifecycle of
recurring/startup/manual server-side work — when a job fires, the concurrency guard around it, and
the catch-up rules — but it owns **no job content**. Each feature/plugin provides its own retry-safe
domain action; the scheduler never holds domain status or job content of its own. marplanner v2 is a
single self-hosted instance, so concurrency is an in-process in-flight guard, not a deployment-wide
lease.

## Behavior

### User Story 1 — A singleton job never overlaps itself

A recurring mutating job (e.g. calendar sync) is still running when its next tick arrives, or an admin
triggers it manually mid-run; the scheduler skips/coalesces the tick and serializes manual+scheduled
through one shared guard, so the domain action never runs concurrently with itself.

### User Story 2 — A missed wall-clock window catches up on startup

The kiosk was powered off at a job's household-local window. On next startup the scheduler fires the
domain-state catch-up trigger for any job whose window was missed (the produced output — e.g. a backup
— is the owning domain's action), so irregular uptime never silently skips overdue work.

### User Story 3 — A deactivated plugin's jobs stop cleanly

An operator deactivates a plugin; its jobs acquire no new runs and any in-flight run drains within the
guard, with no scheduler-side status table left behind.

### Edge Cases

- A wall-clock job around a DST transition fires at the household-local time, not the host-tz time.
- A multi-step mutating job that fails mid-way leaves no partial user-visible state.
- A read path never triggers generation — reads stay pure.
- Durable deferred work is a scheduled/queued job, never a persisted event row.

## Requirements

### Behavior requirements

- **FR-001**: Given the single self-hosted instance, when job concurrency is controlled, then it MUST be controlled by an in-process in-flight guard, and the scheduler MUST NOT rely on a deployment-wide lease. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-01)_

- **FR-002**: Given a singleton mutating job, when it is invoked on schedule or manually, then it MUST NOT overlap itself, and manual and scheduled invocations MUST share one guard / idempotency boundary. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-02)_

- **FR-003**: Given the scheduler primitive, when a job runs, then the scheduler MUST own no job content and MUST NOT keep a domain status table; job status MUST live as domain-owned product state. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-03)_

- **FR-004**: Given a wall-clock job, when its fire time is computed, then it MUST fire on household-local time and MUST stay correct across DST and host-tz differences. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-04)_

- **FR-005**: Given any read path, when data is read, then it MUST NOT trigger lazy-on-read generation and reads MUST remain pure. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-05)_

- **FR-006**: Given a multi-step mutating job, when it executes, then it MUST either complete as a recoverable unit or, on failure, leave no partial user-visible state. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-06)_

- **FR-007**: Given a plugin job, when scheduling is evaluated, then it MUST run only while the plugin is active — while the plugin is inactive its jobs MUST NOT acquire new runs — and on deactivation new runs MUST stop and in-flight work MUST drain within the guard. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-07)_

- **FR-008**: Given durable deferred work, when it is modeled, then it MUST be a scheduled or queued job and MUST NOT be a persisted event. _(Realizes: BACKGROUND-JOBS-SCHEDULER-INV-08)_

- **FR-009**: Given a job whose previous run is still executing, when the next tick arrives, then that tick MUST be skipped or coalesced (the acceptance surface for the in-flight guard in FR-002/INV-02). _(Realizes: BACKGROUND-JOBS-SCHEDULER-AC-01)_

- **FR-010**: Given a manual run during a scheduled run of the same job, when both are requested, then they MUST NOT run concurrently because they share one guard. _(Realizes: BACKGROUND-JOBS-SCHEDULER-AC-02)_

- **FR-011**: Given a wall-clock job spanning a DST transition, when it fires, then it MUST fire at the household-local time (the acceptance surface for FR-004/INV-04). _(Realizes: BACKGROUND-JOBS-SCHEDULER-AC-03)_

- **FR-012**: Given the kiosk was off at a job's window, when the scheduler next starts up, then it MUST fire the domain-state catch-up trigger for any job whose window was missed, while the produced outcome (e.g. backup creation) remains the owning domain's action. _(Realizes: BACKGROUND-JOBS-SCHEDULER-AC-04)_

- **FR-013**: Given an inactive plugin, when scheduling is evaluated, then its jobs MUST acquire no new runs (the acceptance surface for the plugin-lifecycle invariant in FR-007/INV-07). _(Realizes: BACKGROUND-JOBS-SCHEDULER-AC-07)_

### Key Entities

- **Job**: a registered unit of recurring/startup/manual server-side work — a trigger (startup /
  interval tick / household-local wall-clock / manual), a cadence, and a reference to the owning
  domain's retry-safe action. The scheduler holds the registration, never the job's content or status.
- **In-flight guard**: the in-process lock that prevents a job overlapping itself and serializes a
  manual+scheduled collision through one idempotency boundary.
- **Dispatch queue (referenced, ADR-035)**: a distinct mechanism of persisted work-units that browsers
  atomic-claim for hardware execution; a scheduled job may `enqueue(...)` into it but does not own it.

## Success Criteria

- **SC-001**: A singleton mutating job records 0 self-overlapping runs and 0 concurrent manual+scheduled
  executions across repeated ticks and manual triggers.
- **SC-002**: After any stretch of downtime, every job whose household-local window was missed fires its
  catch-up trigger exactly once on next startup; 0 windows are silently skipped.
- **SC-003**: A deactivated plugin acquires 0 new job runs, and the scheduler holds 0 domain status rows.

## Assumptions

- Each feature/plugin owns its retry-safe domain action and its status tables (ADR-014/ADR-029); this
  spec owns only the firing/guard/catch-up primitive, not job content.
- Household-tz time + DST correctness are provided per ADR-005; multi-step recoverability per ADR-009.
- The moved-out guarantees are realized elsewhere: calendar-reconcile atomicity (AC-05) in
  the Calendar feature owner, and prune ordering/durability (AC-06) in the Backups feature owner.
- No legacy scheduler runtime state is migrated (ADR-026); job definitions are code / plugin manifest.
