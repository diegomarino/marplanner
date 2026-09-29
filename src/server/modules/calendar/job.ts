import { getDb, registerJob, type StopHandle } from "../../host-api";
import {
  startExternalSourceSynchronization,
  type CalendarFeedDependencies,
} from "./sync-coordinator";

export const CALENDAR_FEED_POLL_JOB_ID = "calendar.external-sources.poll";
const MINUTE_MS = 60_000;

/** Evaluate persisted source policy on every sweep; synchronization stamps last_attempt_at. */
export async function sweepCalendarFeeds(
  now = Date.now(),
  dependencies: CalendarFeedDependencies = {}
): Promise<void> {
  const due = getDb()
    .prepare(
      `SELECT id FROM calendar_external_sources
       WHERE enabled = 1
         AND (last_attempt_at IS NULL OR last_attempt_at <= ? - poll_interval_min * ?)
       ORDER BY id`
    )
    .all(now, MINUTE_MS) as Array<{ id: string }>;

  await Promise.all(due.map(({ id }) => startExternalSourceSynchronization(id, dependencies)));
}

/** One scheduler registration for all sources; the scheduler drains an active sweep on stop. */
export function registerCalendarFeedJob(dependencies: CalendarFeedDependencies = {}): StopHandle {
  return registerJob({
    id: CALENDAR_FEED_POLL_JOB_ID,
    trigger: { kind: "interval", everyMs: MINUTE_MS },
    action: () => sweepCalendarFeeds(Date.now(), dependencies),
  });
}
