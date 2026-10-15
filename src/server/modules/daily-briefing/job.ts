/** Daily-briefing scheduled-job registration (
 * docs/architecture/contracts/daily-briefing.md DAILY-BRIEFING-AC-10). Imports ONLY the
 * host-api barrel (`../../host-api/index.ts`, Rule B / ADR-039 §2b′ /
 * Constitution VIII) — never `../../scheduler/index` or `../../db/client`
 * directly, so the import-boundary lint polices this file exactly
 * like every other plugin root. `./index` (this plugin's own module) is a
 * sibling import, not a cross-boundary one.
 * (FR-012/FR-021): extends the single wall-clock
 * job above into THREE 012-scheduler registrations — the main pass, and two
 * failed-block retry passes at +15/+30 minutes — plus a re-arm hook
 * (`rearmDailyBriefingSchedule`) the settings write path (`./settings.ts`)
 * calls after a `generation_time` edit actually lands.
 */
import { DailyBriefingValidationError, generateAllBriefings, generateBriefing } from "./index";
import {
  getDb,
  isActiveMember,
  readSettingsObject,
  registerJob,
  todayInHouseholdTz,
} from "../../host-api";
import type { StopHandle } from "../../host-api";
import { registerAutoPrintTrigger } from "./trigger";
import { isBriefingScheduledOn } from "./schedule";

/** The scheduler job ids this module registers under. */
export const DAILY_BRIEFING_JOB_ID = "daily-briefing.generate-all";
export const DAILY_BRIEFING_RETRY_15_JOB_ID = "daily-briefing.retry-15";
export const DAILY_BRIEFING_RETRY_30_JOB_ID = "daily-briefing.retry-30";

/** the two failed-block retry passes fire this many minutes after the main pass. */
const RETRY_OFFSET_MINUTES_15 = 15;
const RETRY_OFFSET_MINUTES_30 = 30;

/** Failed-block retry candidates: anything short of a fully-clean pass (FR-021). */
const RETRYABLE_STATUSES = ["partial", "failed", "render-failed"] as const;

const DEFAULT_BRIEFING_TIME = "06:00";
const SETTINGS_OBJECT_NAME = "daily-briefing";
/** Strict "HH:MM", 00:00–23:59 — the same shape `nextOccurrenceInTz` expects. */
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** the real settings table (`daily_briefing_settings`, `./settings.ts`'s * `readSettings`/`updateSettings`) — read here via a raw query rather than importing
 * `./settings.ts` itself, to avoid a needless import cycle (`./settings.ts` imports THIS
 * module's `rearmDailyBriefingSchedule`, below, to trigger the re-arm after a write). The
 * column is already validated (strict HH:MM) by `./settings.ts`'s own `validateGenerationTime`
 * on every write, so no re-validation is needed on this read side. Returns `undefined` when no
 * row exists yet — the caller (`getBriefingTime`) falls back to the legacy seam below.
 */
function readGenerationTimeFromSettingsTable(): string | undefined {
  const row = getDb()
    .prepare("SELECT generation_time FROM daily_briefing_settings WHERE id = 1")
    .get() as { generation_time: string } | undefined;
  return row?.generation_time;
}

/** time seam: the household-local wall-clock time generation should run at.
 * the `daily_briefing_settings` row (`./settings.ts`, the REAL admin-facing
 * schedule setting — `PUT /api/daily-briefing/settings`'s `generationTime`, FR-022) now takes
 * precedence once it has ever been written; a legacy `daily-briefing` `settings_objects` row
 * (the -era placeholder seam, predating the real settings surface — "No settings UI
 * or registration lands this module" per that slice's own spec Assumption 1) is consulted only
 * as a fallback while the new table has never been written, so a deployment that seeded the old
 * key before landed keeps working, and every pre-019 test that only ever exercised the old
 * `settings_objects` seam stays green unchanged. The instant `./settings.ts`'s `updateSettings`
 * writes its own table, THIS function switches to reading it — precisely why the settings write
 * path's re-arm hook (`rearmDailyBriefingSchedule`, below) is required: the scheduler would
 * otherwise keep firing at whatever time was captured at registration (* fold — the 012 scheduler captures `trigger.at` at registration time and exposes no update op).
 * Defensive against a malformed legacy row: an unparseable JSON blob or an out-of-shape
 * `generationTime` (not a valid "HH:MM") would otherwise NaN its way into a `RangeError` and
 * brick boot — both cases fall back to the default instead of throwing. The
 * new table's column is written only through `./settings.ts`'s own strict validator, so it never
 * needs the same defensive re-check.
 */
export function getBriefingTime(): string {
  const fromSettingsTable = readGenerationTimeFromSettingsTable();
  if (fromSettingsTable !== undefined) {
    return fromSettingsTable;
  }

  const raw = readSettingsObject(SETTINGS_OBJECT_NAME);
  if (raw !== undefined) {
    let persisted: Record<string, unknown>;
    try {
      persisted = JSON.parse(raw);
    } catch {
      return DEFAULT_BRIEFING_TIME;
    }
    if (
      typeof persisted.generationTime === "string" &&
      HHMM_PATTERN.test(persisted.generationTime)
    ) {
      return persisted.generationTime;
    }
  }
  return DEFAULT_BRIEFING_TIME;
}

/** Add `minutesToAdd` (a small positive offset, well under 24h) to a strict "HH:MM" time-of-day
 * string, wrapping past midnight. The wallClock trigger only ever stores a time-of-day — it has
 * no notion of "which calendar date" the wrap lands on, so this never needs household-tz/DST
 * awareness itself; `nextOccurrenceInTz` (the scheduler core) resolves the next matching
 * household-local instant for whatever "HH:MM" it is given, exactly like it does for the main
 * pass's own `at`.
 */
function addMinutesToTime(time: string, minutesToAdd: number): string {
  const [hours, minutes] = time.split(":").map(Number);
  const totalMinutes = (hours * 60 + minutes + minutesToAdd) % (24 * 60);
  const wrappedHours = Math.floor(totalMinutes / 60);
  const wrappedMinutes = totalMinutes % 60;
  return `${String(wrappedHours).padStart(2, "0")}:${String(wrappedMinutes).padStart(2, "0")}`;
}

/** Catch-up predicate: TRUE when at least one
 * ACTIVE, OPTED-IN member is missing a `daily_briefing` row for `date`.
 * Deliberately PER-MEMBER — never `COUNT == 0` — so one member's early or
 * manual generation can never mask the rest of the household still being
 * unmissed for the day: a household-wide count would go false the instant a
 * SINGLE row exists, stranding every other opted-in member until the next
 * calendar day (a different household date). Opted-out members are
 * excluded by construction (the opt-in query only returns enabled rows);
 * archived members are excluded by the `isActiveMember` re-check on each
 * candidate — an opt-in row survives archive (module `index.ts`), so this
 * predicate must not treat a stale opt-in as still eligible.
 * Only the MAIN pass registers this: the retry passes have no startup catch-up of
 * their own — a same-date row missing entirely is the main pass's concern (DAILY-BRIEFING-AC-10),
 * not a "failed block" the retry passes are scoped to repair.
 */
export function isMissed(date: string): boolean {
  const db = getDb();
  const optedIn = db
    .prepare("SELECT member_id FROM daily_briefing_optin WHERE enabled = 1")
    .all() as Array<{ member_id: string }>;

  return optedIn.some(({ member_id: memberId }) => {
    if (!isActiveMember(memberId)) return false;
    if (!isBriefingScheduledOn(memberId, date)) return false;
    const row = db
      .prepare("SELECT 1 FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get(memberId, date);
    return row === undefined;
  });
}

/** Extract the optional `{ date }` invocation arg the manual entry point
 * (`runJobNow`, US2) passes through the shared guard. Scheduled and
 * catch-up fires never pass an arg — `generateAllBriefings(undefined)`
 * resolves "today" itself via the household timezone.
 */
function extractDate(arg: unknown): string | undefined {
  if (arg && typeof arg === "object" && "date" in arg) {
    const date = (arg as { date?: unknown }).date;
    return typeof date === "string" ? date : undefined;
  }
  return undefined;
}

/** Retry members whose existing briefing is partial, failed or render-failed.
 * The generator rebuilds each complete ordered block set using current settings;
 * it does not preserve successful blocks from the earlier pass. An intervening
 * admin reorder therefore applies to the retry. Shared external caches still bound
 * provider requests, and deterministic corpus selection uses the same date/member.
 * Eligibility is rechecked by generateBriefing before committing each result.
 */
export async function regenerateFailedBriefings(requestedDate?: string): Promise<void> {
  const date = requestedDate ?? todayInHouseholdTz(Date.now());
  const candidates = getDb()
    .prepare(
      `SELECT member_id FROM daily_briefing
       WHERE date = ? AND status IN (${RETRYABLE_STATUSES.map(() => "?").join(", ")})
       ORDER BY member_id ASC`
    )
    .all(date, ...RETRYABLE_STATUSES) as Array<{ member_id: string }>;

  for (const { member_id: memberId } of candidates) {
    if (!isActiveMember(memberId)) continue;
    if (!isBriefingScheduledOn(memberId, date)) continue;
    try {
      await generateBriefing(memberId, date);
    } catch (err) {
      if (!(err instanceof DailyBriefingValidationError)) throw err;
      // A concurrent archive/opt-out made this candidate ineligible between the main pass and
      // this retry — skip it, mirroring `generateAllBriefings`'s own per-candidate containment.
    }
  }
}

/** Builds and registers the THREE household-tz wall-clock jobs this module owns: the main
 * generation pass at `getBriefingTime`, and the two failed-block retry passes at +15/+30
 * minutes. Separated from `registerDailyBriefingJob` (below) so the re-arm hook
 * can stop and rebuild ONLY these three — never the auto-print trigger's own sweep job, which has
 * no time-of-day dependency and must not be disturbed by a `generation_time` edit.
 */
function registerGenerationSchedule(): StopHandle {
  const at = getBriefingTime();
  const mainJob = registerJob({
    id: DAILY_BRIEFING_JOB_ID,
    trigger: { kind: "wallClock", at, isMissed },
    action: (arg?: unknown) => generateAllBriefings(extractDate(arg)),
  });
  const retry15Job = registerJob({
    id: DAILY_BRIEFING_RETRY_15_JOB_ID,
    trigger: { kind: "wallClock", at: addMinutesToTime(at, RETRY_OFFSET_MINUTES_15) },
    action: (arg?: unknown) => regenerateFailedBriefings(extractDate(arg)),
  });
  const retry30Job = registerJob({
    id: DAILY_BRIEFING_RETRY_30_JOB_ID,
    trigger: { kind: "wallClock", at: addMinutesToTime(at, RETRY_OFFSET_MINUTES_30) },
    action: (arg?: unknown) => regenerateFailedBriefings(extractDate(arg)),
  });
  return {
    stop: async () => {
      await Promise.all([mainJob.stop(), retry15Job.stop(), retry30Job.stop()]);
    },
  };
}

/** The currently-registered generation-schedule StopHandle, if any (module singleton — one server process, one scheduler). */
let activeGenerationSchedule: StopHandle | null = null;

/** re-arm hook (fold): the 012 scheduler captures `trigger.at` at
 * registration (`src/server/scheduler/index.ts`'s `armWallClock`) and exposes no update
 * operation, so an edited `generation_time` would otherwise keep firing at the OLD time until
 * process restart. `./settings.ts`'s `updateSettings` calls this — fire-and-forget, deliberately
 * NOT awaited there (see that call site's own comment) — after a `generationTime` change actually
 * lands, so `updateSettings` keeps its existing synchronous return shape for its one HTTP caller
 * (`routes/daily-briefing.ts`'s `PUT /api/daily-briefing/settings`, out of this module's file
 * scope). Stops the three generation-schedule jobs (drains any in-flight run) and re-registers
 * them against the NEW `getBriefingTime` value — relies on the scheduler-core deregister fix
 * (`src/server/scheduler/index.ts`'s `disposeJob`, this same task) that lets the SAME job ids be
 * registered again after a stop. A no-op if this process never registered the schedule in the
 * first place (defensive — boot always calls `registerDailyBriefingJob` before any settings
 * write is reachable in practice, but a unit test that calls `updateSettings` directly without
 * ever registering the job must not throw here).
 */
export async function rearmDailyBriefingSchedule(): Promise<void> {
  if (!activeGenerationSchedule) return;
  try {
    await activeGenerationSchedule.stop();
    activeGenerationSchedule = registerGenerationSchedule();
  } catch (err) {
    console.error("daily-briefing.job.rearm-failed", err);
  }
}

/** Register the daily-briefing scheduled jobs on the process-wide scheduler
 * singleton. Called once from `src/server/index.ts` startup,
 * after `initScheduler` and before `scheduler.start` (extends the * wiring). Scheduled/catch-up fires pass no invocation arg; the manual
 * `POST /api/daily-briefing/generate-all` route (US2) will
 * pass `{ date }` through this same guarded entry.
 * (FR-017/FR-018): the auto-print trigger's three wakeup paths
 * (wakeup-hint subscription, periodic sweep, startup evaluation — `./trigger.ts`) are wired
 * through this SAME already-wired entry point rather than a new call site in `src/server/
 * index.ts` — this function is the daily-briefing module's one call from core boot, so piggy-
 * backing here keeps the trigger's registration inside the plugin's own root, matching every
 * other host-api-barrel-only registration in this codebase (mirrors telemetry's/backups' own
 * `register*Job` precedent one file over). `registerAutoPrintTrigger` now registers its own
 * scheduler job (`AUTO_PRINT_SWEEP_JOB_ID`, batch-C) and returns a REAL
 * `StopHandle` from `registerJob`, so combining the two is a plain sequential await — both halves
 * are scheduler jobs with the identical stop semantics (clear the timer, await in-flight/pending).
 * the single generation job above is now THREE registrations (main
 * + two retry passes, `registerGenerationSchedule`) tracked via the module-level
 * `activeGenerationSchedule` singleton so `rearmDailyBriefingSchedule` (above) can stop and rebuild
 * exactly this half on a `generation_time` edit, leaving the auto-print trigger untouched.
 */
export function registerDailyBriefingJob(): StopHandle {
  const schedule = registerGenerationSchedule();
  activeGenerationSchedule = schedule;
  const autoPrintTrigger = registerAutoPrintTrigger();
  return {
    stop: async () => {
      await schedule.stop();
      if (activeGenerationSchedule === schedule) {
        activeGenerationSchedule = null;
      }
      await autoPrintTrigger.stop();
    },
  };
}
