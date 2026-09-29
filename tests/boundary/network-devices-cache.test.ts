import { describe, it, expect } from "vitest";
import {
  createLiveCache,
  CACHE_FRESHNESS_MS,
} from "../../src/server/modules/network-devices/cache";
import type { LiveClient } from "../../src/shared";

/** docs/features/network-devices.md — live cache state-matrix boundary tests (research
 * D5, "In-process live cache" / "State transitions"). Every freshness
 * computation is exercised against an INJECTED clock (the class) — never a real
 * `Date.now` call inside this suite.
 */
describe("network-devices cache — T007", () => {
  function makeClock(initial: number) {
    let now = initial;
    return {
      clock: { now: () => now },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const CLIENT_A: LiveClient = { mac: "aa:bb:cc:dd:ee:01", displayName: "A", isBlocked: false };

  it("starts cold before any fetch (never fetched, no error)", () => {
    const { clock } = makeClock(1_000_000);
    const cache = createLiveCache(clock);
    expect(cache.getSnapshot()).toEqual({
      state: "cold",
      clients: [],
      fetchedAt: null,
      lastError: "none",
    });
  });

  it("unconfigured is a distinct NORMAL state — never conflated with cold, rejected, or unreachable", () => {
    const { clock } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordFailure("unconfigured");
    const snapshot = cache.getSnapshot();
    expect(snapshot.state).toBe("unconfigured");
    expect(snapshot.lastError).toBe("unconfigured");
  });

  it("rejected before any success also reads as cold, but lastError distinguishes 'rejected' from 'unreachable' (P1-2)", () => {
    const { clock } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordFailure("rejected");
    const snapshot = cache.getSnapshot();
    expect(snapshot.state).toBe("cold"); // no observation has EVER succeeded
    expect(snapshot.lastError).toBe("rejected");
  });

  it("unreachable before any success also reads as cold, with lastError distinctly 'unreachable' (never 'rejected')", () => {
    const { clock } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordFailure("unreachable");
    const snapshot = cache.getSnapshot();
    expect(snapshot.state).toBe("cold");
    expect(snapshot.lastError).toBe("unreachable");
  });

  it("a successful fetch with entries is fresh; with zero entries is freshEmpty; lastError resets to 'none'", () => {
    const { clock } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordSuccess([CLIENT_A], 1_000_000);
    expect(cache.getSnapshot()).toEqual({
      state: "fresh",
      clients: [CLIENT_A],
      fetchedAt: 1_000_000,
      lastError: "none",
    });

    cache.recordSuccess([], 1_000_500);
    expect(cache.getSnapshot()).toEqual({
      state: "freshEmpty",
      clients: [],
      fetchedAt: 1_000_500,
      lastError: "none",
    });
  });

  it("ages past the freshness threshold into stale — the WHOLE-cache gate, computed from the injected clock", () => {
    const { clock, advance } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordSuccess([CLIENT_A], 1_000_000);
    expect(cache.getSnapshot().state).toBe("fresh");

    advance(CACHE_FRESHNESS_MS); // exactly at the boundary — still fresh (age > threshold, not >=)
    expect(cache.getSnapshot().state).toBe("fresh");

    advance(1); // one ms past the boundary
    expect(cache.getSnapshot().state).toBe("stale");
  });

  it("a device cannot stay 'fresh online' through an outage — the gate is cache-level, not per-entry", () => {
    const { clock, advance } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordSuccess([CLIENT_A], 1_000_000);
    expect(cache.getSnapshot().state).toBe("fresh");
    expect(cache.getSnapshot().clients).toEqual([CLIENT_A]);

    // Every subsequent poll fails (outage) — the clock advances well past staleness.
    advance(CACHE_FRESHNESS_MS * 3);
    cache.recordFailure("unreachable");

    const snapshot = cache.getSnapshot();
    expect(snapshot.state).toBe("stale");
    // Last-good retention: the ENTRY is still there (a consumer can still show "last known: A"),
    // but the STATE itself is honestly stale — never "fresh" just because an entry exists.
    expect(snapshot.clients).toEqual([CLIENT_A]);
  });

  it("poll failure retains the last-good entries and fetchedAt — only lastError changes", () => {
    const { clock, advance } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordSuccess([CLIENT_A], 1_000_000);
    advance(1000);
    cache.recordFailure("rejected");

    const snapshot = cache.getSnapshot();
    expect(snapshot.clients).toEqual([CLIENT_A]);
    expect(snapshot.fetchedAt).toBe(1_000_000); // untouched by the failure
    expect(snapshot.state).toBe("fresh"); // still within the freshness window
    expect(snapshot.lastError).toBe("rejected");
  });

  it("a later successful fetch overwrites stale last-good data wholesale", () => {
    const { clock, advance } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordSuccess([CLIENT_A], 1_000_000);
    advance(CACHE_FRESHNESS_MS * 2);
    expect(cache.getSnapshot().state).toBe("stale");

    cache.recordSuccess([], 3_000_000);
    expect(cache.getSnapshot()).toEqual({
      state: "freshEmpty",
      clients: [],
      fetchedAt: 3_000_000,
      lastError: "none",
    });
  });

  it("unconfigured wins over stale last-good data once the operator actually unconfigures the controller", () => {
    const { clock, advance } = makeClock(1_000_000);
    const cache = createLiveCache(clock);

    cache.recordSuccess([CLIENT_A], 1_000_000);
    advance(1000);
    cache.recordFailure("unconfigured");

    const snapshot = cache.getSnapshot();
    expect(snapshot.state).toBe("unconfigured");
    expect(snapshot.lastError).toBe("unconfigured");
  });

  it("independent cache instances never share state", () => {
    const { clock: clockA } = makeClock(1_000_000);
    const { clock: clockB } = makeClock(1_000_000);
    const cacheA = createLiveCache(clockA);
    const cacheB = createLiveCache(clockB);

    cacheA.recordSuccess([CLIENT_A], 1_000_000);
    expect(cacheA.getSnapshot().state).toBe("fresh");
    expect(cacheB.getSnapshot().state).toBe("cold");
  });
});
