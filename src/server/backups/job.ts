/** Backups nightly-snapshot scheduled-job registration ( ADR-042).
 * Mirrors `../telemetry/job.ts`'s Rule B shape: reaches the scheduler ONLY through the host-api
 * barrel (`../host-api`, `registerJob`) — never `../scheduler/index` directly — even though
 * `src/server/backups/` is core infrastructure (peer of `../scheduler/`, `../telemetry/`), not a
 * plugin root under `src/server/modules/`; the barrel seam is used here by design, matching the
 * telemetry precedent, not because the import-boundary lint forces it. `./storage` (this
 * plugin's own sibling module) is an ordinary same-directory import, not a cross-boundary one.
 */
import { createSnapshot, hasBackupForDate, BACKUP_HOUR } from "./storage";
import { registerJob } from "../host-api";
import type { StopHandle } from "../host-api";

/** The scheduler job id this module registers under — shared by BOTH the scheduled wall-clock
 * fire and the manual "snapshot now" entry point (`POST /api/backups/snapshot` ->
 * `runJobNow(BACKUPS_JOB_ID, { source: "snapshot" })`), so the scheduler's own per-job in-flight
 * guard serializes scheduled-vs-manual for free (clarify Q5). */
export const BACKUPS_JOB_ID = "backups.nightly";

/** Extract the filename-prefix `type` a given invocation should tag its snapshot with (* design decision 2 / FR-005): the manual "snapshot now" route passes `{ source: "snapshot" }`
 * through `runJobNow`; a scheduled fire or a startup catch-up sweep pass NO argument at all, so
 * the default is `"scheduled"`.
 */
function extractType(arg: unknown): "scheduled" | "snapshot" {
  if (arg && typeof arg === "object" && "source" in arg) {
    const source = (arg as { source?: unknown }).source;
    if (source === "snapshot") return "snapshot";
  }
  return "scheduled";
}

/** Register the nightly backup wall-clock job on the process-wide scheduler singleton. Called
 * once from `src/server/index.ts` startup, alongside `registerDailyBriefingJob`/
 * `registerTelemetryPruneJob`, after `initScheduler` and before `scheduler.start`.
 * `isMissed(date)` = no scheduled/snapshot backup file whose filename-encoded household-local
 * date equals `date` (the "string prefix test", `storage.ts`'s `hasBackupForDate`).
 * Unlike daily-briefing's per-member predicate or telemetry's row-existence predicate — both
 * vacuously FALSE on a brand-new install — a fresh instance has ZERO backup files, so this
 * predicate is genuinely TRUE on first boot: a kiosk that boots for the very first time (or
 * after being off through last night's backup hour) correctly gets an immediate catch-up
 * snapshot, by design (US1 "the kiosk was off at that hour... the next startup catches up").
 */
export function registerBackupsJob(): StopHandle {
  return registerJob({
    id: BACKUPS_JOB_ID,
    trigger: { kind: "wallClock", at: BACKUP_HOUR, isMissed: (date) => !hasBackupForDate(date) },
    action: (arg?: unknown) => createSnapshot(extractType(arg)),
  });
}
