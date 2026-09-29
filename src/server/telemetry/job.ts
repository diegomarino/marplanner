/** Telemetry retention-prune scheduled-job registration (
 * design/contracts/client-logging-telemetry.md CLIENT-LOGGING-TELEMETRY-INV-09/-AC-04).
 * Mirrors `modules/daily-briefing/job.ts`'s Rule B shape: reaches the scheduler ONLY through the
 * host-api barrel (`../host-api`, `registerJob`) — never `../scheduler/index` directly — even
 * though `src/server/telemetry/` is core infrastructure (like backups) and not one of the
 * import-boundary-linted plugin roots under `src/server/modules/`; the barrel seam is used here
 * by design, not because a lint rule forces it. `./index` (this module's own
 * sibling) is an ordinary same-directory import, not a cross-boundary one.
 */
import { pruneClientLog, agedClientLogRowsExist } from "./index";
import { registerJob } from "../host-api";
import type { StopHandle } from "../host-api";

/** The scheduler job id this module registers under. */
export const TELEMETRY_PRUNE_JOB_ID = "telemetry.prune";

const PRUNE_TIME = "04:30";

/** Register the telemetry retention-prune wall-clock job on the process-wide scheduler singleton
 *. Called once from `src/server/index.ts` startup, alongside
 * `registerDailyBriefingJob`, after `initScheduler` and before `scheduler.start`. The
 * action ignores any invocation arg (a manual `runJobNow` call passes none) and always prunes
 * relative to the real current time — `pruneClientLog`'s `nowMs` default. `isMissed` ignores
 * the scheduler's `date` argument: the retention cutoff is `Date.now`-relative, not tied to a
 * calendar date, so "was today's prune missed" collapses to "are there aged rows right now".
 */
export function registerTelemetryPruneJob(): StopHandle {
  return registerJob({
    id: TELEMETRY_PRUNE_JOB_ID,
    trigger: { kind: "wallClock", at: PRUNE_TIME, isMissed: () => agedClientLogRowsExist() },
    action: () => pruneClientLog(),
  });
}
