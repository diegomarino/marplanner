/** Auto-print trigger ( FR-017/FR-018, "Trigger
 * evaluation"). A v1-semantics PORT: a level-triggered predicate over CURRENT morning-chore
 * state, never an edge reaction to a single completion event (v1's own deliberate replacement of
 * edge-triggered enqueue — see rationale). v2 relocates the evaluator server-side and
 * replaces v1's three localStorage dedup layers with 018's `print_records UNIQUE(record_key,
 * target_date)` — this module holds NO persistent queue of its own (Key Entities "Trigger
 * binding": "Dedup state IS Printing's record").
 * Imports ONLY the host-api barrel (`../../host-api`, Rule B / ADR-039 §2b′) plus this plugin's
 * own sibling modules (`./settings`, `./index`) — never a core module directly (import-boundary
 * lint).
 */
import {
  enqueuePrintJob,
  getBoard,
  getDb,
  hasTerminalFailedJob,
  isActiveMember,
  isPrintingPluginActive,
  registerJob,
  subscribe,
  todayInHouseholdTz,
  writeClientLog,
} from "../../host-api";
import type { StopHandle } from "../../host-api";
import type { BoardColumn } from "../../../shared";
import { readSettings } from "./settings";
import { listOptIns } from "./index";
import { isBriefingScheduledOn } from "./schedule";

const PRINTABLE_RECORD_KEY_PREFIX = "daily-briefing";

/** Telemetry producer identity — mirrors `modules/weather/
 * port.ts`the `TELEMETRY_PRODUCER_ID` precedent: a synthetic string, never a real device/API key
 * id, used ONLY as `writeClientLog`'s flood-window bucket key (no FK, no column stores it).
 */
const TELEMETRY_PRODUCER_ID = "system:daily-briefing-trigger";

/** v1 POLL_MS parity (spec Clarifications "trigger's periodic-sweep cadence"): "at
 * most 60 seconds between evaluations while the server runs". Exported so a test can assert the
 * DEFAULT itself never exceeds the spec's bound, without needing to drive a real (or fake) timer.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Synchronous DB check for "does member/date already have a printable raster stored" (FR-018 gate
 *). A direct query, not `readBriefing` — 010's `rowToBriefing` never selects the raster
 * columns (they aren't part of the `Briefing` read model), and this module is the raster
 * columns' OWNING plugin, so a direct `getDb` read here is the sanctioned pattern (same as the
 * printable provider in `./index.ts`) rather than a Rule-B bypass.
 */
function hasPrintableRaster(memberId: string, date: string): boolean {
  const row = getDb()
    .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { raster_bits: Buffer | null } | undefined;
  return row !== undefined && row.raster_bits !== null;
}

/** FR-017's predicate: the 'morning' day-period (SCHEMA-ENFORCED stable id, drizzle/0003's
 * `day_periods.id CHECK IN (...)` — never `labelKey`, which is locale-dependent), keyed off the
 * member's board column, has at least one chore and every chore complete for `date`.
 * Two DISTINCT absence cases (batch-C) — conflating them would misreport a
 * routine, benign state as the spec's AC-4 anomaly:
 * - No board COLUMN at all: `getBoard` only returns active CHILDREN
 * (`routines/index.ts` `listActiveChildren`) — an opted-in ADULT member (or any member not a
 * routines participant) simply never has a column. Expected, not anomalous: `console.warn`
 * (this codebase's precedent for a recorded-but-unremarkable state, e.g. `auth/reconcile.ts`),
 * never the AC-4 "loud" telemetry.
 * - A column exists but has no 'morning' period: THIS is spec Acceptance Scenario 4 / FR-017's
 * "a missing morning period is recorded loudly and evaluates false" — a genuine data anomaly
 * (the day-period is schema/migration-seeded and should always exist), `console.error`.
 */
function evaluateMorningComplete(board: BoardColumn[], memberId: string, date: string): boolean {
  const column = board.find((entry) => entry.memberId === memberId);
  if (!column) {
    console.warn("daily-briefing.trigger.board-column-missing", { memberId, date });
    return false;
  }
  const morning = column.dayPeriods.find((period) => period.id === "morning");
  if (!morning) {
    // English, machine-actionable log (repo convention — no plugin telemetry seam is
    // load-bearing here; a console.error mirrors existing src/server error-path logging, see
    //./render/bridge.ts's identical convention for the render-layer's own anomaly).
    console.error("daily-briefing.trigger.morning-period-missing", { memberId, date });
    return false;
  }
  return morning.chores.length > 0 && morning.chores.every((chore) => chore.completed);
}

/** Per-member evaluation body (FR-018 gate + the FR-017 predicate). Gates // (trigger
 * binding active, opt-in, Printing plugin active) are checked ONCE by the caller
 * (`evaluateAutoPrintTrigger`) before this runs for anybody.
 * (batch-C): the predicate is evaluated BEFORE the raster-existence gate —
 * the gate-then-predicate pseudo-code orders them the other way, but that ordering
 * governs GATING (both branches are silent no-ops there), not LOGGING. The raster-missing case is
 * the ONLY loud gate (FR-018), and spec Acceptance Scenario 5 frames it as "a COMPLETED morning
 * but the member's briefing has no printable raster" — i.e. the log is meant to fire on the
 * anomalous combination (morning genuinely done, raster absent), not on every ordinary
 * before-06:00 sweep for a household that simply hasn't finished its chores yet. Checking the
 * (pure, side-effect-free) predicate first changes no enqueue outcome — swapping two no-op guards
 * is order-commutative — it only changes WHEN the loud log fires, from "every sweep, every
 * opted-in member, every night" (~360×N lines) down to "only once morning is actually complete
 * and something is still wrong".
 * a FIFTH check, AFTER the raster gate — `hasTerminalFailedJob`
 * (host-api, `modules/printing/index.ts`). `enqueuePrintJob`'s dedup deliberately does NOT treat
 * a dead-lettered (`failed`) job as "already handled" (an admin's manual retry must stay
 * reachable), so without this gate a level-triggered evaluation would re-enqueue a doomed job on
 * EVERY sweep, forever. This gate binds only THIS caller — printing's own enqueue semantics, and
 * the admin-remedy path (supersede, or a direct re-enqueue), are untouched: either creates a NEW,
 * more-recent job row, which `hasTerminalFailedJob` reports as non-terminal the very next
 * evaluation (no separate reset needed).
 */
function evaluateMemberAutoPrint(
  board: BoardColumn[],
  memberId: string,
  date: string,
  now: number
): void {
  if (!evaluateMorningComplete(board, memberId, date)) return;

  if (!hasPrintableRaster(memberId, date)) {
    // FR-018: "the raster-missing case is recorded via telemetry (loud skip, FR-010's purity
    // preserved)" — recorded, no enqueue, and (by construction: this function only ever SELECTs)
    // no lazy generation. FR-018 says TELEMETRY, not just a stderr line — this
    // now ALSO writes a real `client_log` record through the sanctioned host-api seam
    // (`writeClientLog`, `modules/weather/port.ts`'s `TELEMETRY_PRODUCER_ID` precedent), so the
    // anomaly is queryable/retained, not just a transient log line.
    console.error("daily-briefing.trigger.raster-missing", { memberId, date });
    writeClientLog(TELEMETRY_PRODUCER_ID, [
      {
        level: "error",
        component: "daily-briefing",
        message: "raster_missing_on_completed_morning",
        data: { memberId, date },
        eventTime: now,
      },
    ]);
    return;
  }

  const recordKey = `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}`;
  if (hasTerminalFailedJob(recordKey, date)) {
    // the most recent job for this record/date is dead-lettered — skip
    // WITHOUT enqueuing. Not the AC-4/AC-5 "loud" telemetry (this is an expected, admin-actionable
    // steady state once dead-lettered, not a data anomaly): `console.warn`, one distinct code,
    // consistent with `board-column-missing` above. It is fine that this logs on every sweep
    // until an admin acts — dead-letter IS the admin's cue to act, and a silent skip here would
    // hide that cue entirely.
    console.warn("daily-briefing.trigger.terminal-failed-job-skip", { memberId, date });
    return;
  }

  // True predicate -> enqueue exactly once per member/date ("Trigger
  // evaluation"): the DATED outputRef is the provider-lookup/event-correlation identity; the
  // per-member recordKey is the dedup anchor. `alreadyPrinted`/pending-job outcomes are silent
  // no-ops — enqueuePrintJob's own dedup IS the trigger's level-triggered idempotency (no
  // trigger-owned queue, Key Entities "Trigger binding").
  enqueuePrintJob(
    {
      recordKey,
      targetDate: date,
      outputRef: `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}:${date}`,
      memberId,
    },
    now
  );
}

/** Evaluate the auto-print trigger for every active, opted-in member RIGHT NOW, against `now`
 * (injected — never a wall-clock read; the household date is re-derived from `now` on every call,
 * per the Edge Cases "midnight rollover" requirement: never cached at process/registration time,
 * v1's stale-date deadlock, study gotcha).
 * FR-018 gate cascade, in the contract's stated order (binding -> opt-in -> printing active ->
 * raster exists) — gates / are hoisted out of the per-member loop (see
 * `evaluateMemberAutoPrint`'s doc comment for why that is order-equivalent); a failed gate is a
 * silent no-op for every gate EXCEPT raster-missing, which is a loud telemetry skip.
 * Called from all three FR-017 wakeup paths (wakeup-hint subscription, periodic sweep, startup) —
 * see `registerAutoPrintTrigger` below — so a dropped event or a reboot can never strand a
 * completed morning (spec Acceptance Scenario 6 / SC-006).
 */
export function evaluateAutoPrintTrigger(now: number): void {
  const settings = readSettings();
  if (settings.autoPrintTrigger !== "morning_complete") return; // gate: binding active

  if (!isPrintingPluginActive()) return; // gate: Printing plugin active

  const date = todayInHouseholdTz(now);

  const eligibleMemberIds = listOptIns()
    .filter((optIn) => optIn.enabled) // gate: member briefing opt-in
    // An opt-in row survives archive (index.ts's own generateAllBriefings precedent: "An opt-in
    // row remains after archive so that reactivation self-heals; it is skipped while inactive
    // rather than treated as an all-or-nothing error") — the same existence guard applies here.
    .filter((optIn) => isActiveMember(optIn.memberId))
    // A member paused on today's weekday has no briefing to print (spec D4).
    .filter((optIn) => isBriefingScheduledOn(optIn.memberId, date))
    .map((optIn) => optIn.memberId);

  if (eligibleMemberIds.length === 0) return;

  // Fetched ONCE per evaluation pass, outside the loop — getBoard(date) already returns every
  // active child's column in one call (the shared-fetch precedent, `weatherMemo` in
  //./index.ts), so re-invoking it per member would just repeat identical reads.
  const board = getBoard(date);

  for (const memberId of eligibleMemberIds) {
    evaluateMemberAutoPrint(board, memberId, date, now);
  }
}

/** The scheduler job id the periodic sweep (+ startup evaluation) registers under. */
export const AUTO_PRINT_SWEEP_JOB_ID = "daily-briefing.auto-print-sweep";

/** Injectable seam for tests — production defaults to the real clock + the spec's 60s cadence. */
export interface AutoPrintTriggerOverrides {
  now?: () => number;
  sweepIntervalMs?: number;
}

/** Wire all three FR-017 wakeup paths onto ONE `evaluateAutoPrintTrigger`, in-process,
 * single-instance (Constitution III — no persisted schedule, no cross-process coordination):
 * (a) wakeup hint — `routines.completion_changed` (subscribed through the host-api barrel, the
 * ONLY sanctioned seam, FR-024) triggers an IMMEDIATE re-evaluation. The event's payload is
 * never read here — it is a wakeup HINT only ("ignores event payload truth"); a
 * lying or double/no-op-completion payload (routines' `completeChore` emits even when its
 * `INSERT... ON CONFLICT DO NOTHING` was a no-op) changes nothing because the evaluation
 * re-reads the board from scratch every time. Not a timer, so it is wired unconditionally,
 * independent of the scheduler's lifecycle/kill-switch below.
 * (b)+(c) periodic sweep AND startup evaluation — via ONE scheduler job (batch-C
 *), rather than a bespoke `globalThis.setInterval`. `registerJob`'s `"interval"` trigger
 * (`scheduler/index.ts`) arms with an IMMEDIATE (0ms-delay) first fire — `armInterval(id,
 * {immediate:true})`, invoked from every registered job when `scheduler.start` runs — which
 * doubles as the startup evaluation (spec Acceptance Scenario 6), then re-arms itself every
 * `sweepIntervalMs` (default `DEFAULT_SWEEP_INTERVAL_MS`, ≤60s per spec) exactly like the
 * module's existing wall-clock generation job. Routing through the REAL scheduler (instead of
 * a raw timer — previously this module's only one) restores three guarantees every other
 * background job in this codebase relies on:
 * 1. * Kill-switch parity* `registerJob` only arms once `scheduler.start` actually runs
 * (`armJob`/`armInterval` gate on `lifecycle === "started"`) — under
 * `SCHEDULER_DISABLED=1` (Playwright's default e2e `webServer`, `src/server/index.ts`)
 * NOTHING is armed and NOTHING fires, matching that flag's documented invariant ("no
 * timers ever get armed... no startup catch-up runs") instead of silently escaping it.
 * 2. * Backup-restore quiesce* `backups/restore.ts` stops the scheduler before a restore
 * and re-arms it (with a fresh immediate-fire re-evaluation) afterward — a raw timer
 * would have kept ticking straight through the quiesce window.
 * 3. * Throw containment* `executeGuarded` never rejects — a thrown `evaluateAutoPrintTrigger`
 * (e.g. `SQLITE_BUSY`) is caught and recorded on the job state, never an
 * `uncaughtException` the way a bare `setInterval` callback's throw would have been.
 * Returns the scheduler's own `StopHandle` directly — no wrapping needed.
 */
export function registerAutoPrintTrigger(overrides?: AutoPrintTriggerOverrides): StopHandle {
  const now = overrides?.now ?? (() => Date.now());
  const sweepIntervalMs = overrides?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  // (a) wakeup hint.
  subscribe(
    "routines.completion_changed",
    () => {
      evaluateAutoPrintTrigger(now());
    },
    "daily-briefing.auto-print-wakeup"
  );

  // (b)+(c) periodic sweep + startup evaluation, scheduler-routed (see doc comment above).
  return registerJob({
    id: AUTO_PRINT_SWEEP_JOB_ID,
    trigger: { kind: "interval", everyMs: sweepIntervalMs },
    action: () => evaluateAutoPrintTrigger(now()),
  });
}
