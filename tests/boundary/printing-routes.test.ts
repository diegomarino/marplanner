import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { useIsolatedDb } from "../helpers/db";
import {
  enqueuePrintJob,
  registerPrintableProvider,
  __setPrintingPluginActiveForTests,
} from "../../src/server/modules/printing/index.ts";
import { todayInHouseholdTz } from "../../src/server/lib/household-date.ts";

/** docs/features/printing.md — the full HTTP surface (* contracts/openapi.yaml, FR-006/FR-008/FR-011/FR-013/FR-017/FR-018/FR-021).
 * Every test builds its OWN `buildApp` instance and authenticates over the REAL cookie/auth
 * boundary (`mp_device_key`, `authBoundary`) — never by hand-attaching `apiKeyId` (that would
 * bypass the exact boundary FR-021's capability wiring depends on). The pre-existing tracer path
 * (test-print -> claim -> payload -> ack) is proven end to end in
 * tests/integration/printing-skeleton.test.ts; this file's own scope is EVERYTHING added or
 * changed: capability wiring (FR-021), the `/fail` route, the 422 render_failure mapping, the
 * 400 target_date validity check (Constitution IV), and full-surface 401 coverage.
 */
describe("printing routes — T007", () => {
  useIsolatedDb();

  // claimFreshJob (and the FR-021 positive test) derive `targetDate` from one
  // live `Date.now` read while the HTTP handler's own `claimJob` evaluates a SECOND, later one
  // — straddling household-local midnight between the two flakes every "today" job to
  // structurally unclaimable (204 instead of 200). Freeze the clock for the whole suite (the
  // `daily-briefing-generate.test.ts` precedent: `toFake: ["Date"]` only, so async I/O — fastify's
  // `app.inject` included — is unaffected) so every `Date.now` in this file, in `buildApp`'s
  // route handlers, and inside `todayInHouseholdTz` all read the SAME frozen instant.
  const FROZEN_NOW = new Date("2026-06-15T08:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setPrintingPluginActiveForTests(undefined);
  });

  function seedBootstrapKey(bootstrapKey: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
      )
      .run(`${now}-bootstrap`, hashKey(bootstrapKey), now);
  }

  /** Provision a genuine device key through the REAL `/api/auth/provision` route (mirrors
   * network-devices-routes.test.ts's own `provisionRealDeviceKey`) — printing needs NO
   * management key (kiosk-family function, no controller-sensitive gate).
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

  // Every route x method this surface exposes (id-shaped placeholders resolve through routing
  // regardless of whether the job exists — auth runs BEFORE any handler logic).
  const ROUTES: Array<{
    method: "GET" | "POST";
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: "POST", url: "/api/printing/test-print" },
    { method: "GET", url: "/api/printing/jobs" },
    { method: "GET", url: "/api/printing/status" },
    { method: "POST", url: "/api/printing/capability" },
    { method: "POST", url: "/api/printing/claim" },
    { method: "GET", url: "/api/printing/jobs/does-not-exist/payload?leaseToken=x" },
    { method: "POST", url: "/api/printing/jobs/does-not-exist/ack", payload: { leaseToken: "x" } },
    {
      method: "POST",
      url: "/api/printing/jobs/does-not-exist/fail",
      payload: { leaseToken: "x", reason: "printer offline" },
    },
  ];

  it("unauthenticated — 401 on EVERY endpoint x method", async () => {
    const app = await buildApp();
    try {
      for (const route of ROUTES) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          payload: route.payload,
        });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  // ── GET /status — FR-013 client-side plugin-state read ────────

  it("GET /status — 200 { active: true } by default (no lifecycle registry yet, module-level flag defaults active)", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/printing/status",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ active: true });
    } finally {
      await app.close();
    }
  });

  it("GET /status — 200 { active: false } once the plugin is set inactive", async () => {
    const deviceKey = await provisionRealDeviceKey();
    __setPrintingPluginActiveForTests(false);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/printing/status",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ active: false });
    } finally {
      await app.close();
    }
  });

  // ── FR-021 — capability wiring ───────────────────────────────────────────

  it("FR-021 negative: a bare provisioned session's claim is refused 403 printer_capability_missing", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      enqueuePrintJob(
        { recordKey: "test-print", targetDate: "2026-06-15", outputRef: "test-print:2026-06-15" },
        Date.now()
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/claim",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("printer_capability_missing");
    } finally {
      await app.close();
    }
  });

  it("FR-021 positive: after POST /capability the SAME session claims fine", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const today = todayInHouseholdTz(Date.now());
      enqueuePrintJob(
        { recordKey: "test-print", targetDate: today, outputRef: `test-print:${today}` },
        Date.now()
      );

      const capRes = await app.inject({
        method: "POST",
        url: "/api/printing/capability",
        cookies: { mp_device_key: deviceKey },
      });
      expect(capRes.statusCode).toBe(200);
      expect(JSON.parse(capRes.body)).toEqual({ registered: true });

      const claimRes = await app.inject({
        method: "POST",
        url: "/api/printing/claim",
        cookies: { mp_device_key: deviceKey },
      });
      expect(claimRes.statusCode).toBe(200);
      const claimBody = JSON.parse(claimRes.body);
      expect(claimBody.job.state).toBe("claimed");
      expect(typeof claimBody.leaseToken).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("POST /capability — 409 while the printing plugin is inactive (FR-013)", async () => {
    const deviceKey = await provisionRealDeviceKey();
    __setPrintingPluginActiveForTests(false);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/capability",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  // ── shared claim-setup helper (used by the /ack and /fail sections below) ──

  async function claimFreshJob(
    app: Awaited<ReturnType<typeof buildApp>>,
    deviceKey: string,
    recordKey: string
  ): Promise<{ jobId: string; leaseToken: string }> {
    const today = todayInHouseholdTz(Date.now());
    enqueuePrintJob(
      { recordKey, targetDate: today, outputRef: `${recordKey}:${today}` },
      Date.now()
    );
    await app.inject({
      method: "POST",
      url: "/api/printing/capability",
      cookies: { mp_device_key: deviceKey },
    });
    const claimRes = await app.inject({
      method: "POST",
      url: "/api/printing/claim",
      cookies: { mp_device_key: deviceKey },
    });
    expect(claimRes.statusCode).toBe(200);
    const body = JSON.parse(claimRes.body);
    return { jobId: body.job.id, leaseToken: body.leaseToken };
  }

  it("serves exact binary payload bytes and acknowledges the same lease idempotently", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const bits = Uint8Array.from({ length: 72 }, (_, i) => (i % 2 ? 0xff : 0x00));
      registerPrintableProvider("transport-check", () => ({ bits, width: 576, height: 1 }));
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "transport-check");
      const payload = await app.inject({
        method: "GET",
        url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(payload.statusCode).toBe(200);
      expect(payload.headers["content-type"]).toBe("application/octet-stream");
      expect(payload.rawPayload).toEqual(
        Buffer.from([
          0x1b,
          0x40,
          0x1b,
          0x32,
          0x1d,
          0x76,
          0x30,
          0,
          72,
          0,
          1,
          0,
          ...bits,
          0x1b,
          0x64,
          3,
          0x1d,
          0x56,
          0,
        ])
      );
      const acknowledge = () =>
        app.inject({
          method: "POST",
          url: `/api/printing/jobs/${jobId}/ack`,
          cookies: { mp_device_key: deviceKey },
          payload: { leaseToken },
        });
      const ack = await acknowledge();
      expect(ack.statusCode).toBe(200);
      expect(ack.json()).toMatchObject({ id: jobId, state: "printed", printedAt: Date.now() });
      const repeatedAck = await acknowledge();
      expect(repeatedAck.statusCode).toBe(200);
      expect(repeatedAck.json()).toEqual(ack.json());
      for (const method of ["GET", "POST"] as const) {
        const response = await app.inject({
          method,
          url:
            method === "GET"
              ? "/api/printing/jobs/does-not-exist/payload?leaseToken=x"
              : "/api/printing/jobs/does-not-exist/ack",
          cookies: { mp_device_key: deviceKey },
          ...(method === "POST" ? { payload: { leaseToken: "x" } } : {}),
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: "not_found", message: expect.any(String) });
      }
    } finally {
      await app.close();
    }
  });

  // ── /ack route ────────────────────────────────────────────────────────────

  it("POST /jobs/:id/ack — 409 stale lease token, no state change (INV-05 fencing, HTTP-level)", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId } = await claimFreshJob(app, deviceKey, "test-print-ack-stale");

      const ackRes = await app.inject({
        method: "POST",
        url: `/api/printing/jobs/${jobId}/ack`,
        cookies: { mp_device_key: deviceKey },
        payload: { leaseToken: "not-the-real-token" },
      });
      expect(ackRes.statusCode).toBe(409);

      // Still claimed under the ORIGINAL lease — no state change from the rejected call.
      const listRes = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: deviceKey },
      });
      const job = JSON.parse(listRes.body).jobs.find((j: { id: string }) => j.id === jobId);
      expect(job.state).toBe("claimed");
      expect(job.printedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ── /fail route ───────────────────────────────────────────────────────────

  it("POST /jobs/:id/fail — recoverable (no permanentCode): pending, attempts+1, immediately re-claimable", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "test-print");

      const failRes = await app.inject({
        method: "POST",
        url: `/api/printing/jobs/${jobId}/fail`,
        cookies: { mp_device_key: deviceKey },
        payload: { leaseToken, reason: "printer offline" },
      });
      expect(failRes.statusCode).toBe(200);
      const failBody = JSON.parse(failRes.body);
      expect(failBody.state).toBe("pending");
      expect(failBody.attempts).toBe(1);

      // Immediately re-claimable — no re-trigger needed (recovery class).
      const reclaimRes = await app.inject({
        method: "POST",
        url: "/api/printing/claim",
        cookies: { mp_device_key: deviceKey },
      });
      expect(reclaimRes.statusCode).toBe(200);
      expect(JSON.parse(reclaimRes.body).job.id).toBe(jobId);
    } finally {
      await app.close();
    }
  });

  it("POST /jobs/:id/fail — permanent (permanentCode set): terminal failed, dead-lettered immediately", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "test-print-perm");

      const failRes = await app.inject({
        method: "POST",
        url: `/api/printing/jobs/${jobId}/fail`,
        cookies: { mp_device_key: deviceKey },
        payload: {
          leaseToken,
          reason: "unsupported device",
          permanentCode: "unsupported_transport",
        },
      });
      expect(failRes.statusCode).toBe(200);
      const failBody = JSON.parse(failRes.body);
      expect(failBody.state).toBe("failed");
      expect(failBody.derivedState).toBe("dead-letter");

      // Not re-claimable — permanently dead-lettered.
      const reclaimRes = await app.inject({
        method: "POST",
        url: "/api/printing/claim",
        cookies: { mp_device_key: deviceKey },
      });
      expect(reclaimRes.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("POST /jobs/:id/fail — 409 stale lease token, no state change", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId } = await claimFreshJob(app, deviceKey, "test-print-stale");

      const failRes = await app.inject({
        method: "POST",
        url: `/api/printing/jobs/${jobId}/fail`,
        cookies: { mp_device_key: deviceKey },
        payload: { leaseToken: "not-the-real-token", reason: "printer offline" },
      });
      expect(failRes.statusCode).toBe(409);

      // Still claimed under the ORIGINAL lease — no state change from the rejected call.
      const listRes = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: deviceKey },
      });
      const job = JSON.parse(listRes.body).jobs.find((j: { id: string }) => j.id === jobId);
      expect(job.state).toBe("claimed");
    } finally {
      await app.close();
    }
  });

  it("POST /jobs/:id/fail — 404 for an unknown job id", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/jobs/does-not-exist/fail",
        cookies: { mp_device_key: deviceKey },
        payload: { leaseToken: "x", reason: "printer offline" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("POST /jobs/:id/fail — 400 on a missing/invalid reason", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "test-print-badreason");
      const res = await app.inject({
        method: "POST",
        url: `/api/printing/jobs/${jobId}/fail`,
        cookies: { mp_device_key: deviceKey },
        payload: { leaseToken },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /jobs/:id/fail — 400 on an unknown permanentCode (closed vocabulary — 019's errorCode taxonomy)", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "test-print-badcode");
      const res = await app.inject({
        method: "POST",
        url: `/api/printing/jobs/${jobId}/fail`,
        cookies: { mp_device_key: deviceKey },
        payload: { leaseToken, reason: "printer offline", permanentCode: "not_a_real_code" },
      });
      expect(res.statusCode).toBe(400);

      // Rejected BEFORE any write — still claimed under the ORIGINAL lease, never dead-lettered
      // with an arbitrary errorCode that would otherwise flow into printing.failed {errorCode}.
      const listRes = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: deviceKey },
      });
      const job = JSON.parse(listRes.body).jobs.find((j: { id: string }) => j.id === jobId);
      expect(job.state).toBe("claimed");
    } finally {
      await app.close();
    }
  });

  // ── 422 render_failure mapping (payload route) ──────────────────────────

  it("GET /jobs/:id/payload — 422 render_failure with code when no provider is registered for the record key", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "no-such-provider-record");

      const res = await app.inject({
        method: "GET",
        url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("render_failure");

      // The job is now dead-lettered — never transmitted.
      const listRes = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: deviceKey },
      });
      const job = JSON.parse(listRes.body).jobs.find((j: { id: string }) => j.id === jobId);
      expect(job.state).toBe("failed");
      expect(job.derivedState).toBe("dead-letter");
    } finally {
      await app.close();
    }
  });

  it("GET /jobs/:id/payload — 422 render_failure when the raster violates the packed invariant", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      registerPrintableProvider("bad-raster-record", () => ({
        bits: new Uint8Array(1), // wrong length for width x height below
        width: 576,
        height: 100,
      }));
      const { jobId, leaseToken } = await claimFreshJob(app, deviceKey, "bad-raster-record");

      const res = await app.inject({
        method: "GET",
        url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).code).toBe("render_failure");
    } finally {
      await app.close();
    }
  });

  // ── 400 target_date validity (Constitution IV) ──────────────────────────

  it("POST /test-print — 400 when targetDate is not strictly calendar-valid", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/test-print",
        cookies: { mp_device_key: deviceKey },
        payload: { targetDate: "2026-02-30" }, // Feb 30 never exists
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /test-print — 400 on a malformed (non-calendar-shaped) targetDate", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/test-print",
        cookies: { mp_device_key: deviceKey },
        payload: { targetDate: "not-a-date" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST /test-print — a valid targetDate override enqueues against THAT date", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/test-print",
        cookies: { mp_device_key: deviceKey },
        payload: { targetDate: "2026-03-01" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enqueued).toBe(true);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/printing/jobs",
        cookies: { mp_device_key: deviceKey },
      });
      const job = JSON.parse(listRes.body).jobs.find((j: { id: string }) => j.id === body.jobId);
      expect(job.targetDate).toBe("2026-03-01");
    } finally {
      await app.close();
    }
  });

  // ── 409 plugin-inactive fencing reused across the trigger + claim surface ──

  it("409 plugin-inactive on test-print and claim while the printing plugin is inactive (FR-013)", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      // Register capability while the plugin is still active.
      const capRes = await app.inject({
        method: "POST",
        url: "/api/printing/capability",
        cookies: { mp_device_key: deviceKey },
      });
      expect(capRes.statusCode).toBe(200);

      __setPrintingPluginActiveForTests(false);

      const triggerRes = await app.inject({
        method: "POST",
        url: "/api/printing/test-print",
        cookies: { mp_device_key: deviceKey },
      });
      expect(triggerRes.statusCode).toBe(409);

      const claimRes = await app.inject({
        method: "POST",
        url: "/api/printing/claim",
        cookies: { mp_device_key: deviceKey },
      });
      expect(claimRes.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
