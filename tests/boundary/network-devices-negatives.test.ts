import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadYaml } from "js-yaml";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { reconcileManagement } from "../../src/server/auth/reconcile.ts";
import { useIsolatedDb } from "../helpers/db";
import {
  __setLiveCacheAccessorForTests,
  setLiveCacheAccessor,
  register,
} from "../../src/server/modules/network-devices/index.ts";
import { __setUniFiClientForTests } from "../../src/server/modules/network-devices/client.ts";
import type { UniFiClient } from "../../src/server/modules/network-devices/client.ts";
import { createLiveCache } from "../../src/server/modules/network-devices/cache.ts";
import { pollOnce } from "../../src/server/modules/network-devices/poll.ts";
import { subscribe } from "../../src/server/lib/event-bus.ts";
import { writeClientLog, getClientLogPage } from "../../src/server/telemetry/index.ts";
import { unifiFixtureRawClients, UNIFI_FIXTURE_ONLINE_MAC } from "../helpers/unifi-fixtures.ts";
import {
  createSnapshot,
  resolveBackupsRoot,
  __resetBackupsStateForTests,
} from "../../src/server/backups/storage.ts";

/** docs/features/network-devices.md — negative proofs (FR-012/FR-013/FR-014/
 * FR-015/FR-016, US5 Acceptance Scenarios 2-4, quickstart.md scenario 7/8).
 * ASSERT-AND-PROVE existing behavior — this file builds NO new redaction/filtering. Every
 * assertion below exercises PRODUCTION code (the real normalizer via `pollOnce`, the real
 * telemetry writer via `writeClientLog`, the real event bus singleton via `subscribe`) rather
 * than a hand-rolled stand-in. Per the coordinator brief: if any assertion here fails, the
 * finding is reported, not silently "fixed" by editing production code from this test.
 */
describe("network-devices negatives — (assert-and-prove)", () => {
  useIsolatedDb();

  afterEach(() => {
    __setLiveCacheAccessorForTests(undefined);
    __setUniFiClientForTests(undefined);
    __resetBackupsStateForTests();
  });

  const MAC_SHAPED = /([0-9a-f]{2}:){5}[0-9a-f]{2}/i;

  function provisionRealManagementKey(): string {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.MP_MANAGEMENT_KEY = rawKey;
    reconcileManagement();
    return rawKey;
  }

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => {
      queueMicrotask(() => {
        queueMicrotask(() => resolve());
      });
    });
  }

  // ── 1(a) SCHEMA level: no object schema in the contract admits an ip/ipAddress
  // property, and every response schema is closed (additionalProperties: false) ──────────

  describe("schema-level: contracts/openapi.yaml admits no IP property anywhere", () => {
    const contractPath = path.resolve(process.cwd(), "docs/api/network-devices/openapi.yaml");
    const doc = loadYaml(readFileSync(contractPath, "utf8")) as {
      components?: { schemas?: Record<string, unknown> };
    };
    const schemas = doc.components?.schemas ?? {};

    it("the contract file actually has schemas to scan (sanity — a vacuous scan proves nothing)", () => {
      expect(Object.keys(schemas).length).toBeGreaterThan(0);
    });

    it("no schema property name is 'ip'/'ipAddress' (case-insensitive) anywhere in the contract", () => {
      // Recursive walk over the WHOLE parsed document (not just components.schemas) — a
      // property could in principle be declared inline under a path response body instead of
      // a named schema. Deliberately blunt: any object KEY matching ip/ipAddress fails, no
      // matter how deep.
      function walk(node: unknown, path: string): void {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${path}[${i}]`));
          return;
        }
        if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            expect(key, `key at ${path}.${key}`).not.toMatch(/^ip$|^ipAddress$/i);
            walk(value, `${path}.${key}`);
          }
        }
      }
      walk(doc, "$");
    });

    it("every OBJECT-typed schema anywhere in the contract is closed (additionalProperties: false)", () => {
      // Recursive walk over the WHOLE parsed document, mirroring the IP-key walk above — a
      // future inline nested object (or a path-level inline response schema, never registered
      // under components.schemas) must not be able to slip through unchecked just because it
      // isn't a top-level named schema.
      let checked = 0;
      function walk(node: unknown, path: string): void {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${path}[${i}]`));
          return;
        }
        if (node && typeof node === "object") {
          const record = node as Record<string, unknown>;
          if (record.type === "object" || record.properties !== undefined) {
            checked += 1;
            expect(record.additionalProperties, path).toBe(false);
          }
          for (const [key, value] of Object.entries(record)) {
            walk(value, `${path}.${key}`);
          }
        }
      }
      walk(doc, "$");
      expect(checked).toBeGreaterThan(0); // sanity: something was actually checked
    });
  });

  // ── 1(b) PAYLOAD level: drive every endpoint against the IP-rich fixture through the fake
  // client + the REAL normalizer (pollOnce), deep-scan every response ─────────────────────

  describe("payload-level: the IP-rich fixture never surfaces an IP anywhere", () => {
    const FIXTURE_IPS = [
      "192.168.1.42",
      "192.168.1.43",
      "192.168.1.99",
      "192.168.1.55",
      "10.0.0.5",
      "192.168.1.100",
    ];

    function deepScanForIpLeak(value: unknown, path = "$"): void {
      if (Array.isArray(value)) {
        value.forEach((v, i) => deepScanForIpLeak(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          expect(key.toLowerCase(), `key at ${path}.${key}`).not.toMatch(/^ip$|ipaddress/i);
          deepScanForIpLeak(v, `${path}.${key}`);
        }
        return;
      }
      if (typeof value === "string") {
        for (const ip of FIXTURE_IPS) {
          expect(value, `value at ${path}`).not.toContain(ip);
        }
      }
    }

    it("list / live-clients / register / edit / block / unblock responses are all IP-free", async () => {
      // Drive the REAL client -> REAL normalizeLiveClients (inside pollOnce) -> cache, so the
      // IP drop is proven against the actual production pipeline, not a pre-cleaned stub.
      const client: UniFiClient = {
        listClients: vi.fn(async () => unifiFixtureRawClients()),
        blockMac: vi.fn(async () => {}),
        unblockMac: vi.fn(async () => {}),
      };
      __setUniFiClientForTests(client);
      const cache = createLiveCache({ now: () => 1_000_000 });
      await pollOnce(1_000_000, cache);
      setLiveCacheAccessor(() => cache.getSnapshot());

      const mgmtKey = provisionRealManagementKey();
      const app = await buildApp();
      try {
        const liveClientsRes = await app.inject({
          method: "GET",
          url: "/api/network-devices/live-clients",
          cookies: { mp_device_key: mgmtKey },
        });
        expect(liveClientsRes.statusCode).toBe(200);
        const liveClientsBody = JSON.parse(liveClientsRes.body);
        deepScanForIpLeak(liveClientsBody);
        // Sanity: the fixture's healthy MAC really did make it through the pipeline (a scan
        // over an accidentally-empty picker would vacuously pass).
        expect(
          liveClientsBody.clients.some((c: { mac: string }) => c.mac === UNIFI_FIXTURE_ONLINE_MAC)
        ).toBe(true);

        const registerRes = await app.inject({
          method: "POST",
          url: "/api/network-devices",
          cookies: { mp_device_key: mgmtKey },
          payload: { mac: UNIFI_FIXTURE_ONLINE_MAC, alias: "Negatives Device" },
        });
        expect(registerRes.statusCode).toBe(201);
        const device = JSON.parse(registerRes.body);
        deepScanForIpLeak(device);

        const editRes = await app.inject({
          method: "PATCH",
          url: `/api/network-devices/${device.id}`,
          cookies: { mp_device_key: mgmtKey },
          payload: { alias: "Negatives Device Renamed" },
        });
        expect(editRes.statusCode).toBe(200);
        deepScanForIpLeak(JSON.parse(editRes.body));

        const blockRes = await app.inject({
          method: "POST",
          url: `/api/network-devices/${device.id}/block`,
          cookies: { mp_device_key: mgmtKey },
        });
        expect(blockRes.statusCode).toBe(200);
        deepScanForIpLeak(JSON.parse(blockRes.body));

        const unblockRes = await app.inject({
          method: "POST",
          url: `/api/network-devices/${device.id}/unblock`,
          cookies: { mp_device_key: mgmtKey },
        });
        expect(unblockRes.statusCode).toBe(200);
        deepScanForIpLeak(JSON.parse(unblockRes.body));

        const listRes = await app.inject({
          method: "GET",
          url: "/api/network-devices",
          cookies: { mp_device_key: mgmtKey },
        });
        expect(listRes.statusCode).toBe(200);
        deepScanForIpLeak(JSON.parse(listRes.body));
      } finally {
        await app.close();
      }
    });
  });

  // ── 2: MAC-bearing telemetry entry through the REAL writer emerges redacted ─────────────────

 it("a MAC-bearing telemetry entry through the REAL writeClientLog pipeline emerges redacted ('s patterns, not rebuilt)", () => {
    const rawMac = "AA:BB:CC:DD:EE:01";
    const result = writeClientLog("negatives-test-key", [
      {
        level: "info",
        component: "network-devices",
        message: `observed device ${rawMac}`,
        data: { mac: rawMac, note: `also here ${rawMac}` },
      },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.dropped).toBe(0);

    const page = getClientLogPage({});
    const row = page?.rows.find((r) => r.message.includes("observed device"));
    expect(row).toBeDefined();
    if (!row) throw new Error("unreachable");

    expect(row.message).not.toMatch(MAC_SHAPED);
    expect(row.message).toContain("[redacted]");

    const data = JSON.parse(row.data as string) as { mac: string; note: string };
    expect(data.mac).not.toMatch(MAC_SHAPED);
    expect(data.note).not.toMatch(MAC_SHAPED);
  });

  // ── 3: unifi.* credential values absent from device rows, settings reads, telemetry ─────────

  describe("unifi.* operator-config credential values never leak", () => {
    // every ONE of the four `unifi.*` keys `getOperatorConfig`
    // actually exposes (host-api/index.ts's `OPERATOR_CONFIG_ENV`) gets its OWN distinct
    // marker — the previous version configured all four env vars but swept only the apiKey
    // marker, so a leak of console id/site id/host would have passed silently. `unifi.tlsInsecure`
    // is the only other key OPERATOR_CONFIG_ENV maps, but it is a boolean toggle, not a
    // credential/identifier value — there is nothing marker-shaped to leak, so it is
    // deliberately not given a fake marker here (that would be an unanchored, vacuous sweep).
    const CONFIGURED_MARKERS: ReadonlyArray<{
      operatorKey: string;
      envVar: string;
      marker: string;
    }> = [
      {
        operatorKey: "unifi.apiKey",
        envVar: "UNIFI_API_KEY",
        marker: "unifi-test-marker-9f3e7c21-apikey",
      },
      {
        operatorKey: "unifi.consoleId",
        envVar: "UNIFI_CONSOLE_ID",
        marker: "unifi-test-marker-9f3e7c21-consoleid",
      },
      {
        operatorKey: "unifi.siteId",
        envVar: "UNIFI_SITE_ID",
        marker: "unifi-test-marker-9f3e7c21-siteid",
      },
      {
        operatorKey: "unifi.host",
        envVar: "UNIFI_HOST",
        marker: "unifi-test-marker-9f3e7c21-host",
      },
    ];

    const prevEnv = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const { envVar, marker } of CONFIGURED_MARKERS) {
        prevEnv.set(envVar, process.env[envVar]);
        process.env[envVar] = marker;
      }
    });

    afterEach(() => {
      for (const { envVar } of CONFIGURED_MARKERS) {
        const prev = prevEnv.get(envVar);
        if (prev === undefined) delete process.env[envVar];
        else process.env[envVar] = prev;
      }
    });

    /** Sweep one haystack for EVERY configured marker — a single-marker sweep would silently
     * pass a leak of any of the other three. */
    function assertNoMarkerLeak(haystack: string, context: string): void {
      for (const { marker, envVar } of CONFIGURED_MARKERS) {
        expect(haystack, `${context} leaked ${envVar}`).not.toContain(marker);
      }
    }

    it("a genuinely-configured operator credential never appears in device rows, settings reads, or telemetry", async () => {
      // Sanity: EVERY marker really is what getOperatorConfig would resolve — this is the "test
      // seam" the brief refers to (client.ts's own docblock: getOperatorConfig is the SOLE
      // reader of unifi.* keys). An unanchored marker (one the accessor never actually surfaces)
      // would make its half of the sweep vacuous — asserting the positive read here is what
      // makes each negative assertion below meaningful. We do NOT call
      // createUniFiClient/getUniFiClient for real here — client.ts's production factory
      // THROWS under the test runtime by design, and that exclusivity (only
      // createUniFiClient ever reads these keys) is unit-tested directly in
      // network-devices-client.test.ts, not re-proven here. What THIS test proves instead is the
      // complement: even with every credential genuinely configured, nothing this module
      // returns/stores/logs ever echoes any of them.
      const { getOperatorConfig } = await import("../../src/server/host-api/index.ts");
      for (const { operatorKey, marker } of CONFIGURED_MARKERS) {
        expect(getOperatorConfig(operatorKey), operatorKey).toBe(marker);
      }

      const client: UniFiClient = {
        listClients: vi.fn(async () => []),
        blockMac: vi.fn(async () => {}),
        unblockMac: vi.fn(async () => {}),
      };
      __setUniFiClientForTests(client);
      __setLiveCacheAccessorForTests(() => ({
        state: "fresh",
        clients: [{ mac: "bb:cc:dd:ee:ff:00", displayName: "d", isBlocked: false }],
        fetchedAt: 1_000_000,
        lastError: "none",
      }));

      const mgmtKey = provisionRealManagementKey();
      const app = await buildApp();
      try {
        const registerRes = await app.inject({
          method: "POST",
          url: "/api/network-devices",
          cookies: { mp_device_key: mgmtKey },
          payload: { mac: "bb:cc:dd:ee:ff:00", alias: "Credential Sweep Device" },
        });
        expect(registerRes.statusCode).toBe(201);

        const listRes = await app.inject({
          method: "GET",
          url: "/api/network-devices",
          cookies: { mp_device_key: mgmtKey },
        });
        expect(listRes.statusCode).toBe(200);

        const liveClientsRes = await app.inject({
          method: "GET",
          url: "/api/network-devices/live-clients",
          cookies: { mp_device_key: mgmtKey },
        });
        expect(liveClientsRes.statusCode).toBe(200);

        const settingsRes = await app.inject({
          method: "GET",
          url: "/api/settings",
          cookies: { mp_device_key: mgmtKey },
        });
        expect(settingsRes.statusCode).toBe(200);

        const namedResponses: ReadonlyArray<[string, { body: string }]> = [
          ["register", registerRes],
          ["list", listRes],
          ["live-clients", liveClientsRes],
          ["settings", settingsRes],
        ];
        for (const [label, res] of namedResponses) {
          assertNoMarkerLeak(res.body, label);
        }

        // Storage sweep: none of the four credentials must have been persisted anywhere in the
        // network_devices table either.
        const rows = getDb().prepare("SELECT * FROM network_devices").all();
        assertNoMarkerLeak(JSON.stringify(rows), "network_devices rows");

        // Telemetry sweep: write an unrelated entry through the real pipeline and confirm every
        // credential is absent from the whole client_log table, not just this one row — this
        // module never forwards operator config to telemetry at all, so this is a sweep for
        // absence, not a redaction proof (the redaction corpus itself is telemetry-redact.test.ts's
        // job).
        writeClientLog(mgmtKey, [
          { level: "info", component: "network-devices", message: "unrelated noop entry" },
        ]);
        const page = getClientLogPage({});
        assertNoMarkerLeak(JSON.stringify(page), "telemetry client_log");
      } finally {
        await app.close();
      }
    });
  });

  // ── 4: block/unblock events carry ONLY {deviceId, timestamp} via the REAL host event bus ────

  it("network.device_blocked emitted via the REAL block() call carries ONLY {deviceId, timestamp} — no MAC, no alias", async () => {
    const MAC = "cc:dd:ee:ff:00:11";
    const ALIAS = "Event Payload Device";
    __setLiveCacheAccessorForTests(() => ({
      state: "fresh",
      clients: [{ mac: MAC, displayName: "d", isBlocked: false }],
      fetchedAt: 1_000_000,
      lastError: "none",
    }));
    const client: UniFiClient = {
      listClients: vi.fn(async () => []),
      blockMac: vi.fn(async () => {}),
      unblockMac: vi.fn(async () => {}),
    };
    __setUniFiClientForTests(client);

    let received: unknown;
    subscribe("network.device_blocked", (payload) => {
      received = payload;
    });

    const mgmtKey = provisionRealManagementKey();
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/network-devices",
        cookies: { mp_device_key: mgmtKey },
        payload: { mac: MAC, alias: ALIAS },
      });
      const device = JSON.parse(created.body);

      const blockRes = await app.inject({
        method: "POST",
        url: `/api/network-devices/${device.id}/block`,
        cookies: { mp_device_key: mgmtKey },
      });
      expect(blockRes.statusCode).toBe(200);

      await flushMicrotasks();

      expect(received).toBeDefined();
      expect(Object.keys(received as object).sort()).toEqual(["deviceId", "timestamp"]);
      const payloadJson = JSON.stringify(received);
      expect(payloadJson).not.toMatch(MAC_SHAPED);
      expect(payloadJson).not.toContain(ALIAS);
    } finally {
      await app.close();
    }
  });

  // ── 5: backup asymmetry — MACs BELONG in the backup.db; a REAL snapshot never strips them ──

  it("backup asymmetry: a REAL snapshot's .db file retains the canonical MAC (restore fidelity)", async () => {
    // the previous version of this test asserted MAC retention only at
    // the LIVE storage layer, reasoning in a comment that `createSnapshot`'s whole-file
    // `getDb.backup` copy would therefore carry it too. This version proves the ACTUAL
    // boundary instead — a real snapshot through the production backup path
    // (src/server/backups/storage.ts's `createSnapshot`), independently reopened read-only — so
    // a future change to that path (e.g. a selective export) fails THIS test directly rather
    // than only invalidating a comment's reasoning.
    const uppercaseMac = "DD:EE:FF:00:11:22";
    const cache = createLiveCache({ now: () => 1_000_000 });
    cache.recordSuccess(
      [{ mac: uppercaseMac.toLowerCase(), displayName: "d", isBlocked: false }],
      1_000_000
    );
    setLiveCacheAccessor(() => cache.getSnapshot());

    // Register directly through the REAL module function (not HTTP) — this test is about the
    // backup boundary, not the route surface. `register` canonicalizes the MAC exactly as
    // production does.
    const device = register(uppercaseMac, "Backup Fidelity Device");
    expect(device.mac).toBe(uppercaseMac.toLowerCase());

    // Snapshot through the REAL production path. `useIsolatedDb` already points `DATA_DIR` at
    // a fresh tmp dir for this test — `resolveBackupsRoot`'s default `${DATA_DIR}/backups`
    // needs no extra setup, and that whole tmp dir (backups subdir included) is removed by
    // `useIsolatedDb`'s own afterEach — hermetic with no extra cleanup needed here.
    const outcome = await createSnapshot("snapshot", Date.now());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");

    const root = resolveBackupsRoot();
    const finalPath = path.join(root, outcome.filename);
    const snapshot = new Database(finalPath, { readonly: true, fileMustExist: true });
    try {
      const rows = snapshot.prepare("SELECT mac FROM network_devices").all() as {
        mac: string;
      }[];
      // Non-empty guard: an empty (or wrong) backup would make every assertion below
      // vacuously true — this is what makes the test incapable of passing on an empty backup.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.mac === uppercaseMac.toLowerCase())).toBe(true);
      // The canonical MAC is present, whole, un-redacted, INSIDE THE ACTUAL BACKUP FILE — the
      // restore-fidelity guarantee this test proves.
      for (const row of rows) {
        expect(row.mac).toMatch(MAC_SHAPED);
      }
    } finally {
      snapshot.close();
    }
  });
});
