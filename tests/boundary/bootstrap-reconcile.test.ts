import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { reconcileBootstrap } from "../../src/server/auth/reconcile.ts";
import { useIsolatedDb } from "../helpers/db";

describe("bootstrap-reconcile — T020 / ADR-032 (idempotent seed)", () => {
  useIsolatedDb();

  it("with MP_BOOTSTRAP_KEY set, inserts exactly one active '*' bootstrap row whose key_hash matches hashKey(MP_BOOTSTRAP_KEY)", () => {
    const bootstrapKey = "mpk-test-reconcile-bootstrap-key";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    reconcileBootstrap();

    const db = getDb();
    const expectedHash = hashKey(bootstrapKey);

    const rows = db
      .prepare(
        "SELECT id, key_hash, scope, kind, created_at, expires_at, revoked_at FROM api_keys WHERE kind = 'bootstrap'"
      )
      .all() as {
      id: string;
      key_hash: string;
      scope: string;
      kind: string;
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
    }[];

    expect(rows.length).toBe(1);

    const row = rows[0];
    expect(row.key_hash).toBe(expectedHash);
    expect(row.scope).toBe("*");
    expect(row.kind).toBe("bootstrap");
    expect(row.revoked_at).toBeNull();
    expect(row.expires_at).toBeNull();
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });

  it("calling reconcileBootstrap() twice yields exactly ONE bootstrap row (idempotency)", () => {
    const bootstrapKey = "mpk-test-idempotency-key";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    reconcileBootstrap();
    reconcileBootstrap();

    const db = getDb();
    const rows = db
      .prepare(
        "SELECT COUNT(*) as count FROM api_keys WHERE kind = 'bootstrap' AND revoked_at IS NULL"
      )
      .get() as { count: number };

    expect(rows.count).toBe(1);
  });

  it("with MP_BOOTSTRAP_KEY unset, no bootstrap row is created", () => {
    delete process.env.MP_BOOTSTRAP_KEY;

    reconcileBootstrap();

    const db = getDb();
    const rows = db
      .prepare("SELECT COUNT(*) as count FROM api_keys WHERE kind = 'bootstrap'")
      .get() as { count: number };

    expect(rows.count).toBe(0);
  });

  it("rejects non-mpk bootstrap key (throws, no row inserted)", () => {
    const prev = process.env.MP_BOOTSTRAP_KEY;
    try {
      process.env.MP_BOOTSTRAP_KEY = "mpg-not-a-real-key";

      expect(() => reconcileBootstrap()).toThrow(
        "MP_BOOTSTRAP_KEY must be an mpk- API key (ADR-037): refusing to seed a non-conforming bootstrap key."
      );

      const db = getDb();
      const rows = db
        .prepare("SELECT COUNT(*) as count FROM api_keys WHERE kind = 'bootstrap'")
        .get() as { count: number };

      expect(rows.count).toBe(0);
    } finally {
      process.env.MP_BOOTSTRAP_KEY = prev;
    }
  });

  it("re-establishes (un-revokes) a revoked bootstrap row and warns", () => {
    const bootstrapKey = "mpk-test-revoked-resurrection-key";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    const db = getDb();
    const keyHash = hashKey(bootstrapKey);
    const now = Date.now();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, '*', 'bootstrap', ?, NULL, ?)"
    ).run(randomUUID(), keyHash, now, now);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    reconcileBootstrap();

    const count = db
      .prepare("SELECT COUNT(*) as count FROM api_keys WHERE kind = 'bootstrap'")
      .get() as { count: number };

    expect(count.count).toBe(1);

    const row = db
      .prepare("SELECT revoked_at FROM api_keys WHERE key_hash = ? AND kind = 'bootstrap' LIMIT 1")
      .get(keyHash) as { revoked_at: number | null };

    expect(row.revoked_at).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("re-establishes an EXPIRED (past expires_at, unrevoked) bootstrap row and warns (issue #110)", () => {
    const bootstrapKey = "mpk-test-expired-resurrection-key";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    const db = getDb();
    const keyHash = hashKey(bootstrapKey);
    const now = Date.now();
    // Seed a row that boundary.ts (FR-004) would reject as expired: revoked_at NULL but
    // expires_at in the past. Reachable only via restore/manual edit today, but reconcile must
    // restore provisionability rather than treat it as "already active".
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, '*', 'bootstrap', ?, ?, NULL)"
    ).run(randomUUID(), keyHash, now - 10_000, now - 1_000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    reconcileBootstrap();

    const count = db
      .prepare("SELECT COUNT(*) as count FROM api_keys WHERE kind = 'bootstrap'")
      .get() as { count: number };
    expect(count.count).toBe(1);

    const row = db
      .prepare(
        "SELECT expires_at, revoked_at FROM api_keys WHERE key_hash = ? AND kind = 'bootstrap' LIMIT 1"
      )
      .get(keyHash) as { expires_at: number | null; revoked_at: number | null };

    // Active again per FR-004: not revoked AND not expired (expires_at cleared to NULL).
    expect(row.revoked_at).toBeNull();
    expect(row.expires_at).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("leaves an already-ACTIVE bootstrap row untouched and does not warn (no spurious re-establish)", () => {
    const bootstrapKey = "mpk-test-active-untouched-key";
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;

    const db = getDb();
    const keyHash = hashKey(bootstrapKey);
    const now = Date.now();
    // Active row with a FUTURE expiry — must be honored as-is (not re-established, no expires_at wipe).
    const futureExpiry = now + 60_000;
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, '*', 'bootstrap', ?, ?, NULL)"
    ).run(randomUUID(), keyHash, now, futureExpiry);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    reconcileBootstrap();

    const row = db
      .prepare(
        "SELECT expires_at, revoked_at FROM api_keys WHERE key_hash = ? AND kind = 'bootstrap' LIMIT 1"
      )
      .get(keyHash) as { expires_at: number | null; revoked_at: number | null };

    // Untouched: future expiry preserved, no warning (row was already active).
    expect(row.expires_at).toBe(futureExpiry);
    expect(row.revoked_at).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
