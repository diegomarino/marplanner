import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLeadership,
  type LockManagerLike,
  type BroadcastChannelLike,
} from "@/time-announcements/leader";

/** — leader election jsdom tests. jsdom has neither a real
 * Web Locks API nor cross-instance `BroadcastChannel` delivery, so both primitives are
 * injected fakes that simulate two tabs sharing ONE browser-scoped resource.
 * (Traces: TIME-ANNOUNCEMENTS-INV-06, TIME-ANNOUNCEMENTS-INV-07, TIME-ANNOUNCEMENTS-AC-04)
 */

/** A minimal, correctly-exclusive fake `navigator.locks`-like manager, shared across "tabs". */
class FakeLockManager implements LockManagerLike {
  private waiters: Array<() => void> = [];
  private busy = false;

  request<T>(
    _name: string,
    _options: { mode?: "exclusive" | "shared" },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T> {
    return new Promise<T>((resolveOuter, rejectOuter) => {
      const run = () => {
        this.busy = true;
        void callback({}).then(
          (result) => {
            resolveOuter(result);
            this.busy = false;
            this.advance();
          },
          (error) => {
            rejectOuter(error);
            this.busy = false;
            this.advance();
          }
        );
      };
      if (this.busy) {
        this.waiters.push(run);
      } else {
        run();
      }
    });
  }

  private advance(): void {
    const next = this.waiters.shift();
    next?.();
  }

  /** Simulate a hard kill of the current holder (crash, no `release` ever called) — promote the next waiter immediately. */
  simulateCrash(): void {
    this.busy = false;
    this.advance();
  }
}

/** A shared in-process "bus" so multiple `BroadcastChannelLike` instances (one per
 * simulated tab) can talk to each other, like real same-name `BroadcastChannel`s would.
 * Delivery is ASYNCHRONOUS (2026-09-04) — routed through a (fake, via
 * `vi.useFakeTimers`) `setTimeout`, never a same-tick synchronous callback. The
 * earlier synchronous bus was fidelity theatre: it let `postMessage` resolve a whole
 * election within the SAME call stack that triggered it, which cannot happen on a real
 * `BroadcastChannel` and was masking a genuine split-brain bug (two tabs racing the same
 * promotion deadline could both promote before either heard the other).
 */
function makeBroadcastBus(deliveryDelayMs = 1) {
  interface ChannelState {
    listeners: Set<(ev: MessageEvent) => void>;
    closed: boolean;
  }
  const channels = new Set<ChannelState>();
  const created: BroadcastChannelLike[] = [];

  function create(): BroadcastChannelLike {
    const self: ChannelState = { listeners: new Set(), closed: false };
    channels.add(self);
    const instance: BroadcastChannelLike = {
      postMessage(data: unknown) {
        if (self.closed) return;
        for (const ch of channels) {
          if (ch === self || ch.closed) continue;
          for (const listener of ch.listeners) {
            setTimeout(() => listener({ data } as MessageEvent), deliveryDelayMs);
          }
        }
      },
      addEventListener(_type, listener) {
        self.listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        self.listeners.delete(listener);
      },
      close() {
        self.closed = true;
        channels.delete(self);
      },
    };
    created.push(instance);
    return instance;
  }

  return { create, created };
}

describe("acquireLeadership — Web Locks primary (D4)", () => {
  it("two simulated tabs -> exactly one leader (SC-003)", () => {
    const manager = new FakeLockManager();
    const changesA: boolean[] = [];
    const changesB: boolean[] = [];

    acquireLeadership((v) => changesA.push(v), { locks: manager });
    acquireLeadership((v) => changesB.push(v), { locks: manager });

    expect(changesA).toEqual([true]);
    expect(changesB).toEqual([]); // still waiting behind the exclusive lock
  });

  it("graceful death (release()) -> a surviving tab is promoted, never permanent silence", async () => {
    const manager = new FakeLockManager();
    const changesA: boolean[] = [];
    const changesB: boolean[] = [];

    const releaseA = acquireLeadership((v) => changesA.push(v), { locks: manager });
    acquireLeadership((v) => changesB.push(v), { locks: manager });
    expect(changesA).toEqual([true]);

    releaseA();
    await Promise.resolve();
    await Promise.resolve();

    expect(changesA).toEqual([true, false]);
    expect(changesB).toEqual([true]);
  });

  it("kill-without-unload (crash) -> the browser auto-releases and a survivor is promoted (INV-06/-07)", () => {
    const manager = new FakeLockManager();
    const changesA: boolean[] = [];
    const changesB: boolean[] = [];

    acquireLeadership((v) => changesA.push(v), { locks: manager });
    acquireLeadership((v) => changesB.push(v), { locks: manager });
    expect(changesA).toEqual([true]);
    expect(changesB).toEqual([]);

    // No `release` call on A's side at all — simulates the tab dying without unload;
    // only the (simulated) browser-level auto-release promotes the next waiter.
    manager.simulateCrash();

    expect(changesB).toEqual([true]);
  });

  it("a lock-request failure never leaders and never throws", async () => {
    const failingManager: LockManagerLike = {
      request: () => Promise.reject(new Error("aborted")),
    };
    const changes: boolean[] = [];

    expect(() =>
      acquireLeadership((v) => changes.push(v), { locks: failingManager })
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(changes).toEqual([]);
  });
});

describe("acquireLeadership — BroadcastChannel fallback (D4, no Web Locks)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const FAST_DEPS = { heartbeatMs: 100, promotionTimeoutMs: 300 };

  /** Whether `changes`' last entry is `true` (currently believes itself leader). */
  function isCurrentlyLeader(changes: boolean[]): boolean {
    return changes.length > 0 && changes[changes.length - 1] === true;
  }

  it("two simulated tabs racing the SAME promotion deadline under ASYNC delivery -> exactly one leader settles, never both (P2-3, SC-003)", async () => {
    const bus = makeBroadcastBus();
    const changesA: boolean[] = [];
    const changesB: boolean[] = [];

    acquireLeadership((v) => changesA.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    acquireLeadership((v) => changesB.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });

    // Both A and B schedule their promotion timer at t=300 (registered back-to-back, so
    // under async delivery BOTH fire and BOTH optimistically claim before either has
    // heard the other's claim — a real momentary "concurrent leaders" window). The claim
    // exchange (1ms delivery each way) resolves the tie shortly after t=300.
    await vi.advanceTimersByTimeAsync(310);

    const aLeads = isCurrentlyLeader(changesA);
    const bLeads = isCurrentlyLeader(changesB);
    expect(aLeads !== bLeads).toBe(true); // exactly one — never both, never neither
    // The loser (if it ever claimed) went true THEN false; the winner only ever went true.
    if (aLeads) {
      expect(changesB).toEqual(changesB[0] === true ? [true, false] : []);
    } else {
      expect(changesA).toEqual(changesA[0] === true ? [true, false] : []);
    }

    // Stability: once settled, further time doesn't cause any more flips (the winner's
    // heartbeats keep resetting the loser's promotion timer indefinitely).
    const snapshotA = [...changesA];
    const snapshotB = [...changesB];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changesA).toEqual(snapshotA);
    expect(changesB).toEqual(snapshotB);
  });

  it("a waiting lower-id tab resets its promotion deadline on a higher-id claim", async () => {
    const id = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000000");
    const bus = makeBroadcastBus();
    const peer = bus.create();
    const changes: boolean[] = [];
    const release = acquireLeadership((value) => changes.push(value), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      peer.postMessage({ type: "claim", id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
      await vi.advanceTimersByTimeAsync(200);
      expect(changes).toEqual([]);
      await vi.advanceTimersByTimeAsync(101);
      expect(changes).toEqual([true]);
    } finally {
      release();
      peer.close();
      id.mockRestore();
    }
  });

  it("a LONE tab promotes itself via the promotion timeout when no heartbeat/claim ever arrives (fallback path promotion timeout, SC-003)", async () => {
    const bus = makeBroadcastBus();
    const changes: boolean[] = [];

    acquireLeadership((v) => changes.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });

    expect(changes).toEqual([]); // not yet — waiting out the promotion window
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toEqual([true]);
  });

  it("graceful death (release()) broadcasts leader-left -> the survivor contends via the SAME claim protocol and wins uncontested", async () => {
    const bus = makeBroadcastBus();
    const changesA: boolean[] = [];
    const changesB: boolean[] = [];

    const releaseA = acquireLeadership((v) => changesA.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    const releaseB = acquireLeadership((v) => changesB.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    await vi.advanceTimersByTimeAsync(310);
    // Settle the initial (possibly contended) election first — see the test above.
    const aLeadsInitially = isCurrentlyLeader(changesA);
    expect(aLeadsInitially !== isCurrentlyLeader(changesB)).toBe(true);

    const [leaderChanges, followerChanges, releaseLeader] = aLeadsInitially
      ? [changesA, changesB, releaseA]
      : [changesB, changesA, releaseB];

    const followerSnapshotLen = followerChanges.length;
    releaseLeader(); // synchronously broadcasts "leader-left"
    await vi.advanceTimersByTimeAsync(10); // delivery + the follower's claimLeadership + its own claim round-trip

    expect(leaderChanges[leaderChanges.length - 1]).toBe(false);
    expect(followerChanges.length).toBeGreaterThan(followerSnapshotLen);
    expect(followerChanges[followerChanges.length - 1]).toBe(true);
  });

  it("THREE tabs + leader-left under ASYNC delivery -> the two survivors converge to exactly ONE leader (N-2 re-review; the Codex 3-tab scenario)", async () => {
    const bus = makeBroadcastBus();
    const changes: boolean[][] = [[], [], []];
    const releases = changes.map((log) =>
      acquireLeadership((v) => log.push(v), {
        locks: null,
        channelFactory: bus.create,
        ...FAST_DEPS,
      })
    );
    await vi.advanceTimersByTimeAsync(310);
    const leaders = changes.map(isCurrentlyLeader);
    expect(leaders.filter(Boolean).length).toBe(1);

    const leaderIdx = leaders.indexOf(true);
    releases[leaderIdx](); // leader-left broadcast reaches BOTH survivors — each contends via claims
    // Give the claim/demote protocol (and the N-2 heartbeat-demote fallback) several
    // heartbeat rounds to converge; a leader-left promoting BOTH recipients was the bug.
    await vi.advanceTimersByTimeAsync(500);
    const survivors = changes.filter((_, i) => i !== leaderIdx).map(isCurrentlyLeader);
    expect(survivors.filter(Boolean).length).toBe(1);
  });

  it("kill-without-unload (silent death, no leader-left message) -> the survivor promotes only once the fallback promotion timeout elapses", async () => {
    const bus = makeBroadcastBus();
    const changesA: boolean[] = [];
    const changesB: boolean[] = [];

    acquireLeadership((v) => changesA.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    acquireLeadership((v) => changesB.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    await vi.advanceTimersByTimeAsync(310);
    const aLeads = isCurrentlyLeader(changesA);
    expect(aLeads !== isCurrentlyLeader(changesB)).toBe(true);

    const leaderIndex = aLeads ? 0 : 1;
    const followerChanges = aLeads ? changesB : changesA;
    const followerSnapshotLen = followerChanges.length;

    // Simulate a crash: the leader's channel goes silent WITHOUT going through
    // `release` (so no "leader-left" message is ever sent) — kill the raw channel
    // object directly.
    bus.created[leaderIndex].close();

    // The follower's promotion timer was last reset by the leader's most recent
    // heartbeat; advancing less than a full fresh window must NOT promote it yet...
    await vi.advanceTimersByTimeAsync(280);
    expect(followerChanges.length).toBe(followerSnapshotLen);
    //...but the full window does.
    await vi.advanceTimersByTimeAsync(50);
    expect(followerChanges[followerChanges.length - 1]).toBe(true);
  });

  it("no Web Locks AND no BroadcastChannel -> degrades to always-leader (single-tab-equivalent, still correct)", () => {
    const changes: boolean[] = [];
    acquireLeadership((v) => changes.push(v), { locks: null, channelFactory: null });
    expect(changes).toEqual([true]);
  });

  it("release() while leading tears down the heartbeat interval (no further broadcast traffic)", async () => {
    const bus = makeBroadcastBus();
    const changesA: boolean[] = [];

    const releaseA = acquireLeadership((v) => changesA.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(changesA).toEqual([true]);

    releaseA();
    expect(changesA).toEqual([true, false]);

    // A second release call is a harmless no-op (idempotent teardown).
    expect(() => releaseA()).not.toThrow();
    expect(changesA).toEqual([true, false]);
  });
});

describe("acquireLeadership — BroadcastChannel fallback — stale-promotion split-brain (#646)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const FAST_DEPS = { heartbeatMs: 100, promotionTimeoutMs: 300 };

  /** Whether `changes`' last entry is `true` (currently believes itself leader). */
  function isCurrentlyLeader(changes: boolean[]): boolean {
    return changes.length > 0 && changes[changes.length - 1] === true;
  }

  /** A `BroadcastChannel`-like bus (same async-delivery model as `makeBroadcastBus` above)
   * that additionally supports SUPPRESSING inbound delivery to one specific channel
   * instance — simulating a tab whose channel goes deaf (backgrounded/throttled) without
   * dying, so it neither hears the leader's heartbeats nor its own claim's silence being
   * heard by anyone. Suppression is checked at delivery (fire) time, so resuming
   * delivery lets subsequently-sent messages straight through.
   */
  function makeSuppressibleBus(deliveryDelayMs = 1) {
    interface ChannelState {
      listeners: Set<(ev: MessageEvent) => void>;
      closed: boolean;
      suppressed: boolean;
    }
    const channels = new Set<ChannelState>();
    const stateByInstance = new Map<BroadcastChannelLike, ChannelState>();
    const created: BroadcastChannelLike[] = [];

    function create(): BroadcastChannelLike {
      const self: ChannelState = { listeners: new Set(), closed: false, suppressed: false };
      channels.add(self);
      const instance: BroadcastChannelLike = {
        postMessage(data: unknown) {
          if (self.closed) return;
          for (const ch of channels) {
            if (ch === self || ch.closed) continue;
            for (const listener of ch.listeners) {
              setTimeout(() => {
                if (ch.suppressed || ch.closed) return; // inbound delivery suppressed for this tab
                listener({ data } as MessageEvent);
              }, deliveryDelayMs);
            }
          }
        },
        addEventListener(_type, listener) {
          self.listeners.add(listener);
        },
        removeEventListener(_type, listener) {
          self.listeners.delete(listener);
        },
        close() {
          self.closed = true;
          channels.delete(self);
        },
      };
      stateByInstance.set(instance, self);
      created.push(instance);
      return instance;
    }

    function setSuppressed(instance: BroadcastChannelLike, value: boolean): void {
      const state = stateByInstance.get(instance);
      if (state) state.suppressed = value;
    }

    return { create, setSuppressed, created };
  }

  /** Pin two fixed contender ids onto the next two `acquireLeadership` calls, in order. */
  function pinContenderIds(firstId: string, secondId: string): void {
    const asUuid = (id: string) => id as unknown as ReturnType<typeof crypto.randomUUID>;
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(asUuid(firstId))
      .mockReturnValueOnce(asUuid(secondId));
  }

  it("the review's A3 probe: a suppressed follower's promotion timer expires while the (lower-id) leader still lives -> resumed delivery reconverges to exactly one leader (Traces: TIME-ANNOUNCEMENTS-INV-06, TIME-ANNOUNCEMENTS-INV-07)", async () => {
    // Ids are PINNED (never `Math.random`/`crypto.randomUUID` live) — the review warned
    // that an un-pinned id race passes ~50% of the time even when the fix is deleted,
    // because only ONE of the two possible id orderings actually routes through the
    // `heartbeat && msg.id < selfId` demote branch (the other ordering resolves via the
    // unrelated, already-covered `claim` demote branch instead — see the sibling test
    // below). Pinning the ids removes the coin flip entirely rather than papering over it
    // with iteration count.
    pinContenderIds("id-0000-leader", "id-9999-follower");

    const bus = makeSuppressibleBus();
    const leaderChanges: boolean[] = [];
    const followerChanges: boolean[] = [];

    // Tab "leader" is created ALONE first and settles the election uncontested (mirrors
    // the existing "lone tab" test) — this is the only way to pin WHICH physical tab
    // holds the lower id without depending on a live claim race.
    acquireLeadership((v) => leaderChanges.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    await vi.advanceTimersByTimeAsync(FAST_DEPS.promotionTimeoutMs);
    expect(leaderChanges).toEqual([true]);

    // Tab "follower" joins afterward and is immediately suppressed — it never hears the
    // leader's heartbeats, so its OWN promotion timer (started fresh at creation) is free
    // to expire even though the leader is very much alive and still heartbeating.
    acquireLeadership((v) => followerChanges.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    const followerChannel = bus.created[bus.created.length - 1];
    bus.setSuppressed(followerChannel, true);

    await vi.advanceTimersByTimeAsync(FAST_DEPS.promotionTimeoutMs);
    // The follower's timer expired in silence: it optimistically self-promoted. Its
    // higher-id `claim` reaches the (unsuppressed) leader, which correctly ignores it
    // ("we already win") — so at this instant BOTH tabs believe they lead. This is the
    // real, momentary split-brain window the demote-on-heartbeat branch exists to heal.
    expect(isCurrentlyLeader(leaderChanges)).toBe(true);
    expect(isCurrentlyLeader(followerChanges)).toBe(true);

    // Delivery resumes (the tab comes back into the foreground/whatever throttled it).
    bus.setSuppressed(followerChannel, false);
    // Give the leader's next scheduled heartbeat time to be sent AND delivered.
    await vi.advanceTimersByTimeAsync(FAST_DEPS.heartbeatMs + 10);

    // Exactly one leader survives — the genuine (lower-id) leader — and it never wavered.
    expect(leaderChanges).toEqual([true]);
    expect(isCurrentlyLeader(followerChanges)).toBe(false);
    expect(followerChanges[followerChanges.length - 1]).toBe(false);

    // Stability: further time doesn't reopen the split (the leader's heartbeats keep
    // resetting the demoted follower's promotion timer indefinitely).
    const leaderSnapshot = [...leaderChanges];
    const followerSnapshot = [...followerChanges];
    await vi.advanceTimersByTimeAsync(1000);
    expect(leaderChanges).toEqual(leaderSnapshot);
    expect(followerChanges).toEqual(followerSnapshot);
  });

  it("the mirror id ordering (suppressed tab holds the LOWER id) reconverges via the claim-demote branch instead — included so both orderings are pinned deterministically, not just the one above", async () => {
    // Reversed relative to the test above: the tab that settles alone first now holds the
    // HIGHER id, and the later, suppressed tab holds the LOWER one. When its promotion
    // timer expires and it claims, the established (unsuppressed) leader sees a LOWER
    // incoming id and demotes immediately via the `claim` branch — no split-brain window
    // ever opens, so this ordering does NOT exercise the heartbeat-demote branch. It's
    // pinned here anyway so neither id ordering is left to chance.
    pinContenderIds("id-9999-leader", "id-0000-follower");

    const bus = makeSuppressibleBus();
    const firstChanges: boolean[] = [];
    const secondChanges: boolean[] = [];

    acquireLeadership((v) => firstChanges.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    await vi.advanceTimersByTimeAsync(FAST_DEPS.promotionTimeoutMs);
    expect(firstChanges).toEqual([true]);

    acquireLeadership((v) => secondChanges.push(v), {
      locks: null,
      channelFactory: bus.create,
      ...FAST_DEPS,
    });
    const secondChannel = bus.created[bus.created.length - 1];
    bus.setSuppressed(secondChannel, true);

    await vi.advanceTimersByTimeAsync(FAST_DEPS.promotionTimeoutMs + 10);
    bus.setSuppressed(secondChannel, false);
    await vi.advanceTimersByTimeAsync(FAST_DEPS.heartbeatMs + 10);

    // Exactly one leader — the lower-id tab (the one that joined second) — throughout.
    expect(isCurrentlyLeader(firstChanges)).toBe(false);
    expect(isCurrentlyLeader(secondChanges)).toBe(true);
  });
});
