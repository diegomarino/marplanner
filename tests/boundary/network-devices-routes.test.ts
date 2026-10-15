import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { reconcileManagement } from "../../src/server/auth/reconcile.ts";
import { useIsolatedDb } from "../helpers/db";
import {
  __setLiveCacheAccessorForTests,
  NetworkDeviceControllerUnavailableError,
} from "../../src/server/modules/network-devices/index.ts";
import type { LiveCacheSnapshot } from "../../src/server/modules/network-devices/index.ts";
import {
  __setUniFiClientForTests,
  UniFiControllerRejectedError,
} from "../../src/server/modules/network-devices/client.ts";
import type { UniFiClient } from "../../src/server/modules/network-devices/client.ts";

/** docs/features/network-devices.md — HTTP surface (* contracts/openapi.yaml, FR-001/FR-012/FR-014/FR-017/FR-018). trap-sweep.md row the * named unknowns: "assert-no-ip at the SCHEMA level... not just payload sampling" and "502
 * branch: nothing mirrored" — both exercised below.
 * Every test builds its OWN `buildApp` instance (this domain's routes are registered
 * app-wide, not as a scratch Fastify stand-in) and authenticates over the REAL cookie/auth
 * boundary — `mp_device_key`, hashed+looked-up per request (`authBoundary`) — never by
 * hand-attaching `apiKeyId` (that would bypass the exact boundary this suite proves).
 */
describe("network-devices routes", () => {
  useIsolatedDb();

  afterEach(() => {
    __setLiveCacheAccessorForTests(undefined);
    __setUniFiClientForTests(undefined);
  });

  const MAC = "aa:bb:cc:dd:ee:ff";
  const MAC_SHAPED = /([0-9a-f]{2}:){5}[0-9a-f]{2}/i;

  function freshSnapshot(overrides?: Partial<LiveCacheSnapshot>): LiveCacheSnapshot {
    return {
      state: "fresh",
      clients: [{ mac: MAC, displayName: "Marta's iPad", isBlocked: false }],
      fetchedAt: 1_000_000,
      lastError: "none",
      ...overrides,
    };
  }

  function seedBootstrapKey(bootstrapKey: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
      )
      .run(`${now}-bootstrap`, hashKey(bootstrapKey), now);
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

  function rawDeviceRow(id: string): { is_blocked: number; belief_diverged_at: number | null } {
    return getDb()
      .prepare("SELECT is_blocked, belief_diverged_at FROM network_devices WHERE id = ?")
      .get(id) as { is_blocked: number; belief_diverged_at: number | null };
  }

  /** Provision a genuine device key through the REAL `/api/auth/provision` route — `kind='device'`,
   * `scope='*'` (the false-green precondition D1/ documents; mirrors
   * network-devices-auth.test.ts's `provisionRealDeviceKey`). Returns the RAW key (only ever
   * observable via Set-Cookie — the response body never carries it, FR-007) so it can be
   * presented as the `mp_device_key` cookie on a REAL HTTP request through the whole app.
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
      const rawSetCookie = res.headers["set-cookie"];
      const cookies = Array.isArray(rawSetCookie)
        ? rawSetCookie
        : rawSetCookie
          ? [rawSetCookie]
          : [];
      const deviceCookie = cookies.find((c) => c.startsWith("mp_device_key="));
      if (!deviceCookie) throw new Error("provision did not set an mp_device_key cookie");
      const match = deviceCookie.match(/mp_device_key=([^;]+)/);
      if (!match) throw new Error("could not parse the mp_device_key cookie value");
      return match[1];
    } finally {
      await app.close();
    }
  }

  /** Provision a genuine management key through the REAL reconcile path (* `reconcileManagement`) — `kind='integration', scope='*'`, mirroring
   * network-devices-auth.test.ts's `provisionRealManagementKey`.
   */
  function provisionRealManagementKey(): string {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.MP_MANAGEMENT_KEY = rawKey;
    reconcileManagement();
    return rawKey;
  }

  function assertNoIpProperty(value: unknown): void {
    if (Array.isArray(value)) {
      for (const v of value) assertNoIpProperty(v);
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        expect(key.toLowerCase()).not.toBe("ip");
        assertNoIpProperty(v);
      }
    }
  }

  // ── The auth matrix — every endpoint x method (trap-sweep) ────────────────────────

  const ROUTES: Array<{
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: "GET", url: "/api/network-devices" },
    { method: "GET", url: "/api/network-devices/live-clients" },
    { method: "POST", url: "/api/network-devices", payload: { mac: MAC, alias: "x" } },
    { method: "PATCH", url: "/api/network-devices/does-not-exist", payload: { alias: "y" } },
    { method: "DELETE", url: "/api/network-devices/does-not-exist" },
    { method: "POST", url: "/api/network-devices/does-not-exist/block" },
    { method: "POST", url: "/api/network-devices/does-not-exist/unblock" },
  ];

  it("NETWORK-DEVICES-AC-06: a REAL device key (kind='device', scope='*') passes the auth gate on EVERY endpoint x method (never 403)", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      for (const route of ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          cookies: { mp_device_key: deviceKey },
          payload: route.payload,
        });
        expect(res.statusCode, `${route.method} ${route.url}`).not.toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it("an unauthenticated request is rejected on EVERY endpoint x method", async () => {
    const app = await buildApp();
    try {
      for (const route of ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          payload: route.payload,
        });
        expect([401, 403], `${route.method} ${route.url}`).toContain(res.statusCode);
      }
    } finally {
      await app.close();
    }
  });

  it("a REAL management key (kind='integration', via reconcileManagement) passes the auth gate on EVERY endpoint x method (never 403)", async () => {
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      for (const route of ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          cookies: { mp_device_key: mgmtKey },
          payload: route.payload,
        });
        expect(res.statusCode, `${route.method} ${route.url}`).not.toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  // ── GET /api/network-devices/live-clients — cache state matrix ─────────────────────────────

  const CACHE_STATES = ["unconfigured", "cold", "stale", "freshEmpty", "fresh"] as const;

  it.each(CACHE_STATES)(
    "GET /api/network-devices/live-clients — cache state '%s' surfaces verbatim",
    async (state) => {
      const isCurrent = state === "fresh" || state === "freshEmpty";
      __setLiveCacheAccessorForTests(() => ({
        state,
        clients: state === "fresh" ? [{ mac: MAC, displayName: "d", isBlocked: false }] : [],
        fetchedAt: isCurrent ? 1_000_000 : null,
        lastError: state === "unconfigured" ? "unconfigured" : "none",
      }));
      const mgmtKey = provisionRealManagementKey();
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/network-devices/live-clients",
          cookies: { mp_device_key: mgmtKey },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Object.keys(body).sort()).toEqual(["clients", "state"]);
        expect(body.state).toBe(state);
        expect(Array.isArray(body.clients)).toBe(true);
        if (body.clients.length > 0) {
          // Pin the closed LiveClient wire shape — an
          // unpinned key set would silently admit a leaked `ipAddress`/`ip` field on a
          // client entry (the reviewer's M5' mutation) without any assertion here failing.
          expect(Object.keys(body.clients[0]).sort()).toEqual(["displayName", "isBlocked", "mac"]);
        }
        assertNoIpProperty(body);
      } finally {
        await app.close();
      }
    }
  );

  // ── GET /api/network-devices — list ─────────────────────────────────────────────────────────

  it("GET /api/network-devices — 200, zero-write list reflects a registered device", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "Kid's Tablet" },
      });
      expect(created.statusCode).toBe(201);

      const res = await app.inject({
        method: "GET",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["cacheState", "devices"]);
      expect(body.devices).toHaveLength(1);
      expect(body.devices[0].mac).toBe(MAC);
      // Pin the closed RegisteredDevice wire shape per-device —
      // same rationale as the picker's per-client pin above: an unpinned key set would
      // silently admit a leaked field on a LIST-endpoint device row without failing here.
      expect(Object.keys(body.devices[0]).sort()).toEqual(
        [
          "alias",
          "beliefDiverged",
          "id",
          "isBlocked",
          "lastSeenAt",
          "liveStatus",
          "mac",
          "memberId",
          "memberInactive",
          "memberLabel",
        ].sort()
      );
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/network-devices — register ────────────────────────────────────────────────────

  it("POST /api/network-devices — 201 with the closed RegisteredDevice shape", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "Kid's Tablet" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(
        [
          "alias",
          "beliefDiverged",
          "id",
          "isBlocked",
          "lastSeenAt",
          "liveStatus",
          "mac",
          "memberId",
          "memberInactive",
          "memberLabel",
        ].sort()
      );
      expect(body.mac).toBe(MAC);
      expect(body.alias).toBe("Kid's Tablet");
      expect(body.memberId).toBeNull();
      expect(body.isBlocked).toBe(false);
      expect(body.beliefDiverged).toBe(false);
      expect(body.lastSeenAt).toBe(1_000_000);
      expect(body.liveStatus).toBe("online");
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("POST /api/network-devices — 409 reselect_required when the MAC is absent from the current fresh cache", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot({ clients: [] }));
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "x" },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      expect(body.code).toBe("reselect_required");
      expect(body.error).not.toMatch(MAC_SHAPED);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("POST /api/network-devices — 409 duplicate_mac on a second registration of the same MAC", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a" },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "b" },
      });
      expect(second.statusCode).toBe(409);
      const body = JSON.parse(second.body);
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      expect(body.code).toBe("duplicate_mac");
      expect(body.error).not.toMatch(MAC_SHAPED);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("POST /api/network-devices — 400 on an unsupported top-level field (additionalProperties: false)", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a", ip: "192.168.1.5" },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["error"]);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("POST /api/network-devices — alias length bound: 80 chars accepted, 81 chars rejected 400 (Codex P2 on #663)", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a".repeat(80) },
      });
      expect(ok.statusCode).toBe(201);
      expect(JSON.parse(ok.body).alias).toHaveLength(80);

      const tooLong = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: "11:22:33:44:55:66", alias: "a".repeat(81) },
      });
      expect(tooLong.statusCode).toBe(400);
      const body = JSON.parse(tooLong.body);
      expect(Object.keys(body).sort()).toEqual(["error"]);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  // ── PATCH /api/network-devices/:id — edit ───────────────────────────────────────────────────

  it("PATCH /api/network-devices/:id — 200, alias updated", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "old alias" },
      });
      const device = JSON.parse(created.body);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/network-devices/${device.id}`,
        cookies: { mp_device_key: mgmtKey },
        payload: { alias: "new alias" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.alias).toBe("new alias");
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/network-devices/:id — alias length bound: 80 chars accepted, 81 chars rejected 400 (Codex P2 on #663)", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a" },
      });
      const device = JSON.parse(created.body);

      const ok = await app.inject({
        method: "PATCH",
        url: `/api/network-devices/${device.id}`,
        cookies: { mp_device_key: mgmtKey },
        payload: { alias: "b".repeat(80) },
      });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body).alias).toHaveLength(80);

      const tooLong = await app.inject({
        method: "PATCH",
        url: `/api/network-devices/${device.id}`,
        cookies: { mp_device_key: mgmtKey },
        payload: { alias: "b".repeat(81) },
      });
      expect(tooLong.statusCode).toBe(400);
      const body = JSON.parse(tooLong.body);
      expect(Object.keys(body).sort()).toEqual(["error"]);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/network-devices/:id — 400 when assigning a NEW inactive (archived) member", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a" },
      });
      const device = JSON.parse(created.body);
      const archivedMemberId = seedMember("archived");

      const res = await app.inject({
        method: "PATCH",
        url: `/api/network-devices/${device.id}`,
        cookies: { mp_device_key: mgmtKey },
        payload: { memberId: archivedMemberId },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["error"]);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/network-devices/:id — 404 for an unknown id", async () => {
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/network-devices/does-not-exist",
        cookies: { mp_device_key: mgmtKey },
        payload: { alias: "x" },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["error"]);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  // ── DELETE /api/network-devices/:id ──────────────────────────────────────────────────────────

  it("DELETE /api/network-devices/:id — 204, then a re-GET no longer lists it", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a" },
      });
      const device = JSON.parse(created.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/network-devices/${device.id}`,
        cookies: { mp_device_key: mgmtKey },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");

      const list = await app.inject({
        method: "GET",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
      });
      const listBody = JSON.parse(list.body);
      expect(listBody.devices).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/network-devices/:id — 404 for an unknown id (route's OWN existence read, not remove()'s idempotency)", async () => {
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/network-devices/does-not-exist",
        cookies: { mp_device_key: mgmtKey },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["error"]);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/network-devices/:id/block + /unblock ──────────────────────────────────────────

  it("POST /api/network-devices/:id/block — 200, controller called, belief mirror written", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const client: UniFiClient = {
      listClients: vi.fn(async () => []),
      blockMac: vi.fn(async () => {}),
      unblockMac: vi.fn(async () => {}),
    };
    __setUniFiClientForTests(client);
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a" },
      });
      const device = JSON.parse(created.body);

      const res = await app.inject({
        method: "POST",
        url: `/api/network-devices/${device.id}/block`,
        cookies: { mp_device_key: mgmtKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.isBlocked).toBe(true);
      expect(client.blockMac).toHaveBeenCalledWith(MAC);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("POST /api/network-devices/:id/unblock — 200, controller called, belief mirror written", async () => {
    __setLiveCacheAccessorForTests(() => freshSnapshot());
    const client: UniFiClient = {
      listClients: vi.fn(async () => []),
      blockMac: vi.fn(async () => {}),
      unblockMac: vi.fn(async () => {}),
    };
    __setUniFiClientForTests(client);
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: "a" },
      });
      const device = JSON.parse(created.body);

      const res = await app.inject({
        method: "POST",
        url: `/api/network-devices/${device.id}/unblock`,
        cookies: { mp_device_key: mgmtKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.isBlocked).toBe(false);
      expect(client.unblockMac).toHaveBeenCalledWith(MAC);
      assertNoIpProperty(body);
    } finally {
      await app.close();
    }
  });

  it("POST /api/network-devices/:id/block — 404 for an unknown id (checked before any controller call)", async () => {
    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/network-devices/does-not-exist/block",
        cookies: { mp_device_key: mgmtKey },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it.each<[string, UniFiClient | null]>([
    ["controller unconfigured (null)", null],
    [
      "controller rejected (401/403)",
      {
        listClients: vi.fn(async () => []),
        blockMac: vi.fn(async () => {
          throw new UniFiControllerRejectedError();
        }),
        unblockMac: vi.fn(async () => {
          throw new UniFiControllerRejectedError();
        }),
      },
    ],
    [
      "controller unreachable (timeout/network)",
      {
        listClients: vi.fn(async () => []),
        blockMac: vi.fn(async () => {
          throw new Error("boom");
        }),
        unblockMac: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    ],
  ])(
    "POST /api/network-devices/:id/block and unblock — 502 on %s, NOTHING mirrored (row unchanged)",
    async (_label, client) => {
      __setLiveCacheAccessorForTests(() => freshSnapshot());
      // Register with a WORKING client first so the device row exists, then swap in the
      // failing/absent one for the actual block attempt under test.
      __setUniFiClientForTests({
        listClients: vi.fn(async () => []),
        blockMac: vi.fn(async () => {}),
        unblockMac: vi.fn(async () => {}),
      });
      const mgmtKey = provisionRealManagementKey();
      const app = await buildApp();
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/network-devices",
          cookies: { mp_device_key: mgmtKey },
          payload: { mac: MAC, alias: "a" },
        });
        const device = JSON.parse(created.body);
        const before = rawDeviceRow(device.id);
        expect(before.is_blocked).toBe(0);
        expect(before.belief_diverged_at).toBeNull();

        __setUniFiClientForTests(client);
        for (const operation of ["block", "unblock"] as const) {
          getDb()
            .prepare("UPDATE network_devices SET is_blocked = ? WHERE id = ?")
            .run(operation === "unblock" ? 1 : 0, device.id);
          const stateBefore = rawDeviceRow(device.id);
          const res = await app.inject({
            method: "POST",
            url: `/api/network-devices/${device.id}/${operation}`,
            cookies: { mp_device_key: mgmtKey },
          });
          expect(res.statusCode).toBe(502);
          const body = JSON.parse(res.body);
          // the 502 branch now forwards `err.code` too (previously omitted),
          // so a client can distinguish unavailable/rejected/unreachable without pattern-matching
          // `.message` text — the same `{error, code}` shape 409 already used.
          expect(Object.keys(body).sort()).toEqual(["code", "error"]);
          expect(body.code).toMatch(/^controller_(unavailable|rejected|unreachable)$/);
          assertNoIpProperty(body);

          const after = rawDeviceRow(device.id);
          expect(after).toEqual(stateBefore);
          expect(after.belief_diverged_at).toBeNull();
        }
      } finally {
        await app.close();
      }
    }
  );

  it("NetworkDeviceControllerUnavailableError carries no MAC in its message (sanity on the 502 body itself)", () => {
    const err = new NetworkDeviceControllerUnavailableError();
    expect(err.message).not.toMatch(MAC_SHAPED);
  });
});
