import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { subscribe } from "../../src/server/lib/event-bus";
import type { CoreEventCatalog } from "../../src/shared/events";
import {
  block,
  unblock,
  list,
  __setLiveCacheAccessorForTests,
  NetworkDeviceControllerUnavailableError,
  NetworkDeviceControllerRejectedError,
  NetworkDeviceControllerUnreachableError,
} from "../../src/server/modules/network-devices/index.ts";
import {
  __setUniFiClientForTests,
  buildUniFiClient,
  UniFiControllerRejectedError,
  UniFiControllerUnreachableError,
} from "../../src/server/modules/network-devices/client";
import type { UniFiClient, RawUniFiClient } from "../../src/server/modules/network-devices/client";
import {
  pollOnce,
  registerNetworkDevicesPollerJob,
  NETWORK_DEVICES_POLL_JOB_ID,
} from "../../src/server/modules/network-devices/poll";
import {
  createLiveCache,
  wireNetworkDevicesCache,
} from "../../src/server/modules/network-devices/cache";

/** docs/features/network-devices.md / — poller + block-honesty integration tests
 * ("State transitions", US2/US4 Acceptance Scenarios).
 * Full stack: real SQLite (isolated per test), the REAL scheduler singleton for the
 * registration-mechanics test, an injected `UniFiClient` (never real egress), and
 * an injected clock for the cache (`createLiveCache`) where the cache's own state matters.
 */
describe("network-devices poller + block honesty — T007/T008", () => {
  useIsolatedDb();

  afterEach(async () => {
    __setUniFiClientForTests(undefined);
    __setLiveCacheAccessorForTests(undefined);
    vi.unstubAllGlobals(); // a couple of P1 tests stub global fetch directly
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test — nothing to drain
    }
  });

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => {
      queueMicrotask(() => {
        queueMicrotask(() => resolve());
      });
    });
  }

  function fakeClient(overrides: Partial<UniFiClient> = {}): UniFiClient {
    return {
      listClients: vi.fn(async () => []),
      blockMac: vi.fn(async () => {}),
      unblockMac: vi.fn(async () => {}),
      ...overrides,
    };
  }

  function seedDevice(opts: {
    mac: string;
    alias?: string;
    isBlocked?: boolean;
    beliefDivergedAt?: number | null;
    lastSeenAt?: number | null;
    memberId?: string | null;
  }): string {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO network_devices
         (id, mac, alias, member_id, is_blocked, belief_diverged_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      opts.mac,
      opts.alias ?? "Alias",
      opts.memberId ?? null,
      opts.isBlocked ? 1 : 0,
      opts.beliefDivergedAt ?? null,
      opts.lastSeenAt ?? null,
      now,
      now
    );
    return id;
  }

  /** P2: an active member row, so a seeded device's `member_id` makes
   * `rowToRegisteredDeviceBase`'s `resolveMemberLabel` call actually reachable/forceable. */
  function seedMember(): string {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(id, `Member ${id.slice(0, 6)}`, now, now);
    return id;
  }

  function rawRow(id: string): {
    id: string;
    mac: string;
    is_blocked: number;
    belief_diverged_at: number | null;
    last_seen_at: number | null;
  } {
    return getDb()
      .prepare(
        `SELECT id, mac, is_blocked, belief_diverged_at, last_seen_at FROM network_devices WHERE id = ?`
      )
      .get(id) as {
      id: string;
      mac: string;
      is_blocked: number;
      belief_diverged_at: number | null;
      last_seen_at: number | null;
    };
  }

  function countDeviceRows(): number {
    const row = getDb().prepare("SELECT COUNT(*) AS count FROM network_devices").get() as {
      count: number;
    };
    return row.count;
  }

  /** Genuine DB-layer write-fault injection (the / write-spy precedent): forces the
   * NEXT statement whose SQL contains `matchSubstring` to throw on `.run`, exactly once. */
  function forceOneStatementToThrow(matchSubstring: string): () => void {
    const db = getDb();
    const patchable = db as unknown as {
      prepare: (...args: unknown[]) => { run: (...a: unknown[]) => unknown };
    };
    const originalPrepare = patchable.prepare.bind(db);
    let triggered = false;
    patchable.prepare = (...args: unknown[]) => {
      const stmt = originalPrepare(...args);
      if (
        !triggered &&
        typeof args[0] === "string" &&
        (args[0] as string).includes(matchSubstring)
      ) {
        triggered = true;
        stmt.run = () => {
          throw new Error("simulated mirror write failure");
        };
      }
      return stmt;
    };
    return () => {
      patchable.prepare = originalPrepare;
    };
  }

  /** Generalized fault injection: forces the Nth prepare call whose SQL includes
   * `matchSubstring` to have its `method` throw, exactly once. Distinguishing "which
   * occurrence" matters here because `setBlockedState` calls `findById` TWICE (an entry
   * lookup, then the post-write read-back) — targeting occurrence 2 hits ONLY the read-back. */
  function forceNthMatchToThrow(
    matchSubstring: string,
    occurrence: number,
    method: "run" | "get" | "all" = "run"
  ): () => void {
    const db = getDb();
    const patchable = db as unknown as {
      prepare: (...args: unknown[]) => Record<string, (...a: unknown[]) => unknown>;
    };
    const originalPrepare = patchable.prepare.bind(db);
    let seen = 0;
    patchable.prepare = (...args: unknown[]) => {
      const stmt = originalPrepare(...args);
      const sql = typeof args[0] === "string" ? args[0] : "";
      if (sql.includes(matchSubstring)) {
        seen += 1;
        if (seen === occurrence) {
          stmt[method] = () => {
            throw new Error(
              `simulated ${method} failure (occurrence ${occurrence} of "${matchSubstring}")`
            );
          };
        }
      }
      return stmt;
    };
    return () => {
      patchable.prepare = originalPrepare;
    };
  }

  /** forces BOTH the primary mirror UPDATE and the fallback divergence-flag UPDATE to
   * throw, each exactly once — the genuine "double fault" `setBlockedState`'s catch-of-a-catch
   * must survive without throwing the controller's already-successful action away. A single
   * combined patch (rather than composing two `forceNthMatchToThrow` calls) avoids restore-order
   * fragility across nested monkey-patches. */
  function forceMirrorDoubleFault(): () => void {
    const db = getDb();
    const patchable = db as unknown as {
      prepare: (...args: unknown[]) => { run: (...a: unknown[]) => unknown };
    };
    const originalPrepare = patchable.prepare.bind(db);
    let primaryTriggered = false;
    let fallbackTriggered = false;
    patchable.prepare = (...args: unknown[]) => {
      const stmt = originalPrepare(...args);
      const sql = typeof args[0] === "string" ? args[0] : "";
      if (!primaryTriggered && sql.includes("SET is_blocked = ?, belief_diverged_at = NULL")) {
        primaryTriggered = true;
        stmt.run = () => {
          throw new Error("simulated primary mirror write failure (P2-4 double-fault test)");
        };
      } else if (!fallbackTriggered && sql.includes("SET belief_diverged_at = ? WHERE id = ?")) {
        fallbackTriggered = true;
        stmt.run = () => {
          throw new Error(
            "simulated fallback divergence-flag write failure (P2-4 double-fault test)"
          );
        };
      }
      return stmt;
    };
    return () => {
      patchable.prepare = originalPrepare;
    };
  }

  const MAC_A = "aa:bb:cc:dd:ee:01";
  const MAC_B = "aa:bb:cc:dd:ee:02";

  // ── pollOnce — controller states -> cache ───────────

  describe("pollOnce — controller states never conflated", () => {
    it("controller unconfigured (getUniFiClient() -> null): cache state 'unconfigured', ZERO registry writes", () => {
      __setUniFiClientForTests(null);
      const deviceId = seedDevice({ mac: MAC_A });
      const cache = createLiveCache({ now: () => 1_000_000 });

      return pollOnce(1_000_000, cache).then(() => {
        const snapshot = cache.getSnapshot();
        expect(snapshot.state).toBe("unconfigured");
        expect(snapshot.lastError).toBe("unconfigured");
        const row = rawRow(deviceId);
        expect(row.last_seen_at).toBeNull();
        expect(row.is_blocked).toBe(0);
      });
    });

    it("controller rejected: cache lastError distinguishes 'rejected', registry untouched (P1-2)", async () => {
      __setUniFiClientForTests(
        fakeClient({
          listClients: vi.fn(async () => {
            throw new UniFiControllerRejectedError();
          }),
        })
      );
      const deviceId = seedDevice({ mac: MAC_A });
      const cache = createLiveCache({ now: () => 1_000_000 });

      await pollOnce(1_000_000, cache);

      const snapshot = cache.getSnapshot();
      expect(snapshot.state).toBe("cold"); // never yet had a successful fetch
      // The reviewer's mutant collapsing rejected/unreachable to the same state would have
      // passed against a bare `state === "cold"` assertion — lastError is the field that
      // actually distinguishes them (the degradation UI needs "check credentials" here).
      expect(snapshot.lastError).toBe("rejected");
      expect(rawRow(deviceId).last_seen_at).toBeNull();
    });

    it("controller unreachable: distinct lastError from rejected, registry untouched, last-good retained on a later failure (P1-2)", async () => {
      const client = fakeClient({
        listClients: vi.fn(async () => {
          throw new UniFiControllerUnreachableError();
        }),
      });
      __setUniFiClientForTests(client);
      const cache = createLiveCache({ now: () => 1_000_000 });

      await pollOnce(1_000_000, cache);
      const snapshot = cache.getSnapshot();
      expect(snapshot.state).toBe("cold");
      // Distinct from the "rejected" test above — "controller offline", not "check credentials".
      expect(snapshot.lastError).toBe("unreachable");
    });

    it("poll failure retains last-good cache entries — a healthy poll then an outage never wipes the cache", async () => {
      const rawA: RawUniFiClient = { mac: MAC_A, name: "A", ip: "10.0.0.1", blocked: false };
      const client = fakeClient({ listClients: vi.fn(async () => [rawA]) });
      __setUniFiClientForTests(client);
      const cache = createLiveCache({ now: () => 1_000_000 });

      await pollOnce(1_000_000, cache);
      expect(cache.getSnapshot().state).toBe("fresh");
      expect(cache.getSnapshot().clients).toHaveLength(1);

      // Now the controller goes down.
      client.listClients = vi.fn(async () => {
        throw new UniFiControllerUnreachableError();
      });
      await pollOnce(1_010_000, cache);

      const snapshot = cache.getSnapshot();
      expect(snapshot.clients).toHaveLength(1); // last-good retained
      expect(snapshot.fetchedAt).toBe(1_000_000); // untouched by the failed poll
    });

    it("P1 (Codex #660 / fix #671): an HTTP-401 failure through the REAL client -> poll failure semantics (last-good retained, lastError set), NEVER a false freshEmpty success", async () => {
      const rawA: RawUniFiClient = { mac: MAC_A, name: "A", ip: "10.0.0.1", blocked: false };
      const config = { apiKey: "k", consoleId: "c", siteId: "s" };

      // First poll: healthy, through the REAL client (not a hand-rolled fake) — populates
      // genuine last-good state.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ data: [rawA] }), { status: 200 }))
      );
      __setUniFiClientForTests(buildUniFiClient(config));
      const cache = createLiveCache({ now: () => 1_000_000 });

      await pollOnce(1_000_000, cache);
      expect(cache.getSnapshot().state).toBe("fresh");
      expect(cache.getSnapshot().clients).toHaveLength(1);

      // Second poll: the controller rejects with 401 (e.g. a session expiring mid-run) —
      // extractClients would otherwise read a naive empty-body 200 as a genuinely empty client
      // list and the cache would wrongly decay to freshEmpty, discarding last-good entries for no
      // real reason. NOTE (fix part 3): the CLOUD client-list path is Integration v1 now,
      // same as LOCAL — it has no legacy `meta.rc` 200-envelope concept at all (proper HTTP
      // status codes carry its failures, `rawRequest`'s own doc comment), so the original
      // scenario here (a 200 body with a legacy failure envelope) can no longer occur on ANY
      // `listClients` path in production. A real auth failure now surfaces as an HTTP 401/403
      // instead — this is the scenario that replaces it, exercising the SAME poll-failure
      // semantics (last-good retained, lastError set, never a false freshEmpty) through the
      // REAL client's actual failure path.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("unauthorized", { status: 401 }))
      );
      await pollOnce(1_010_000, cache);

      const snapshot = cache.getSnapshot();
      expect(snapshot.state).not.toBe("freshEmpty");
      expect(snapshot.clients).toHaveLength(1); // last-good retained, NOT wiped
      expect(snapshot.fetchedAt).toBe(1_000_000); // untouched by the failed poll
      expect(snapshot.lastError).toBe("rejected"); // classified as a real failure, not absorbed
    });
  });

  // ── pollOnce — lastSeenAt stamping (the ONLY refresh path besides registration) ──

  describe("pollOnce — lastSeenAt stamping", () => {
    it("stamps lastSeenAt = now for REGISTERED macs present in the fresh result, leaves absent macs untouched", async () => {
      const registeredA = seedDevice({ mac: MAC_A, lastSeenAt: null });
      const registeredB = seedDevice({ mac: MAC_B, lastSeenAt: 500 });
      __setUniFiClientForTests(
        fakeClient({
          listClients: vi.fn(async () => [
            { mac: MAC_A, name: "A", ip: "10.0.0.1", blocked: false },
          ]),
        })
      );
      const cache = createLiveCache({ now: () => 2_000_000 });

      await pollOnce(2_000_000, cache);

      expect(rawRow(registeredA).last_seen_at).toBe(2_000_000);
      expect(rawRow(registeredB).last_seen_at).toBe(500); // absent from this poll — untouched
    });

    it("a MAC present in the poll result but NOT registered creates NO row (poller never creates registrations)", async () => {
      __setUniFiClientForTests(
        fakeClient({
          listClients: vi.fn(async () => [
            { mac: "aa:bb:cc:dd:ee:ff", name: "Unregistered", ip: "10.0.0.9", blocked: false },
          ]),
        })
      );
      const cache = createLiveCache({ now: () => 2_000_000 });

      expect(countDeviceRows()).toBe(0);
      await pollOnce(2_000_000, cache);
      expect(countDeviceRows()).toBe(0); // still zero — never creates
    });
  });

  // ── pollOnce — reconciliation (authoritative blocked flag) ──

  describe("pollOnce — reconcile", () => {
    it("corrects a divergent believed-unblocked row to blocked=true (controller is authoritative) and clears beliefDivergedAt", async () => {
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false, beliefDivergedAt: 999 });
      __setUniFiClientForTests(
        fakeClient({
          listClients: vi.fn(async () => [{ mac: MAC_A, blocked: true }]),
        })
      );
      const cache = createLiveCache({ now: () => 2_000_000 });

      await pollOnce(2_000_000, cache);

      const row = rawRow(deviceId);
      expect(row.is_blocked).toBe(1);
      expect(row.belief_diverged_at).toBeNull();
    });

    it("never mutates a registered device absent from this poll's result (offline device stays as-is)", async () => {
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: true, beliefDivergedAt: null });
      __setUniFiClientForTests(fakeClient({ listClients: vi.fn(async () => []) }));
      const cache = createLiveCache({ now: () => 2_000_000 });

      await pollOnce(2_000_000, cache);

      const row = rawRow(deviceId);
      expect(row.is_blocked).toBe(1); // untouched, not incorrectly "corrected" to unblocked
    });

    it("reconcile never creates or deletes registrations — only UPDATEs existing rows", async () => {
      seedDevice({ mac: MAC_A, isBlocked: false });
      __setUniFiClientForTests(
        fakeClient({
          listClients: vi.fn(async () => [
            { mac: MAC_A, blocked: true },
            { mac: MAC_B, blocked: true }, // unregistered — must not create a row
          ]),
        })
      );
      const cache = createLiveCache({ now: () => 2_000_000 });

      await pollOnce(2_000_000, cache);
      expect(countDeviceRows()).toBe(1);
    });
  });

  // ── Block/unblock lifecycle ( AC-02) ────────────────

  describe("block/unblock — controller honesty", () => {
    it("block: controller call happens, mirror follows, event emitted with closed payload", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      let received: CoreEventCatalog["network.device_blocked"] | undefined;
      subscribe("network.device_blocked", (payload) => {
        received = payload;
      });

      const result = await block(deviceId);

      expect(client.blockMac).toHaveBeenCalledWith(MAC_A);
      expect(result.isBlocked).toBe(true);
      expect(rawRow(deviceId).is_blocked).toBe(1);

      await flushMicrotasks();
      expect(received).toEqual({ deviceId, timestamp: expect.any(Number) });
      expect(Object.keys(received!).sort()).toEqual(["deviceId", "timestamp"]);
    });

    it("unblock: symmetric — controller call, mirror, event", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: true });

      let received: CoreEventCatalog["network.device_unblocked"] | undefined;
      subscribe("network.device_unblocked", (payload) => {
        received = payload;
      });

      const result = await unblock(deviceId);

      expect(client.unblockMac).toHaveBeenCalledWith(MAC_A);
      expect(result.isBlocked).toBe(false);
      expect(rawRow(deviceId).is_blocked).toBe(0);

      await flushMicrotasks();
      expect(received).toEqual({ deviceId, timestamp: expect.any(Number) });
    });

    it("P1 (Codex #660): a legacy 200-envelope failure through the REAL client on block() -> throws, NOTHING mirrored, no event", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ meta: { rc: "error", msg: "api.err.Unauthorized" } }), {
              status: 200,
            })
        )
      );
      __setUniFiClientForTests(buildUniFiClient({ apiKey: "k", consoleId: "c", siteId: "s" }));
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      let received: CoreEventCatalog["network.device_blocked"] | undefined;
      subscribe("network.device_blocked", (payload) => {
        received = payload;
      });

      // The REAL client (not a hand-rolled fake) must reject — a naive "any 2xx is success"
      // implementation would resolve here, and the caller would mirror + emit a block the
      // controller never actually applied (the exact AC-02-class confident falsehood).
      await expect(block(deviceId)).rejects.toBeInstanceOf(NetworkDeviceControllerRejectedError);
      expect(rawRow(deviceId).is_blocked).toBe(0); // nothing mirrored

      await flushMicrotasks();
      expect(received).toBeUndefined(); // no event either
    });

    it("controller unconfigured -> a DISTINCT unavailable error, nothing mirrored", async () => {
      __setUniFiClientForTests(null);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      await expect(block(deviceId)).rejects.toBeInstanceOf(NetworkDeviceControllerUnavailableError);
      expect(rawRow(deviceId).is_blocked).toBe(0);
    });

    it("controller rejected -> error, NOTHING mirrored", async () => {
      __setUniFiClientForTests(
        fakeClient({
          blockMac: vi.fn(async () => {
            throw new UniFiControllerRejectedError();
          }),
        })
      );
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      await expect(block(deviceId)).rejects.toBeInstanceOf(NetworkDeviceControllerRejectedError);
      expect(rawRow(deviceId).is_blocked).toBe(0);
    });

    it("controller unreachable -> error, NOTHING mirrored", async () => {
      __setUniFiClientForTests(
        fakeClient({
          blockMac: vi.fn(async () => {
            throw new UniFiControllerUnreachableError();
          }),
        })
      );
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      await expect(block(deviceId)).rejects.toBeInstanceOf(NetworkDeviceControllerUnreachableError);
      expect(rawRow(deviceId).is_blocked).toBe(0);
    });

    it("naive re-send (ADR-053 §2): blocking an already-blocked device re-sends to the controller with NO short-circuit guard", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: true }); // already believed blocked

      await block(deviceId);

      expect(client.blockMac).toHaveBeenCalledTimes(1); // re-sent, not skipped
      expect(client.blockMac).toHaveBeenCalledWith(MAC_A);
    });

    // ── The full divergence -> poll -> converged lifecycle (AC-02, US2 Independent Test) ──

    it("controller success + mirror-write failure -> beliefDivergedAt visible, no throw -> next poll converges AND confirms isBlocked from the poll source", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      const restore = forceOneStatementToThrow("SET is_blocked = ?, belief_diverged_at = NULL");
      const result = await block(deviceId); // must NOT throw
      restore();

      expect(client.blockMac).toHaveBeenCalledWith(MAC_A);
      const divergedRow = rawRow(deviceId);
      // The controller succeeded but the mirror write failed — belief never actually flipped,
      // and the divergence flag is now set (visible, never a silent lie).
      expect(divergedRow.belief_diverged_at).not.toBeNull();
      expect(result.beliefDiverged).toBe(true);

      // The next poll reports the controller's authoritative blocked=true for this MAC —
      // reconciliation corrects the row AND clears the divergence.
      client.listClients = vi.fn(async () => [{ mac: MAC_A, blocked: true }]);
      const cache = createLiveCache({ now: () => 5_000_000 });
      await pollOnce(5_000_000, cache);

      const convergedRow = rawRow(deviceId);
      expect(convergedRow.is_blocked).toBe(1); // isBlocked=true CONFIRMED from the poll source
      expect(convergedRow.belief_diverged_at).toBeNull();
    });

    it("P2-4 double fault: BOTH the mirror write AND the divergence-flag fallback write fail — still no throw, and the next poll still converges", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      const restore = forceMirrorDoubleFault();
      const result = await block(deviceId); // must NOT throw despite BOTH writes faulting
      restore();

      expect(client.blockMac).toHaveBeenCalledWith(MAC_A);
      expect(result).toBeDefined();
      // Neither write landed — the row is exactly as it was before this call (a genuine
      // "stale read", never a confidently-wrong value fabricated in its place).
      const staleRow = rawRow(deviceId);
      expect(staleRow.is_blocked).toBe(0);
      expect(staleRow.belief_diverged_at).toBeNull();

      // The next poll reports the controller's authoritative blocked=true for this MAC — the
      // real backstop still converges even though the divergence flag was never persisted.
      client.listClients = vi.fn(async () => [{ mac: MAC_A, blocked: true }]);
      const cache = createLiveCache({ now: () => 7_000_000 });
      await pollOnce(7_000_000, cache);

      const convergedRow = rawRow(deviceId);
      expect(convergedRow.is_blocked).toBe(1);
      expect(convergedRow.belief_diverged_at).toBeNull();
    });

    it("P2-4: a failed read-back after a SUCCESSFUL mirror write does not throw — falls back to a best-effort reconstructed response", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false });

      // findById's exact SELECT text — occurrence 2 is the POST-write read-back (occurrence 1
      // is setBlockedState's own entry lookup, which must succeed normally).
      const restore = forceNthMatchToThrow(
        "belief_diverged_at, last_seen_at, created_at, updated_at FROM network_devices WHERE id = ?",
        2,
        "get"
      );
      const result = await block(deviceId); // must NOT throw despite the read-back failing
      restore();

      expect(client.blockMac).toHaveBeenCalledWith(MAC_A);
      // The mirror write itself SUCCEEDED (only the read-back failed) — the reconstruction
      // reports the INTENDED new state, not a stale pre-write one.
      expect(result.isBlocked).toBe(true);
      expect(result.beliefDiverged).toBe(false);
      expect(result.liveStatus).toBe("unknown");

      // A genuinely fresh read (this test's OWN rawRow query, unaffected by the patch above)
      // confirms the write really did land — only setBlockedState's own read-back was faulted.
      expect(rawRow(deviceId).is_blocked).toBe(1);
    });

    it("P2 (Codex #660): BOTH the mirror write AND the member-label lookup fail — block() still resolves, the controller action is not retried", async () => {
      const client = fakeClient();
      __setUniFiClientForTests(client);
      const memberId = seedMember();
      const deviceId = seedDevice({ mac: MAC_A, isBlocked: false, memberId });

      // Force the PRIMARY mirror UPDATE to throw (routes into the fallback-write branch; the
      // fallback divergence-flag UPDATE itself is left free to succeed). Applied FIRST so its
      // wrapper sits innermost — restored LAST, unwinding in the correct nested order.
      const restoreMirror = forceOneStatementToThrow(
        "SET is_blocked = ?, belief_diverged_at = NULL"
      );
      // Force resolveMemberLabel's OWN query (called from inside rowToRegisteredDeviceBase,
      // reached via setBlockedState's NORMAL post-write read-back path since the read-back
      // itself is untouched here) to throw exactly once — this is the exact "unguarded second
      // query inside the no-throw fallback" the review names.
      const restoreLabel = forceNthMatchToThrow(
        "SELECT id, display_name, lifecycle FROM members WHERE id = ?",
        1,
        "get"
      );

      const result = await block(deviceId); // must NOT throw despite BOTH faults

      restoreLabel();
      restoreMirror();

      // The controller call happened exactly once — proving the caller has no reason to (and
      // did not) retry an already-applied controller action after this double fault.
      expect(client.blockMac).toHaveBeenCalledTimes(1);
      expect(client.blockMac).toHaveBeenCalledWith(MAC_A);

      // Best-effort response: the member-label lookup failed, so it drops to the no-lookup
      // shape rather than fabricating or re-throwing.
      expect(result.memberLabel).toBeNull();
      expect(result.memberInactive).toBe(false);
      expect(result.memberId).toBe(memberId); // the raw id itself still comes straight off the row

      // The mirror write itself failed (forced) — the fallback divergence flag DID land since
      // it was left free to succeed.
      const row = rawRow(deviceId);
      expect(row.is_blocked).toBe(0); // primary write never landed
      expect(row.belief_diverged_at).not.toBeNull(); // fallback write succeeded
    });
  });

  // ── Registration mechanics (trap-sweep (d): registerJob via the barrel) ──

  describe("registerNetworkDevicesPollerJob — registration mechanics", () => {
    it("registers under NETWORK_DEVICES_POLL_JOB_ID with an interval trigger, and runJobNow drives a real poll", async () => {
      // registerNetworkDevicesPollerJob no longer
      // wires the cache accessor itself — production now wires it separately + unconditionally
      // (src/server/index.ts main, mirrored here explicitly, matching what a real boot does
      // BEFORE startScheduler/registerNetworkDevicesPollerJob ever runs).
      wireNetworkDevicesCache();
      initScheduler();
      const rawA: RawUniFiClient = { mac: MAC_A, name: "A", ip: "10.0.0.1", blocked: false };
      __setUniFiClientForTests(fakeClient({ listClients: vi.fn(async () => [rawA]) }));
      seedDevice({ mac: MAC_A, lastSeenAt: null });

      registerNetworkDevicesPollerJob();
      const result = await getScheduler().runJobNow(NETWORK_DEVICES_POLL_JOB_ID);

      expect(result).toMatchObject({ status: "completed" });
      // The wiring installed the real cache as index.ts's LiveCacheAccessor — a subsequent
      // list read must observe the just-polled cache state (`fresh`), never the module's
      // conservative unconfigured default.
      const { cacheState } = list(Date.now());
      expect(cacheState).toBe("fresh");
    });

    it("P2-3: wireNetworkDevicesCache() installs a REAL cache accessor even when the poller job is NEVER registered — the SCHEDULER_DISABLED=1 shape", () => {
      // This is the exact scenario Playwright's default e2e webServer runs under
      // (SCHEDULER_DISABLED=1): no scheduler is initialized, registerNetworkDevicesPollerJob
      // is never called, and no poll ever runs — yet index.ts's list/register must still
      // read a REAL (if perpetually `cold`) cache, never the module's conservative
      // `unconfigured`-only seam default. Distinguishing the two is exactly what makes this
      // test meaningful: the seam default reports `state: "unconfigured"`; a wired-but-never-
      // polled REAL cache reports `state: "cold"` ( "cold — never fetched").
      // Uses its OWN fresh LiveCache instance (not the process-wide singleton other tests in
      // this file may already have polled) so this assertion never depends on test order.
      const neverPolledCache = createLiveCache({ now: () => Date.now() });
      wireNetworkDevicesCache(neverPolledCache);

      const { cacheState } = list(Date.now());
      expect(cacheState).toBe("cold");
      expect(cacheState).not.toBe("unconfigured");
    });
  });
});
