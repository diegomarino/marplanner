import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { preHandlerAsyncHookHandler } from "fastify";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { requireManagementKey, requireCapability } from "../../src/server/auth/capability.ts";
import { reconcileManagement } from "../../src/server/auth/reconcile.ts";
import { DEVICE_COOKIE } from "../../src/server/auth/cookies.ts";
import { useIsolatedDb } from "../helpers/db";
import { AUTH_SCOPE_DENIED_CODE, AUTH_CREDENTIAL_INVALID_CODE } from "../../src/shared";

/** docs/features/network-devices.md / — `requireManagementKey` (* NETWORK-DEVICES-INV-09/AC-06) + the env-seeded management-key reconcile (maintainer
 * decision 2026-09-04).
 * HIGHEST RISK per trap-sweep.md: the negative test MUST provision its key through the
 * REAL `provision.ts` path (`POST /api/auth/provision`) so it is genuinely `kind='device',
 * scope='*'` — the exact false green D1 documents (`requireCapability`'s `scope === '*'`
 * branch satisfies ANY capability string, so a capability check alone would still admit a
 * device key). A hand-inserted "device-kind" row would prove nothing about the real
 * provisioning flow's shape.
 * Per the maintainer's recorded decision (2026-09-04, review of 607005e): `kind='device'` is
 * the ONLY kind any browser can ever hold — `provisionDevice` hardcodes it, and nothing else
 * mints `kind='integration'`. A hand-inserted "management-kind" row therefore proved nothing
 * about production: no browser or operator flow could ever produce it. The POSITIVE
 * (management-key) tests below now go through `reconcileManagement` — the same
 * `MP_MANAGEMENT_KEY`-gated boot-time seam a real deployment uses (* `src/server/auth/reconcile.ts`) — exactly mirroring how the negative test already used the
 * real provisioning path instead of a hand-inserted device row.
 */
describe("network-devices auth — requireManagementKey (RED-first)", () => {
  useIsolatedDb();

  /** Bootstrap-row seeding precedent: tests/boundary/provision.test.ts `seedBootstrapKey`. */
  function seedBootstrapKey(bootstrapKey: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
      )
      .run(`${now}-bootstrap`, hashKey(bootstrapKey), now);
  }

  /** Provision a genuine device key through the REAL `/api/auth/provision` route
   * (`provision.ts`), exactly as a kiosk would on first connect — `kind='device'`,
   * `scope='*'` (D1's false-green precondition, ADR-030). Returns the minted key's
   * `api_keys.id` so the scratch route below can attach it the same way `authBoundary`
   * would after resolving the cookie.
   */
  async function provisionRealDeviceKey(): Promise<string> {
    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;
    seedBootstrapKey(bootstrapKey);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: { Authorization: `Bearer ${bootstrapKey}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const row = getDb()
      .prepare("SELECT id FROM api_keys WHERE kind = 'device' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!row) {
      throw new Error("provisioning via the real path did not mint a device key row");
    }
    return row.id;
  }

  /** Provision a genuine management key through the REAL reconcile path (* `reconcileManagement`) — sets `MP_MANAGEMENT_KEY` and runs the same idempotent
   * boot-time seam a real deployment relies on. Returns the minted key's `api_keys.id` so
   * the scratch route below can attach it the same way `authBoundary` would after
   * resolving a live credential. Always `kind='integration', scope='*'` — the ONLY shape
   * this reconcile ever produces (maintainer decision 2026-09-04).
   */
  function provisionRealManagementKey(): string {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.MP_MANAGEMENT_KEY = rawKey;
    reconcileManagement();

    // Read back by key_hash (not ORDER BY created_at) — precise to THIS call's key,
    // matching the idempotency test's lookup precedent.
    const row = getDb()
      .prepare("SELECT id FROM api_keys WHERE key_hash = ? AND kind = 'integration'")
      .get(hashKey(rawKey)) as { id: string } | undefined;
    if (!row) {
      throw new Error("reconcileManagement() did not mint a management key row");
    }
    return row.id;
  }

  function buildScratchApp(
    apiKeyId: string | undefined,
    preHandler: preHandlerAsyncHookHandler | preHandlerAsyncHookHandler[]
  ) {
    const app = Fastify();
    // Minimal stand-in for authBoundary (telemetry-capability.test.ts precedent):
    // attach apiKeyId the same way authBoundary does once it has resolved a live cookie.
    app.addHook("onRequest", async (request) => {
      if (apiKeyId) {
        (request as typeof request & { apiKeyId?: string }).apiKeyId = apiKeyId;
      }
    });
    app.get("/probe/management", { preHandler }, async () => ({ ok: true }));
    return app;
  }

  it("NETWORK-DEVICES-AC-06: a device key minted through the REAL provision.ts path is rejected 403", async () => {
    const deviceKeyId = await provisionRealDeviceKey();

    const app = buildScratchApp(deviceKeyId, requireManagementKey());
    try {
      const res = await app.inject({ method: "GET", url: "/probe/management" });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("error", "forbidden");
      //: pin the machine `code` on the wire — `authFetch`
      // (src/client/lib/credential.ts) relies on exactly this value to recognize a
      // scope-403 (live key, denied on scope grounds) and NOT de-provision the kiosk.
      expect(body).toHaveProperty("code", AUTH_SCOPE_DENIED_CODE);
    } finally {
      await app.close();
    }
  });

  it("a management key minted through the REAL reconcileManagement() path passes requireManagementKey", async () => {
    const mgmtKeyId = provisionRealManagementKey();

    const app = buildScratchApp(mgmtKeyId, requireManagementKey());
    try {
      const res = await app.inject({ method: "GET", url: "/probe/management" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("no authenticated apiKeyId attached → 403 (fail-closed)", async () => {
    const app = buildScratchApp(undefined, requireManagementKey());
    try {
      const res = await app.inject({ method: "GET", url: "/probe/management" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("an unknown apiKeyId (no matching row) → 403", async () => {
    const app = buildScratchApp("does-not-exist", requireManagementKey());
    try {
      const res = await app.inject({ method: "GET", url: "/probe/management" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  describe("composes with requireCapability (research D1's false-green matrix)", () => {
    // NOTE: `reconcileManagement` always mints `scope='*'` (maintainer decision
    // 2026-09-04) — a scoped-but-non-'*' management key is not a shape any production
    // reconcile path can produce, so no test here hand-seeds one; generic
    // requireCapability scope-rejection behavior is already covered by
    // tests/boundary/telemetry-capability.test.ts.
    it("a management key minted through the REAL reconcileManagement() path passes BOTH requireManagementKey and requireCapability", async () => {
      const mgmtKeyId = provisionRealManagementKey();

      const app = buildScratchApp(mgmtKeyId, [
        requireManagementKey(),
        requireCapability("network:admin"),
      ]);
      try {
        const res = await app.inject({ method: "GET", url: "/probe/management" });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("THE FALSE GREEN D1 KILLS: a REAL provisioned device key (scope='*') is rejected even composed with requireCapability, despite '*' satisfying ANY capability alone", async () => {
      const deviceKeyId = await provisionRealDeviceKey();

      const app = buildScratchApp(deviceKeyId, [
        requireManagementKey(),
        requireCapability("network:admin"),
      ]);
      try {
        const res = await app.inject({ method: "GET", url: "/probe/management" });
        // requireManagementKey MUST short-circuit before requireCapability ever gets to
        // evaluate this key's scope='*' — a capability check ALONE would have returned 200.
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe("reconcileManagement — (maintainer decision 2026-09-04)", () => {
    it("MP_MANAGEMENT_KEY unset → creates no row (fail-closed default, mirrors reconcileBootstrap)", () => {
      delete process.env.MP_MANAGEMENT_KEY;

      const before = getDb()
        .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE kind = 'integration'")
        .get() as { n: number };

      reconcileManagement();

      const after = getDb()
        .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE kind = 'integration'")
        .get() as { n: number };

      expect(after.n).toBe(before.n);
    });

    it("is idempotent — running twice with the same MP_MANAGEMENT_KEY mints exactly one row", () => {
      const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      process.env.MP_MANAGEMENT_KEY = rawKey;

      reconcileManagement();
      reconcileManagement();

      const rows = getDb()
        .prepare("SELECT id FROM api_keys WHERE key_hash = ? AND kind = 'integration'")
        .all(hashKey(rawKey)) as { id: string }[];

      expect(rows.length).toBe(1);
    });

    it("Codex P1-b: a REVOKED management row is NOT resurrected by a later reconcile — stays revoked, guard still rejects it", async () => {
      const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      process.env.MP_MANAGEMENT_KEY = rawKey;

      // First boot: mints the row.
      reconcileManagement();
      const row = getDb()
        .prepare("SELECT id FROM api_keys WHERE key_hash = ? AND kind = 'integration'")
        .get(hashKey(rawKey)) as { id: string } | undefined;
      if (!row) throw new Error("reconcileManagement() did not mint a management key row");

      // Emergency revocation (e.g. a leak) — operator action, independent of the env var.
      const revokedAt = Date.now();
      getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(revokedAt, row.id);

      // A later restart with MP_MANAGEMENT_KEY UNCHANGED (operator hasn't rotated it yet)
      // must NOT resurrect the revoked row (ADR-030 irreversible-revocation semantics).
      reconcileManagement();

      const after = getDb().prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(row.id) as {
        revoked_at: number | null;
      };
      expect(after.revoked_at).toBe(revokedAt);

      // And the REAL app-wide guard (authBoundary, FR-004) rejects a browser presenting the
      // raw revoked key as its cookie — proving the fix's real-world effect, not just the
      // DB row's shape. `authBoundary` returns 403 ("API key has been revoked") for a
      // known-but-revoked key (distinct from 401 for an unknown/missing one). Had the bug
      // survived, this second reconcile would have cleared revoked_at, and this same cookie
      // would have authenticated successfully (200), not been rejected.
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/members",
          headers: { Cookie: `${DEVICE_COOKIE}=${rawKey}` },
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty("message", "API key has been revoked");
        //: pin the machine `code` on the wire — `authFetch` relies on
        // exactly this value to recognize a dead credential (as opposed to a live key merely
        // denied on scope) and clear the stale `mp_provisioned` marker.
        expect(body).toHaveProperty("code", AUTH_CREDENTIAL_INVALID_CODE);
      } finally {
        await app.close();
      }
    });
  });

  describe("authBoundary — unknown/missing key (#682 review fold, P1)", () => {
    it("an UNRECOGNIZED key presented as the device cookie → 401 'Invalid API key', code credential_invalid", async () => {
      // The real app-wide guard (authBoundary, FR-003/FR-004) — no row at all matches this
      // cookie value, distinct from the revoked-row case above (a known-but-dead key). Both
      // are still credential_invalid (the credential is unusable either way), never
      // scope_denied (that code is reserved for a LIVE key merely denied on scope grounds).
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/members",
          headers: { Cookie: `${DEVICE_COOKIE}=mpg-does-not-exist-${Date.now()}` },
        });
        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty("message", "Invalid API key");
        expect(body).toHaveProperty("code", AUTH_CREDENTIAL_INVALID_CODE);
      } finally {
        await app.close();
      }
    });
  });
});
