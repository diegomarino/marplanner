// ─────────────────────────────────────────────────────────────────────
// In-process live-client cache — the poll's
// product: entries + fetchedAt + lastError, never persisted (
// "In-process live cache"). The closed `LiveCacheState` taxonomy is DERIVED
// at read time from this raw state against an INJECTED clock — the gate
// applies to the WHOLE cache, never per-entry (a per-entry gate would keep
// a device "fresh online" through an outage, inventing exactly the
// confident falsehood INV-04 forbids). Poll failure retains the last-good
// entries; state decays by age alone — there is NO debounce/hysteresis
// (adding smoothing would be an unlicensed behavior change).
//
// Source: docs/features/network-devices.md;
// "In-process live cache" / "State transitions"; FR-006/FR-020.
// ─────────────────────────────────────────────────────────────────────

import { setLiveCacheAccessor } from "./index";
import type { LiveCacheSnapshot } from "./index";
import type { LiveCacheState, LiveClient } from "../../../shared";

/** Stale threshold ("stale = age > 5 min against an injected clock"). */
export const CACHE_FRESHNESS_MS = 5 * 60 * 1000;

export type CacheLastError = "none" | "unconfigured" | "rejected" | "unreachable";

/** Injectable clock seam (the scheduler's `SchedulerDeps.now` precedent) — every freshness
 * computation in this module reads `clock.now`, never `Date.now` directly, so tests can
 * advance time deterministically past the 5-minute threshold (the class). */
export interface LiveCacheClock {
  now: () => number;
}

interface CacheData {
  entries: LiveClient[];
  fetchedAt: number | null;
  lastError: CacheLastError;
}

export interface LiveCache {
  /** The current derived snapshot — this IS the `LiveCacheAccessor` signature `index.ts`
   * declares (` => LiveCacheSnapshot`), so `getSnapshot` can be passed there directly. */
  getSnapshot(): LiveCacheSnapshot;
  /** A successful poll: replaces entries wholesale and stamps the observation instant. */
  recordSuccess(entries: LiveClient[], fetchedAt: number): void;
  /** A failed poll: retains the last-good entries/fetchedAt (last-good retention, research
   * D5) — only `lastError` changes; the derived state decays by AGE alone from here on. */
  recordFailure(reason: Exclude<CacheLastError, "none">): void;
}

/** Derive the closed `LiveCacheState` taxonomy from the raw cache data + the current instant
 * ("state derived"):
 * - `unconfigured` — the client factory reported no operator config (a NORMAL state, D2);
 * this wins over any stale last-good data, since "not set up" is the honest answer once the
 * operator has actually unconfigured the controller.
 * - `cold` — never yet had a SUCCESSFUL fetch (whether because no poll has run yet, or every
 * poll so far has failed with `rejected`/`unreachable`).
 * - `stale` — the last successful fetch is older than `CACHE_FRESHNESS_MS`.
 * - `freshEmpty` / `fresh` — a current (non-stale) fetch with zero / one-or-more entries.
 */
function deriveState(data: CacheData, now: number): LiveCacheState {
  if (data.lastError === "unconfigured") return "unconfigured";
  if (data.fetchedAt === null) return "cold";
  if (now - data.fetchedAt > CACHE_FRESHNESS_MS) return "stale";
  return data.entries.length === 0 ? "freshEmpty" : "fresh";
}

/** Build a fresh, independent live-cache instance (directly unit-testable — the state
 * matrix — without any process-wide singleton or scheduler involvement).
 */
export function createLiveCache(clock: LiveCacheClock): LiveCache {
  let data: CacheData = { entries: [], fetchedAt: null, lastError: "none" };

  return {
    getSnapshot(): LiveCacheSnapshot {
      const now = clock.now();
      return {
        state: deriveState(data, now),
        clients: data.entries,
        fetchedAt: data.fetchedAt,
        lastError: data.lastError,
      };
    },
    recordSuccess(entries: LiveClient[], fetchedAt: number): void {
      data = { entries, fetchedAt, lastError: "none" };
    },
    recordFailure(reason: Exclude<CacheLastError, "none">): void {
      // Last-good retention: entries + fetchedAt are left UNTOUCHED — only
      // lastError changes. The derived state above decays toward "stale" by age alone; this
      // function never resets fetchedAt/entries, so a transient failure never manufactures a
      // false "cold"/empty read.
      data = { ...data, lastError: reason };
    },
  };
}

let singleton: LiveCache | undefined;

/** The process-wide production instance (`poll.ts`'s production entrypoint uses this one;
 * tests build their own via `createLiveCache` directly for isolation). */
export function getNetworkDevicesCache(): LiveCache {
  if (!singleton) {
    singleton = createLiveCache({ now: () => Date.now() });
  }
  return singleton;
}

/** Wire this cache's `getSnapshot` as `index.ts`'s production `LiveCacheAccessor` — replacing
 * the conservative `unconfigured`-only default `index.ts` falls back to absent an injection
 * (see that module's own docblock: "the real cache module can wire itself in via
 * `setLiveCacheAccessor` without this module changing shape"). Idempotent — safe to call more
 * than once. called from `src/server/index.ts`'s * `main` UNCONDITIONALLY (never gated behind `SCHEDULER_DISABLED`) — Playwright's default
 * e2e webServer sets `SCHEDULER_DISABLED=1`, and installing the real (if perpetually cold,
 * since nothing ever polls in that mode) cache accessor must not depend on whether the
 * scheduler itself runs. `registerNetworkDevicesPollerJob` (`poll.ts`) no longer calls this —
 * only the actual polling JOB registration stays behind the scheduler gate.
 */
export function wireNetworkDevicesCache(cache: LiveCache = getNetworkDevicesCache()): void {
  setLiveCacheAccessor(() => cache.getSnapshot());
}
