import { describe, it, expect, afterEach } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import {
  register,
  edit,
  remove,
  list,
  canonicalizeMac,
  __setLiveCacheAccessorForTests,
  NetworkDeviceDuplicateError,
  NetworkDeviceReselectRequiredError,
  NetworkDeviceNotFoundError,
  NetworkDeviceValidationError,
} from "../../src/server/modules/network-devices/index.ts";
import type {
  LiveCacheSnapshot,
  EditDeviceInput,
} from "../../src/server/modules/network-devices/index.ts";
import { MemberReferenceError } from "../../src/server/modules/members/referential.ts";

/** docs/features/network-devices.md — registry core (* "Table: network_devices" / "State transitions", FR-001..FR-011).
 * The controller (`UniFiClient`) and the real poller-fed cache land in — this
 * suite exercises the OWN injectable live-cache accessor seam (`__setLiveCacheAccessorForTests`)
 * as its stand-in, per the module's own docblock.
 */
describe("network-devices registry", () => {
  useIsolatedDb();

  afterEach(() => {
    __setLiveCacheAccessorForTests(undefined);
  });

  const FIXED_MAC = "aa:bb:cc:dd:ee:ff";

  function freshSnapshot(overrides?: Partial<LiveCacheSnapshot>): LiveCacheSnapshot {
    return {
      state: "fresh",
      clients: [{ mac: FIXED_MAC, displayName: "Marta's iPad", isBlocked: false }],
      fetchedAt: 1_000_000,
      // (independent): LiveCacheSnapshot gained a `lastError` field
      // surfacing rejected/unreachable/unconfigured distinctly — a healthy fresh snapshot
      // reports "none".
      lastError: "none",
      ...overrides,
    };
  }

  function seedMember(lifecycle: "active" | "archived" = "active"): string {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', ?, ?, ?)"
    ).run(id, `Member ${id.slice(0, 6)}`, lifecycle, now, now);
    return id;
  }

  function countDeviceRows(): number {
    const row = getDb().prepare("SELECT COUNT(*) AS count FROM network_devices").get() as {
      count: number;
    };
    return row.count;
  }

  function rawRow(id: string): {
    id: string;
    mac: string;
    alias: string;
    member_id: string | null;
    last_seen_at: number | null;
  } {
    return getDb()
      .prepare("SELECT id, mac, alias, member_id, last_seen_at FROM network_devices WHERE id = ?")
      .get(id) as {
      id: string;
      mac: string;
      alias: string;
      member_id: string | null;
      last_seen_at: number | null;
    };
  }

  function totalChanges(): number {
    return (getDb().prepare("SELECT total_changes() AS c").get() as { c: number }).c;
  }

  /** P2 (verified with merit — trap-sweep itself mandated a write-spy, not
   * absence-of-change): `total_changes` alone stays green even if `list` starts issuing a
   * write that affects zero rows (`DELETE... WHERE false`, `INSERT OR IGNORE` on an existing
   * key) — it counts ROWS changed, not statements executed. This is a genuine DB-layer spy:
   * monkey-patch the real connection's `prepare`/`exec` for the duration of `fn`, capture every
   * SQL string passed through either, then restore the originals. Verified live: temporarily
   * adding `db.exec("DELETE FROM network_devices WHERE 0")` inside `list` turned the
   * write-verb assertion below red while `total_changes` stayed unchanged (0 rows affected) —
   * then reverted.
   */
  function captureExecutedSql(fn: () => void): string[] {
    const db = getDb();
    const patchable = db as unknown as {
      prepare: (...args: unknown[]) => unknown;
      exec: (...args: unknown[]) => unknown;
    };
    const originalPrepare = patchable.prepare.bind(db);
    const originalExec = patchable.exec.bind(db);
    const statements: string[] = [];

    patchable.prepare = (...args: unknown[]) => {
      if (typeof args[0] === "string") statements.push(args[0]);
      return originalPrepare(...args);
    };
    patchable.exec = (...args: unknown[]) => {
      if (typeof args[0] === "string") statements.push(args[0]);
      return originalExec(...args);
    };

    try {
      fn();
    } finally {
      patchable.prepare = originalPrepare;
      patchable.exec = originalExec;
    }

    return statements;
  }

  /** Matches a write-verb statement, ignoring leading whitespace and leading line/block comments. */
  const WRITE_VERB_RE =
    /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

  function writeStatements(statements: string[]): string[] {
    return statements.filter((sql) => WRITE_VERB_RE.test(sql));
  }

  // ── canonicalization ─────────────────────────────────────────────────

  describe("canonicalizeMac", () => {
    it("lowercases and requires 6 colon-separated hex octets", () => {
      expect(canonicalizeMac("AA:BB:CC:DD:EE:FF")).toBe("aa:bb:cc:dd:ee:ff");
      expect(() => canonicalizeMac("aabbccddeeff")).toThrow();
      expect(() => canonicalizeMac(42)).toThrow();
    });
  });

  // ── register — racing duplicate (INV-01) ────────────────────────────

  it("racing duplicate registrations (mixed casing) resolve to exactly one row via the DB's own UNIQUE index", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());

    const first = register("AA:BB:CC:DD:EE:FF", "First alias");
    expect(first.mac).toBe(FIXED_MAC);
    expect(countDeviceRows()).toBe(1);

    expect(() => register("aa:bb:cc:dd:ee:ff", "Second alias")).toThrow(
      NetworkDeviceDuplicateError
    );
    // The loser's attempted INSERT must not have landed a second row.
    expect(countDeviceRows()).toBe(1);
  });

  it("NetworkDeviceDuplicateError carries code=duplicate_mac and NO MAC-shaped substring in its message (FR-013/INV-07)", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    register(FIXED_MAC, "First alias");

    try {
      register(FIXED_MAC, "Second alias");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkDeviceDuplicateError);
      const duplicateErr = err as NetworkDeviceDuplicateError;
      expect(duplicateErr.code).toBe("duplicate_mac");
      expect(duplicateErr.mac).toBe(FIXED_MAC); // still available as a non-message property
      expect(duplicateErr.message).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    }
  });

  // ── register/edit — alias contract bound ──────

  it("register() trims the alias and rejects >80 chars (post-trim) with NetworkDeviceValidationError (contract maxLength: 80)", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());

    // Trimmed before both the length check and storage — whitespace never counts toward the
    // 80-char bound and never persists.
    const padded = register(FIXED_MAC, `  ${"a".repeat(80)}  `);
    expect(padded.alias).toBe("a".repeat(80));

    __setLiveCacheAccessorForTests(() =>
      freshSnapshot({
        clients: [{ mac: "11:22:33:44:55:66", displayName: null, isBlocked: false }],
      })
    );
    expect(() => register("11:22:33:44:55:66", "a".repeat(81))).toThrow(
      NetworkDeviceValidationError
    );
  });

  it("edit() rejects an alias >80 chars (post-trim) with NetworkDeviceValidationError, leaving the stored alias unchanged", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const device = register(FIXED_MAC, "Original alias");

    expect(() => edit(device.id, { alias: "b".repeat(81) })).toThrow(NetworkDeviceValidationError);
    expect(rawRow(device.id).alias).toBe("Original alias");
  });

  // ── register — picker-only / reselect_required (D6, AC-03) ──────────

  it("refuses registration with reselect_required when the MAC is absent from the fresh cache", () => {
    __setLiveCacheAccessorForTests(() =>
      freshSnapshot({
        clients: [{ mac: "11:22:33:44:55:66", displayName: null, isBlocked: false }],
      })
    );

    expect(() => register(FIXED_MAC, "Alias")).toThrow(NetworkDeviceReselectRequiredError);
    try {
      register(FIXED_MAC, "Alias");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkDeviceReselectRequiredError);
      const reselectErr = err as NetworkDeviceReselectRequiredError;
      expect(reselectErr.code).toBe("reselect_required");
      expect(reselectErr.mac).toBe(FIXED_MAC); // still available as a non-message property
      expect(reselectErr.message).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    }
    expect(countDeviceRows()).toBe(0);
  });

  it("refuses registration with reselect_required when the cache is not currently fresh (stale/cold/unconfigured)", () => {
    for (const state of ["stale", "cold", "unconfigured"] as const) {
      __setLiveCacheAccessorForTests(() =>
        freshSnapshot({
          state,
          // Even if a matching MAC happens to be present, a non-current cache still refuses —
          // "current fresh cache" gates on STATE, not incidental client-list contents.
          fetchedAt: state === "unconfigured" ? null : 1_000_000,
        })
      );
      expect(() => register(FIXED_MAC, "Alias")).toThrow(NetworkDeviceReselectRequiredError);
    }
    expect(countDeviceRows()).toBe(0);
  });

  // ── register — lastSeenAt observation-only (INV-10) ─────────────────

  it("stamps lastSeenAt from the cache snapshot's fetchedAt observation, never a wall-clock default", () => {
    const observedAt = 1_700_000_000_000; // arbitrary, deliberately far from Date.now
    __setLiveCacheAccessorForTests(() => freshSnapshot({ fetchedAt: observedAt }));

    const device = register(FIXED_MAC, "Alias");
    expect(device.lastSeenAt).toBe(observedAt);
    expect(rawRow(device.id).last_seen_at).toBe(observedAt);
    expect(device.lastSeenAt).not.toBeCloseTo(Date.now(), -3);
  });

  // ── register — member assignment (AC-07) ────────────────────────────

  it("registration with a NEW non-null memberId requires an active member", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const archivedId = seedMember("archived");

    expect(() => register(FIXED_MAC, "Alias", archivedId)).toThrow(MemberReferenceError);
    expect(countDeviceRows()).toBe(0);

    const activeId = seedMember("active");
    const device = register(FIXED_MAC, "Alias", activeId);
    expect(device.memberId).toBe(activeId);
    expect(device.memberInactive).toBe(false);
  });

  // ── edit — MAC immutability (INV-02) ────────────────────────────────

  it("edit never mutates the MAC, regardless of which fields are patched", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const device = register(FIXED_MAC, "Original alias");

    const updated = edit(device.id, { alias: "Renamed" });
    expect(updated.mac).toBe(FIXED_MAC);
    expect(updated.alias).toBe("Renamed");
    expect(rawRow(device.id).mac).toBe(FIXED_MAC);

    // Mutation-killing (`EditDeviceInput` has NO `mac` property — this cast deliberately
    // defeats that compile-time fence): even if a caller forces a `mac` through at the JS
    // level, the raw stored row's MAC must stay unchanged. Without this cast+assertion, a
    // future "convenience" that adds `mac?: string` to `EditDeviceInput` and threads it into
    // the UPDATE statement would pass every other test in this suite untouched.
    edit(device.id, { mac: "11:22:33:44:55:66" } as EditDeviceInput);
    expect(rawRow(device.id).mac).toBe(FIXED_MAC);
  });

  it("edit on an unknown id throws NetworkDeviceNotFoundError", () => {
    expect(() => edit("does-not-exist", { alias: "X" })).toThrow(NetworkDeviceNotFoundError);
  });

  // ── edit — inactive-member strict-write / tolerant-read (AC-07) ─────

  it("edit rejects a NEW non-null memberId that resolves to an inactive member (strict-write)", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const device = register(FIXED_MAC, "Alias");
    const archivedId = seedMember("archived");

    expect(() => edit(device.id, { memberId: archivedId })).toThrow(MemberReferenceError);
    expect(rawRow(device.id).member_id).toBeNull();
  });

  it("an existing inactive member link renders labeled (tolerant-read) and the device stays editable", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const memberId = seedMember("active");
    const device = register(FIXED_MAC, "Alias", memberId);

    // Member is deactivated AFTER assignment — the existing link is not re-validated.
    getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberId);

    // Editing an UNRELATED field (alias) must still succeed without touching memberId.
    const edited = edit(device.id, { alias: "Still editable" });
    expect(edited.alias).toBe("Still editable");
    expect(edited.memberId).toBe(memberId);
    expect(edited.memberInactive).toBe(true);
    expect(edited.memberLabel).not.toBeNull();
  });

  // ── edit — liveStatus derived from the REAL live-cache accessor ──

  it("edit() derives liveStatus from the REAL live-cache accessor — a fresh cache confirming the MAC returns online even over a stale stored lastSeenAt", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const device = register(FIXED_MAC, "Alias");

    // Simulate an 8-day-old stored lastSeenAt (has no poller yet to keep it current) while
    // the CURRENT cache confirms the MAC right now — must read "online", never "notDetected".
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const edited = edit(device.id, { alias: "Renamed" });
    expect(edited.liveStatus).toBe("online");
  });

  it("edit() write succeeds even when the live-cache accessor throws, falling back to a LITERAL unknown (no horizon math)", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const device = register(FIXED_MAC, "Alias");

    __setLiveCacheAccessorForTests(() => {
      throw new Error("the controller/cache is down");
    });

    const edited = edit(device.id, { alias: "Renamed while cache is down" });
    expect(edited.alias).toBe("Renamed while cache is down");
    expect(rawRow(device.id).alias).toBe("Renamed while cache is down");
    expect(edited.liveStatus).toBe("unknown");
  });

  // ── remove — local-only, controller/cache-independent (AC-04) ───────

  it("remove succeeds even with a throwing cache accessor — it never consults it", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const device = register(FIXED_MAC, "Alias");

    __setLiveCacheAccessorForTests(() => {
      throw new Error("the controller/cache is down");
    });

    expect(() => remove(device.id)).not.toThrow();
    expect(countDeviceRows()).toBe(0);
  });

  it("remove on an unknown id is a no-op success (idempotent), not a throw", () => {
    expect(() => remove("does-not-exist")).not.toThrow();
  });

  // ── list — zero writes (INV-05/AC-01) ────────────────────────────────

  it("list() performs ZERO writes, asserted at the storage boundary (total_changes unchanged)", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    register(FIXED_MAC, "Alias");
    __setLiveCacheAccessorForTests(() => freshSnapshot({ state: "stale" }));

    const before = totalChanges();
    list(Date.now());
    list(Date.now());
    list(Date.now());
    expect(totalChanges()).toBe(before);
  });

  it("list() issues ZERO write-verb SQL statements — a genuine DB-layer spy (Codex P2, PR #658: total_changes() alone stays green for a zero-row-affecting write)", () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    register(FIXED_MAC, "Alias");
    __setLiveCacheAccessorForTests(() => freshSnapshot({ state: "stale" }));

    const statements = captureExecutedSql(() => {
      list(Date.now());
      list(Date.now());
      list(Date.now());
    });

    // Sanity: the spy actually captured the real SELECTs list issues.
    expect(statements.length).toBeGreaterThan(0);
    expect(writeStatements(statements)).toEqual([]);
  });

  // ── list — liveStatus matrix with injected clock ────────────────────

  describe("liveStatus derivation matrix", () => {
    it("online: MAC present in a fresh cache", () => {
      __setLiveCacheAccessorForTests(() => freshSnapshot());
      const device = register(FIXED_MAC, "Alias");

      __setLiveCacheAccessorForTests(() => freshSnapshot({ fetchedAt: 2_000_000 }));
      const { devices } = list(device.lastSeenAt! + 1000);
      expect(devices.find((d) => d.id === device.id)?.liveStatus).toBe("online");
    });

    it("notDetected: absent from a fresh cache", () => {
      __setLiveCacheAccessorForTests(() => freshSnapshot());
      const device = register(FIXED_MAC, "Alias");

      __setLiveCacheAccessorForTests(() => freshSnapshot({ clients: [] }));
      const { devices, cacheState } = list(device.lastSeenAt! + 1000);
      expect(cacheState).toBe("fresh");
      expect(devices.find((d) => d.id === device.id)?.liveStatus).toBe("notDetected");
    });

    it("unknown: cache not fresh (stale/cold/unconfigured) and within the not-detected horizon", () => {
      __setLiveCacheAccessorForTests(() => freshSnapshot());
      const device = register(FIXED_MAC, "Alias");
      const recentNow = device.lastSeenAt! + 60_000; // 1 minute later, well within 7 days

      for (const state of ["stale", "cold", "unconfigured"] as const) {
        __setLiveCacheAccessorForTests(() => freshSnapshot({ state, clients: [] }));
        const { devices } = list(recentNow);
        expect(devices.find((d) => d.id === device.id)?.liveStatus).toBe("unknown");
      }
    });

    it("notDetected: lastSeenAt beyond the 7-day horizon even while the cache is not currently fresh", () => {
      __setLiveCacheAccessorForTests(() => freshSnapshot());
      const device = register(FIXED_MAC, "Alias");
      const eightDaysLater = device.lastSeenAt! + 8 * 24 * 60 * 60 * 1000;

      __setLiveCacheAccessorForTests(() => freshSnapshot({ state: "cold", clients: [] }));
      const { devices } = list(eightDaysLater);
      expect(devices.find((d) => d.id === device.id)?.liveStatus).toBe("notDetected");
    });

    it("online wins over a stale stored lastSeenAt when the MAC is directly confirmed in a CURRENT fresh cache", () => {
      __setLiveCacheAccessorForTests(() => freshSnapshot());
      const device = register(FIXED_MAC, "Alias");
      const eightDaysLater = device.lastSeenAt! + 8 * 24 * 60 * 60 * 1000;

      // has no poller yet to refresh lastSeenAt on every observation — a
      // direct current-cache confirmation must still win as "online" over a stale DB value.
      __setLiveCacheAccessorForTests(() => freshSnapshot({ fetchedAt: eightDaysLater }));
      const { devices } = list(eightDaysLater);
      expect(devices.find((d) => d.id === device.id)?.liveStatus).toBe("online");
    });

    it("notDetected: never seen (lastSeenAt NULL) — the column is nullable in the schema even though register() never inserts NULL (INV-10)", () => {
      const db = getDb();
      const now = Date.now();
      const id = `${now}-never-seen`;
      db.prepare(
        `INSERT INTO network_devices
           (id, mac, alias, member_id, is_blocked, belief_diverged_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, 'Never seen', NULL, 0, NULL, NULL, ?, ?)`
      ).run(id, "22:33:44:55:66:77", now, now);

      __setLiveCacheAccessorForTests(() => freshSnapshot({ state: "cold", clients: [] }));
      const { devices } = list(now);
      expect(devices.find((d) => d.id === id)?.liveStatus).toBe("notDetected");
    });
  });
});
