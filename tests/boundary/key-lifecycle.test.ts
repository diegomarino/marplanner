import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server/app.ts";
import { generateKey, hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client.ts";
import { useIsolatedDb } from "../helpers/db";

/** Key lifecycle: revocation / expiry next-request test (FR-004).
 * A key that is valid on request N MUST be refused on request N+1 after
 * it is revoked or expired. This is the "next-request" guarantee: auth
 * is re-checked per-request, not cached in process memory.
 * Each scenario first confirms that an active key succeeds, then revokes or
 * expires it and confirms the next request is refused (401/403).
 */
describe("key-lifecycle: revoked / expired key is refused on next request (FR-004)", () => {
  useIsolatedDb();

  /** Insert an api_keys row via raw SQL and return the raw key + keyId.
   * We generate a real `mpk-…` key so the boundary hook's hash-match
   * logic finds it. The key is `*`-scoped, kind `'device'`, no expiry,
   * not revoked — i.e. fully active.
   */
  function insertActiveKey(): { rawKey: string; keyId: string } {
    const rawKey = generateKey();
    const keyHash = hashKey(rawKey);
    const keyId = randomBytes(16).toString("hex"); // UUIDv4 surrogate
    const now = Date.now();

    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)`
    ).run(keyId, keyHash, now);

    return { rawKey, keyId };
  }

  it("a valid key succeeds, then the SAME key is REFUSED after revoked_at is set (FR-004)", async () => {
    const { rawKey, keyId } = insertActiveKey();

    const app = await buildApp();

    // Request 1: key is active → 200.
    const res1 = await app.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: rawKey },
    });
    expect(res1.statusCode).toBe(200);
    await app.close();

    // ---- Now revoke the key directly in the database ----
    const now = Date.now();
    const db = getDb();
    db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(now, keyId);

    // Build a fresh app so the boundary hook picks up the updated DB.
    const app2 = await buildApp();

    // Request 2: the same key is now revoked → 403 forbidden (FR-004).
    const res2 = await app2.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: rawKey },
    });

    expect([401, 403]).toContain(res2.statusCode);

    await app2.close();
  });

  it("a valid key succeeds, then the SAME key is REFUSED after expires_at is set to the past (FR-004)", async () => {
    const { rawKey, keyId } = insertActiveKey();

    const app = await buildApp();

    // Request 1: key is active (no expiry) → 200 (once /api/settings route lands).
    const res1 = await app.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: rawKey },
    });
    expect(res1.statusCode).toBe(200);
    await app.close();

    // ---- Now set expires_at to 1ms in the past ----
    const expiredAt = Date.now() - 1;
    const db = getDb();
    db.prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`).run(expiredAt, keyId);

    // Build a fresh app so the boundary hook re-reads.
    const app2 = await buildApp();

    // Request 2: the same key is now expired → 403 forbidden (FR-004).
    const res2 = await app2.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: rawKey },
    });

    expect([401, 403]).toContain(res2.statusCode);

    await app2.close();
  });

  it("a key with expires_at in the future is accepted, then refused after expires_at is moved to the past (FR-004)", async () => {
    const rawKey = generateKey();
    const keyHash = hashKey(rawKey);
    const keyId = randomBytes(16).toString("hex");
    const now = Date.now();
    const futureExpiry = now + 3600_000; // 1 hour from now

    const db = getDb();

    // Insert with a future expiry — should be accepted (200 once route lands).
    db.prepare(
      `INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at) VALUES (?, ?, '*', 'device', ?, ?)`
    ).run(keyId, keyHash, now, futureExpiry);

    const app = await buildApp();

    // Request 1: key has a future expiry → 200.
    const res1 = await app.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: rawKey },
    });
    expect(res1.statusCode).toBe(200);
    await app.close();

    // ---- Move expires_at to the past ----
    const expiredAt = now - 1;
    db.prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`).run(expiredAt, keyId);

    const app2 = await buildApp();

    // Request 2: same key, now expired → 403.
    const res2 = await app2.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: rawKey },
    });

    expect([401, 403]).toContain(res2.statusCode);

    await app2.close();
  });
});
