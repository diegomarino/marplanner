import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { useIsolatedDb } from "../helpers/db";
import {
  enqueueTestPrint,
  enqueuePrintJob,
  claimJob,
  getPayload,
  ackJob,
  PrintRenderFailureError,
} from "../../src/server/modules/printing/index.ts";
import { subscribe } from "../../src/server/lib/event-bus.ts";
import { todayInHouseholdTz } from "../../src/server/host-api";

/** docs/features/printing.md — four negative fences (FR-005/FR-020).
 * (a) production event payloads are closed to the CONTRACT's canonical shape (src/shared/
 * events.ts, NOT the paraphrase — see the drift note below) — proven through the REAL
 * enqueue→claim→payload→ack flow (module-level, same shape printing-events.test.ts's
 * pins in isolation, this file proves it end to end through the actual pipeline).
 * (b) every object schema in contracts/openapi.yaml is closed (additionalProperties: false) —
 * recursive walk (the 017 precedent, tests/boundary/network-devices-negatives.test.ts).
 * (c) no route serves payload bytes without a VALID lease token: missing / wrong / expired-lease
 * tokens are all rejected with no bits in the response body. Every fixture uses the
 * provider-backed "test-print" record key (the registered `testPrintProvider`) rather than an
 * unregistered one, and each negative is paired with a POSITIVE control — a valid token on
 * the SAME job genuinely serves real ESC/POS bytes — so a permissive-lease regression cannot
 * hide behind a coincidental `render_failure` (an unregistered record key would 422 at render
 * time regardless of the lease check, making the "no bits served" assertion vacuously true).
 * (d) the shared DTOs (PrintJob/ClaimResponse/JobsListResponse) carry no raster/payload-bytes
 * field anywhere — proven at the HTTP boundary, not by re-reading the TS source.
 * DRIFT NOTE (vs the canonical catalog): the own line paraphrases the
 * event shape as `{jobId, timestamp}`. The actual contract — src/shared/events.ts's
 * `CoreEventCatalog`, already pinned by tests/boundary/printing-events.test.ts — is
 * `printing.completed {jobId, outputRef, printedAt}` / `printing.failed {jobId, outputRef,
 * errorCode}`. This file fences THAT shape (the real catalog, the coverage oracle for this
 * guarantee) and leaves the paraphrase uncorrected per implementation scope.
 */
describe("printing negatives — (FR-005, FR-020)", () => {
  useIsolatedDb();

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => {
      queueMicrotask(() => {
        queueMicrotask(() => resolve());
      });
    });
  }

  function seedBootstrapKey(bootstrapKey: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
      )
      .run(`${now}-bootstrap`, hashKey(bootstrapKey), now);
  }

  /** Mirrors printing-routes.test.ts's own helper — printing needs no management key. */
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

  // ── (a) production event payloads closed to the CANONICAL shape ─────────────────────────────

  describe("(a) production event payloads closed to the canonical catalog shape (FR-005/FR-008/FR-009)", () => {
    it("printing.completed via the REAL enqueue→claim→payload→ack flow is closed to exactly {jobId, outputRef, printedAt}", async () => {
      const now = Date.now();
      let received: unknown;
      subscribe("printing.completed", (payload) => {
        received = payload;
      });

      const trigger = enqueueTestPrint(now);
      expect(trigger.enqueued).toBe(true);
      const jobId = trigger.jobId as string;

      const claimed = claimJob(now);
      expect(claimed).not.toBeNull();
      if (!claimed) throw new Error("unreachable");
      expect(claimed.job.id).toBe(jobId);

      const bytes = getPayload(jobId, claimed.leaseToken, now);
      expect(bytes.length).toBeGreaterThan(0);

      const acked = ackJob(jobId, claimed.leaseToken, now);
      expect(acked.state).toBe("printed");

      await flushMicrotasks();

      expect(received).toBeDefined();
      expect(Object.keys(received as object).sort()).toEqual(["jobId", "outputRef", "printedAt"]);
      expect(received).toEqual({ jobId, outputRef: acked.outputRef, printedAt: now });
    });

    it("printing.failed via the REAL getPayload render_failure (permanent) path is closed to exactly {jobId, outputRef, errorCode}", async () => {
      const now = Date.now();
      let received: unknown;
      subscribe("printing.failed", (payload) => {
        received = payload;
      });

      // No provider registered for this record key -> getPayload's own missing-provider branch
      // (a PERMANENT render_failure, "Failure taxonomy").
      const recordKey = "printing-negatives-no-provider";
      const today = todayInHouseholdTz(now);
      const outputRef = `${recordKey}:${today}`;
      const enqueueResult = enqueuePrintJob({ recordKey, targetDate: today, outputRef }, now);
      expect(enqueueResult.enqueued).toBe(true);
      const jobId = enqueueResult.jobId;

      const claimed = claimJob(now);
      expect(claimed).not.toBeNull();
      if (!claimed) throw new Error("unreachable");

      expect(() => getPayload(jobId, claimed.leaseToken, now)).toThrow(PrintRenderFailureError);

      await flushMicrotasks();

      expect(received).toBeDefined();
      expect(Object.keys(received as object).sort()).toEqual(["errorCode", "jobId", "outputRef"]);
      expect(received).toEqual({ jobId, outputRef, errorCode: "render_failure" });
    });
  });

  // ── (b) every OBJECT schema in the contract is closed ────────────────────────────────────────

  describe("(b) contracts/openapi.yaml — every object schema is closed (additionalProperties: false)", () => {
    const contractPath = path.resolve(process.cwd(), "docs/api/printing/openapi.yaml");
    const doc = loadYaml(readFileSync(contractPath, "utf8")) as Record<string, unknown>;

    it("the contract file actually has schemas to scan (sanity — a vacuous scan proves nothing)", () => {
      const schemas =
        (doc as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {};
      expect(Object.keys(schemas).length).toBeGreaterThan(0);
    });

    it("every OBJECT-typed schema anywhere in the contract (named or inline) is closed", () => {
      // Recursive walk over the WHOLE parsed document — an inline path-level request/response
      // body schema (never registered under components.schemas) must not slip through unchecked
      // just because it isn't a top-level named schema (the 017 lesson).
      let checked = 0;
      function walk(node: unknown, nodePath: string): void {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${nodePath}[${i}]`));
          return;
        }
        if (node && typeof node === "object") {
          const record = node as Record<string, unknown>;
          if (record.type === "object" || record.properties !== undefined) {
            checked += 1;
            expect(record.additionalProperties, nodePath).toBe(false);
          }
          for (const [key, value] of Object.entries(record)) {
            walk(value, `${nodePath}.${key}`);
          }
        }
      }
      walk(doc, "$");
      expect(checked).toBeGreaterThan(0); // sanity: something was actually checked
    });
  });

  // ── (c) no route serves payload bytes without a VALID lease token ───────────────────────────

  describe("(c) no route serves payload bytes without a valid lease token", () => {
    const FROZEN_NOW = new Date("2026-06-20T08:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Always the provider-backed `TEST_PRINT_RECORD_KEY` ("test-print", the registered
     * `testPrintProvider`) — never an unregistered record key. Each test in this describe block
     * gets its OWN isolated DB (`useIsolatedDb`'s per-test fresh dir), so reusing the same
     * record key across tests here creates no cross-test collision. */
    const PROVIDER_BACKED_RECORD_KEY = "test-print";

    async function claimFreshJobOverHttp(
      app: Awaited<ReturnType<typeof buildApp>>,
      deviceKey: string,
      recordKey: string = PROVIDER_BACKED_RECORD_KEY
    ): Promise<{ jobId: string; leaseToken: string; leaseExpiresAt: number }> {
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
      return {
        jobId: body.job.id,
        leaseToken: body.leaseToken,
        leaseExpiresAt: body.leaseExpiresAt,
      };
    }

    /** No route may answer a rejected payload request with raster bytes — assert the response is
     * a small JSON error body, never `application/octet-stream`. */
    function assertNoBitsServed(res: { headers: Record<string, unknown>; body: string }): void {
      expect(String(res.headers["content-type"])).not.toMatch(/application\/octet-stream/);
      const parsed: unknown = JSON.parse(res.body); // throws if the body were raw binary, not JSON
      expect(parsed).not.toHaveProperty("bits");
      expect(Buffer.byteLength(res.body, "utf8")).toBeLessThan(500);
    }

    /** POSITIVE control: proves the negative assertions above are fenced by
     * lease validation, not by a coincidental `render_failure` from an unregistered record key —
     * a VALID token on the SAME job must genuinely serve real ESC/POS bytes (begins with the
     * `ESC @` init sequence, escpos.ts), never an empty/placeholder buffer. */
    function assertRealBitsServed(res: {
      statusCode: number;
      headers: Record<string, unknown>;
      rawPayload: Buffer;
    }): void {
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"])).toMatch(/application\/octet-stream/);
      expect(res.rawPayload.length).toBeGreaterThan(0);
      expect(res.rawPayload[0]).toBe(0x1b); // ESC
      expect(res.rawPayload[1]).toBe(0x40); // @ — ESC @ initialise
    }

    it("missing leaseToken query param -> 409, no bits served (valid token on the SAME job DOES serve real bytes)", async () => {
      const deviceKey = await provisionRealDeviceKey();
      const app = await buildApp();
      try {
        const { jobId, leaseToken } = await claimFreshJobOverHttp(app, deviceKey);
        const res = await app.inject({
          method: "GET",
          url: `/api/printing/jobs/${jobId}/payload`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(409);
        assertNoBitsServed(res);

        // Positive control: the SAME job, correctly authorized, genuinely serves bytes.
        const okRes = await app.inject({
          method: "GET",
          url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
          cookies: { mp_device_key: deviceKey },
        });
        assertRealBitsServed(okRes);
      } finally {
        await app.close();
      }
    });

    it("wrong leaseToken -> 409, no bits served, job stays claimed under the ORIGINAL lease (which DOES serve real bytes)", async () => {
      const deviceKey = await provisionRealDeviceKey();
      const app = await buildApp();
      try {
        const { jobId, leaseToken } = await claimFreshJobOverHttp(app, deviceKey);
        const res = await app.inject({
          method: "GET",
          url: `/api/printing/jobs/${jobId}/payload?leaseToken=not-the-real-token`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(409);
        assertNoBitsServed(res);

        const row = getDb()
          .prepare("SELECT state, payload_served_at FROM print_jobs WHERE id = ?")
          .get(jobId) as { state: string; payload_served_at: number | null };
        expect(row.state).toBe("claimed");
        expect(row.payload_served_at).toBeNull();

        // Positive control: the ORIGINAL (correct) lease token, still live, genuinely serves bytes.
        const okRes = await app.inject({
          method: "GET",
          url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
          cookies: { mp_device_key: deviceKey },
        });
        assertRealBitsServed(okRes);
      } finally {
        await app.close();
      }
    });

    it("expired-lease token (correct token, lease elapsed) -> 409, no bits served, lease not extended (a FRESH re-claim on the SAME job DOES serve real bytes)", async () => {
      const deviceKey = await provisionRealDeviceKey();
      const app = await buildApp();
      try {
        const { jobId, leaseToken, leaseExpiresAt } = await claimFreshJobOverHttp(app, deviceKey);

        vi.setSystemTime(new Date(leaseExpiresAt + 1_000));

        const res = await app.inject({
          method: "GET",
          url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(409);
        assertNoBitsServed(res);

        // The rejected fetch must not have extended the (already-expired) lease.
        const row = getDb()
          .prepare("SELECT lease_expires_at, payload_served_at FROM print_jobs WHERE id = ?")
          .get(jobId) as { lease_expires_at: number; payload_served_at: number | null };
        expect(row.lease_expires_at).toBe(leaseExpiresAt);
        expect(row.payload_served_at).toBeNull();

        // Positive control: the lease's EXPIRY (not the job/provider) is what blocked bytes above —
        // the expired lease is now itself re-claimable, and a FRESH lease on the
        // exact same job genuinely serves real bytes.
        const reclaimRes = await app.inject({
          method: "POST",
          url: "/api/printing/claim",
          cookies: { mp_device_key: deviceKey },
        });
        expect(reclaimRes.statusCode).toBe(200);
        const reclaimed = JSON.parse(reclaimRes.body);
        expect(reclaimed.job.id).toBe(jobId);

        const okRes = await app.inject({
          method: "GET",
          url: `/api/printing/jobs/${jobId}/payload?leaseToken=${encodeURIComponent(reclaimed.leaseToken)}`,
          cookies: { mp_device_key: deviceKey },
        });
        assertRealBitsServed(okRes);
      } finally {
        await app.close();
      }
    });
  });

  // ── (d) shared DTOs carry no raster/payload-bytes field ──────────────────────────────────────

  describe("(d) DTOs carry no raster/payload blobs (FR-020, ADR-066 — the server owns bytes, the DTO never does)", () => {
    // Deliberately blunt (network-devices-negatives.test.ts precedent): any object KEY matching
    // this pattern fails, anywhere in the response, no matter how deep.
    const DISALLOWED_KEY_PATTERN = /bit|raster|blob|byte|payload/i;

    function assertNoDisallowedKeys(value: unknown, nodePath = "$"): void {
      if (Array.isArray(value)) {
        value.forEach((child, i) => assertNoDisallowedKeys(child, `${nodePath}[${i}]`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          expect(key, `key at ${nodePath}.${key}`).not.toMatch(DISALLOWED_KEY_PATTERN);
          assertNoDisallowedKeys(child, `${nodePath}.${key}`);
        }
      }
    }

    it("the claim response and the jobs list expose no bits/raster/blob/byte/payload-named field", async () => {
      const deviceKey = await provisionRealDeviceKey();
      const app = await buildApp();
      try {
        const today = todayInHouseholdTz(Date.now());
        const recordKey = "negatives-dto-scan";
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
        const claimBody: unknown = JSON.parse(claimRes.body);
        assertNoDisallowedKeys(claimBody);
        // Sanity: something real was actually scanned, not an empty envelope.
        expect((claimBody as { job: { id: string } }).job.id).toBeTruthy();

        const listRes = await app.inject({
          method: "GET",
          url: "/api/printing/jobs",
          cookies: { mp_device_key: deviceKey },
        });
        expect(listRes.statusCode).toBe(200);
        const listBody: unknown = JSON.parse(listRes.body);
        assertNoDisallowedKeys(listBody);
        expect((listBody as { jobs: unknown[] }).jobs.length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  });
});
