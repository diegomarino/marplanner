/** Leader election — one speaking tab per browser.
 * Primary: the Web Locks API (`navigator.locks.request("mp:time-announcements-leader",
 * { mode: "exclusive" }, callback)`) — the callback holds an unresolved promise for as
 * long as the tab lives, and the BROWSER auto-releases the lock (crash included),
 * promoting the next waiter. This eliminates v1's unfixed zero-leader failure mode (a
 * leader that died without `unload` left the household silent until reload).
 * Fallback (no `navigator.locks`, e.g. older WebKit): a `BroadcastChannel` heartbeat + a
 * `3 * heartbeatMs` promotion timeout. The leader broadcasts a heartbeat every
 * `heartbeatMs`; a follower promotes itself after `promotionTimeoutMs` of silence
 * (covers a hard kill). A `release` call while leading ALSO broadcasts an explicit
 * "leader-left" message, so a graceful teardown promotes a survivor immediately rather
 * than waiting out the full timeout.
 * Every primitive (`locks`, `channelFactory`, `timers`, the heartbeat/promotion
 * intervals) is injectable via `deps` — the only way to test election deterministically
 * in jsdom, which has neither Web Locks nor `BroadcastChannel` cross-instance delivery.
 */

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared" },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T>;
}

export interface BroadcastChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface TimersLike {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
  now: () => number;
}

export interface LeaderDeps {
  locks: LockManagerLike | null;
  channelFactory: (() => BroadcastChannelLike) | null;
  timers: TimersLike;
  heartbeatMs: number;
  promotionTimeoutMs: number;
}

const LOCK_NAME = "mp:time-announcements-leader";
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_PROMOTION_TIMEOUT_MS = DEFAULT_HEARTBEAT_MS * 3;

function defaultTimers(): TimersLike {
  return {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (id) => clearInterval(id),
    now: () => Date.now(),
  };
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { locks?: LockManagerLike };
  return nav.locks ?? null;
}

function defaultChannelFactory(): (() => BroadcastChannelLike) | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return () => new BroadcastChannel(LOCK_NAME) as unknown as BroadcastChannelLike;
}

function resolveDeps(deps?: Partial<LeaderDeps>): LeaderDeps {
  return {
    locks: deps?.locks !== undefined ? deps.locks : defaultLocks(),
    channelFactory:
      deps?.channelFactory !== undefined ? deps.channelFactory : defaultChannelFactory(),
    timers: deps?.timers ?? defaultTimers(),
    heartbeatMs: deps?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    promotionTimeoutMs: deps?.promotionTimeoutMs ?? DEFAULT_PROMOTION_TIMEOUT_MS,
  };
}

/** Elect exactly one leader for this browser. `onChange(isLeader)` fires whenever this
 * tab's leadership status changes. Returns a `release` teardown — call it on unmount
 * to relinquish leadership deterministically (rather than relying on the browser/timeout
 * to notice).
 */
export function acquireLeadership(
  onChange: (isLeader: boolean) => void,
  deps?: Partial<LeaderDeps>
): () => void {
  const resolved = resolveDeps(deps);
  if (resolved.locks) {
    return acquireViaLocks(resolved.locks, onChange);
  }
  return acquireViaBroadcast(resolved, onChange);
}

function acquireViaLocks(
  locks: LockManagerLike,
  onChange: (isLeader: boolean) => void
): () => void {
  let released = false;
  let releaseHold: (() => void) | null = null;

  const holdForever = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  void locks
    .request(LOCK_NAME, { mode: "exclusive" }, async () => {
      if (released) return; // released before the grant arrived — never announce leadership
      onChange(true);
      await holdForever;
    })
    .catch(() => {
      // lock request aborted/failed — this tab simply never leads; no throw, no retry loop
    });

  return () => {
    if (released) return;
    released = true;
    releaseHold?.();
    onChange(false);
  };
}

interface BroadcastMsg {
  type: "heartbeat" | "leader-left" | "claim";
  id: string;
}

/** A random per-tab contender id (2026-09-04). `crypto.randomUUID` when
 * available; a timestamp+random fallback otherwise. Only used as a tie-break token
 * (lexicographic comparison) — never persisted, never meaningful across page loads.
 */
function randomContenderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Fallback election resolves simultaneous leadership claims under asynchronous delivery.
 * Every promotion attempt (initial silence timeout, or a `leader-left` departure) goes
 * through `claimLeadership`: the tab OPTIMISTICALLY becomes leader (so it doesn't sit
 * idle waiting for round-trip confirmation) and broadcasts a `claim` carrying its random
 * `selfId`. `handleMessage` processes `claim` messages EVEN WHILE LEADING (unlike
 * heartbeat/leader-left, which an active leader ignores) — a competing claim with a
 * LOWER id demotes self (the loser yields), a competing claim with a HIGHER id is
 * ignored (self already wins). This converges to exactly one leader regardless of
 * delivery order or timing, at the cost of a possible brief (sub-tick) flicker where
 * both tabs believe they lead before the losing claim arrives — `performFire`'s leader
 * gate + dedupe record make an actual double-speak during that flicker window
 * vanishingly unlikely in practice (it would require a rule to fire in the same
 * millisecond as the election settling) and never a correctness violation (dedupe still
 * caps it at one per browser-instance-that-actually-persists-as-leader).
 */
function acquireViaBroadcast(deps: LeaderDeps, onChange: (isLeader: boolean) => void): () => void {
  const { channelFactory, timers, heartbeatMs, promotionTimeoutMs } = deps;
  const selfId = randomContenderId();
  let isLeader = false;
  let torn = false;
  let heartbeatTimer: ReturnType<TimersLike["setInterval"]> | null = null;
  let promotionTimer: ReturnType<TimersLike["setTimeout"]> | null = null;

  const channel = channelFactory ? channelFactory() : null;

  function clearPromotionTimer(): void {
    if (promotionTimer !== null) {
      timers.clearTimeout(promotionTimer);
      promotionTimer = null;
    }
  }

  function schedulePromotion(): void {
    clearPromotionTimer();
    promotionTimer = timers.setTimeout(claimLeadership, promotionTimeoutMs);
  }

  function sendHeartbeat(): void {
    channel?.postMessage({ type: "heartbeat", id: selfId } satisfies BroadcastMsg);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      timers.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** Optimistically become leader and announce the claim (see the function's doc above). */
  function claimLeadership(): void {
    if (torn) return;
    clearPromotionTimer();
    if (!isLeader) {
      isLeader = true;
      onChange(true);
    }
    channel?.postMessage({ type: "claim", id: selfId } satisfies BroadcastMsg);
    if (channel && heartbeatTimer === null) {
      sendHeartbeat();
      heartbeatTimer = timers.setInterval(sendHeartbeat, heartbeatMs);
    }
  }

  /** Yield to a lower-id competing claim: stop heartbeating, re-enter the waiting state. */
  function demote(): void {
    if (!isLeader) return;
    isLeader = false;
    stopHeartbeat();
    onChange(false);
    schedulePromotion();
  }

  function handleMessage(ev: MessageEvent): void {
    if (torn) return;
    const msg = ev.data as BroadcastMsg | undefined;
    if (!msg) return;

    if (msg.type === "claim") {
      // Processed EVEN WHILE LEADING — this is what resolves a split-brain race.
      if (msg.id < selfId) {
        demote(); // lower id wins
      } else if (!isLeader) {
        schedulePromotion(); // someone (with a higher id than us) is contending/leading — keep waiting
      }
      // msg.id > selfId while WE lead: ignore, we win.
      return;
    }
    if (isLeader) {
      // N-2 (2026-09-04 re-): a heartbeat from a LOWER-id leader while we also lead
      // means a follower promoted during a heartbeat-delivery gap and both sides now lead.
      // Heartbeats repeat, so demoting on this signal is self-healing — a single lost
      // message can never leave a permanent split (unlike re-asserting our claim, whose
      // re-assert can itself be the lost message).
      if (msg.type === "heartbeat" && msg.id < selfId) {
        demote();
      }
      return; // other heartbeats/leader-left are irrelevant to an active leader
    }
    if (msg.type === "heartbeat") {
      schedulePromotion(); // the current leader is alive — push the promotion deadline back out
    } else if (msg.type === "leader-left") {
      clearPromotionTimer();
      claimLeadership(); // contend via the SAME claim protocol, never an unconditional promotion
    }
  }

  if (channel) {
    channel.addEventListener("message", handleMessage);
    schedulePromotion(); // no heartbeat/claim heard yet — attempt a claim if none arrives in time
  } else {
    // No BroadcastChannel support either — degrade to "always leader" (correct, just
    // without cross-tab coordination; equivalent to a single-tab browser). No contention
    // is possible here, so the claim protocol is unnecessary.
    isLeader = true;
    onChange(true);
  }

  return () => {
    if (torn) return;
    torn = true;
    clearPromotionTimer();
    stopHeartbeat();
    if (isLeader && channel) {
      channel.postMessage({ type: "leader-left", id: selfId } satisfies BroadcastMsg);
    }
    channel?.removeEventListener("message", handleMessage);
    channel?.close();
    const wasLeader = isLeader;
    isLeader = false;
    if (wasLeader) onChange(false);
  };
}
