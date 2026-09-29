// ─────────────────────────────────────────────────────────────────────
// Background poller — the ONLY place
// blocked-state reconciliation happens (FR-005/AC-01: never a read
// side-effect) and the ONLY path (besides picker registration, D6) that
// stamps `lastSeenAt` (FR-006/INV-04). Registers through the host-api
// barrel's `registerJob` (ADR-039 §2b′ / Rule B), mirroring the
// daily-briefing/backups/telemetry job-registration precedents.
//
// Source: docs/features/network-devices.md (block-sta —
// reconciliation source is the SAME client-list poll), D5 (cache-level
// gate, last-good retention); "State transitions";
// FR-005/FR-006/FR-020/FR-021.
// ─────────────────────────────────────────────────────────────────────

import { getDb, registerJob } from "../../host-api";
import type { StopHandle } from "../../host-api";
import { getUniFiClient, UniFiControllerRejectedError } from "./client";
import type { RawUniFiClient } from "./client";
import { normalizeLiveClients } from "./normalize";
import { getNetworkDevicesCache } from "./cache";
import type { LiveCache } from "./cache";
import type { LiveClient } from "../../../shared";

/** The scheduler job id this module registers under. */
export const NETWORK_DEVICES_POLL_JOB_ID = "network-devices.poll";

/** Polling cadence — well inside the 5-minute staleness threshold (`cache.ts`
 * `CACHE_FRESHNESS_MS`) so a healthy controller never lets the cache go stale between polls. */
const POLL_INTERVAL_MS = 60_000;

type NetworkDeviceReconcileRow = {
  id: string;
  mac: string;
  is_blocked: number;
  belief_diverged_at: number | null;
};

/** Stamp `lastSeenAt = now` for every REGISTERED device whose MAC appears in this poll's fresh
 * result — the ONLY `lastSeenAt` refresh path besides picker registration itself (D6). A MAC
 * present in `entries` but not yet registered is simply not a row here and is left alone —
 * this function NEVER creates a registration (FR-021: the poller only ever updates existing
 * rows).
 */
function stampObservedMacs(db: ReturnType<typeof getDb>, entries: LiveClient[], now: number): void {
  const macs = new Set(entries.map((entry) => entry.mac));
  if (macs.size === 0) return;

  const stmt = db.prepare(
    `UPDATE network_devices SET last_seen_at = ?, updated_at = ? WHERE mac = ?`
  );
  for (const mac of macs) {
    stmt.run(now, now, mac);
  }
}

/** Reconcile `isBlocked` belief against the controller's authoritative blocked flag, taken
 * from the SAME client-list poll result (block-sta) — corrects any row whose
 * belief mismatches the controller OR still carries a divergence flag from a prior mirror-
 * write failure (AC-02), clearing `beliefDivergedAt` once corrected. A registered MAC
 * absent from this poll's result (offline / rotated out) is left untouched — reconciliation
 * only acts on what THIS poll actually confirmed, never inferring absence as "not blocked".
 * NEVER creates or deletes a registration (FR-021) — every statement here is an UPDATE
 * against an existing row.
 */
function reconcileBlockedFlags(
  db: ReturnType<typeof getDb>,
  entries: LiveClient[],
  now: number
): void {
  const byMac = new Map(entries.map((entry) => [entry.mac, entry.isBlocked]));
  if (byMac.size === 0) return;

  const rows = db
    .prepare(`SELECT id, mac, is_blocked, belief_diverged_at FROM network_devices`)
    .all() as NetworkDeviceReconcileRow[];

  const update = db.prepare(
    `UPDATE network_devices SET is_blocked = ?, belief_diverged_at = NULL, updated_at = ? WHERE id = ?`
  );

  for (const row of rows) {
    const controllerBlocked = byMac.get(row.mac);
    if (controllerBlocked === undefined) continue; // not present in this poll — no correction

    const believedBlocked = row.is_blocked === 1;
    const diverged = row.belief_diverged_at !== null;
    if (controllerBlocked !== believedBlocked || diverged) {
      update.run(controllerBlocked ? 1 : 0, now, row.id);
    }
  }
}

function isRejected(err: unknown): boolean {
  return err instanceof UniFiControllerRejectedError;
}

/** Run one poll cycle against the given cache (defaults to the process-wide singleton) — the
 * scheduler job's `action`, and directly callable by tests/`runJobNow` without any scheduler
 * involvement. `now` is an explicit injected instant (never `Date.now` internally), matching
 * every other freshness computation in this module.
 * Controller unconfigured (`getUniFiClient` -> `null`) or a failed `listClients` call both
 * record a cache failure and return WITHOUT touching the registry at all — poll failure
 * retains last-good cache entries and leaves every registry row untouched
 * (FR-006/INV-04: a controller outage must never corrupt the registry).
 */
export async function pollOnce(
  now: number,
  cache: LiveCache = getNetworkDevicesCache()
): Promise<void> {
  const client = getUniFiClient();
  if (!client) {
    cache.recordFailure("unconfigured");
    return;
  }

  let raw: RawUniFiClient[];
  try {
    raw = await client.listClients();
  } catch (err) {
    cache.recordFailure(isRejected(err) ? "rejected" : "unreachable");
    return;
  }

  const entries = normalizeLiveClients(raw);
  cache.recordSuccess(entries, now);

  const db = getDb();
  stampObservedMacs(db, entries, now);
  reconcileBlockedFlags(db, entries, now);
}

/** Register the network-devices poller on the process-wide scheduler singleton, through the
 * host-api barrel ONLY (Rule B) — mirrors `registerDailyBriefingJob`/`registerBackupsJob`/
 * `registerTelemetryPruneJob`. An `interval` trigger fires immediately on registration once
 * the scheduler has started (`armInterval({immediate: true})`, `src/server/scheduler/index.ts`)
 * and then every `POLL_INTERVAL_MS` thereafter — this IS "run-on-startup + interval" (no
 * separate trigger kind exists for it; the scheduler's own immediate-arm behavior provides the
 * startup run).
 * this function ONLY registers the job — it no
 * longer wires the live-cache accessor itself (that call used to live here). Wiring the
 * accessor is now `src/server/index.ts` `main`'s own UNCONDITIONAL responsibility (calls
 * `cache.ts`'s `wireNetworkDevicesCache` directly, regardless of `SCHEDULER_DISABLED`) —
 * this function stays entirely behind the scheduler gate, exactly like its sibling
 * registrations, since `SCHEDULER_DISABLED=1` (Playwright's default e2e webServer env) must
 * still see a REAL (if perpetually cold) cache even though no poll ever runs.
 */
export function registerNetworkDevicesPollerJob(): StopHandle {
  return registerJob({
    id: NETWORK_DEVICES_POLL_JOB_ID,
    trigger: { kind: "interval", everyMs: POLL_INTERVAL_MS },
    action: () => pollOnce(Date.now()),
  });
}
