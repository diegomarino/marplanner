import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import {
  __setQuiescedForTests,
  getInFlightCount,
  RESTORE_ROUTE_PATH,
} from "../../src/server/backups/restore";

/** app.ts's global quiesce onRequest/onResponse/onRequestAbort hook (FR-006/D5),
 * tested directly at the HTTP boundary — reviews (deterministic 503 shape / restore-route
 * exemption / /health untouched) and (in-flight counter release on a client-aborted socket,
 * the case `onResponse` does NOT cover).
 */

function seedAdminKey(): string {
  const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(id, hashKey(rawKey), Date.now());
  return rawKey;
}

describe("backups quiesce hook — deterministic boundary (review P3-4)", () => {
  useIsolatedDb();
  afterEach(() => {
    __setQuiescedForTests(false);
  });

  it("503s every /api/* request with the quiescing envelope + Retry-After while quiesced", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      __setQuiescedForTests(true);
      const res = await app.inject({ method: "GET", url: "/api/backups" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("2");
      const body = JSON.parse(res.body);
      expect(body).toEqual({ error: "quiescing", message: expect.any(String) });
    } finally {
      await app.close();
    }
  });

  it("exempts the restore route itself from the quiesce 503 (falls through to normal auth handling)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      __setQuiescedForTests(true);
      const res = await app.inject({ method: "POST", url: RESTORE_ROUTE_PATH, payload: {} });
      // Never the quiesce 503 envelope — this route is excluded from the short-circuit.
      expect(res.statusCode).not.toBe(503);
      // No auth cookie supplied — falls through to the normal fail-closed 401, proving the
      // request genuinely reached authBoundary rather than being intercepted.
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("leaves /health completely untouched while quiesced (out of scope — not /api/*)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      __setQuiescedForTests(true);
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("does not 503 /api/* when NOT quiesced (falls through to normal auth handling)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/backups" });
      expect(res.statusCode).toBe(401); // normal fail-closed auth, never the quiesce envelope
    } finally {
      await app.close();
    }
  });
});

describe("runtime mounted restore quiescing", () => {
  useIsolatedDb();
  it("quiesces mounted APIs while exempting only the exact restore route and root health", async () => {
    const previous = process.env.BASE_PATH;
    process.env.BASE_PATH = "/family/planner";
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      __setQuiescedForTests(true);
      expect((await app.inject("/family/planner/api/backups")).statusCode).toBe(503);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/family/planner/api/backups/restore",
            payload: {},
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/family/planner/api/backups/restore-extra",
            payload: {},
          })
        ).statusCode
      ).toBe(503);
      expect((await app.inject("/health")).statusCode).toBe(200);
    } finally {
      __setQuiescedForTests(false);
      await app.close();
      if (previous === undefined) delete process.env.BASE_PATH;
      else process.env.BASE_PATH = previous;
    }
  });
});

describe("backups quiesce hook — in-flight counter release on client abort (review P2-1)", () => {
  useIsolatedDb();

  it("a disconnected client stays counted until its handler finishes, then releases the slot", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const rawKey = seedAdminKey();
    const app = await buildApp();

    let releaseHandler: (() => void) | null = null;
    // An ad-hoc slow /api/* route, registered directly on this app instance (before listen) —
    // the SAME global quiesce hooks apply to it as to every other /api/* route.
    app.get("/api/__test-slow-probe", async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return { ok: true };
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("unreachable");
      const port = address.port;

      expect(getInFlightCount()).toBe(0);

      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/__test-slow-probe",
        method: "GET",
        headers: { cookie: `mp_device_key=${rawKey}` },
      });
      req.on("error", () => {
        /* expected once we destroy below — never let it crash the test process */
      });
      req.end();

      // Poll (real, short interval) until the request has genuinely been counted — avoids a
      // race destroying the socket before the server even parsed/dispatched it.
      const countedDeadline = Date.now() + 5000;
      while (getInFlightCount() !== 1) {
        if (Date.now() > countedDeadline) {
          throw new Error("timed out waiting for the in-flight counter to reach 1");
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      req.destroy(); // The transport closes while the handler is still running.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getInFlightCount()).toBe(1);
      if (releaseHandler) (releaseHandler as () => void)();

      const releasedDeadline = Date.now() + 5000;
      while (getInFlightCount() !== 0) {
        if (Date.now() > releasedDeadline) {
          throw new Error(
            `timed out waiting for the in-flight counter to release back to 0 (stuck at ${getInFlightCount()})`
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(getInFlightCount()).toBe(0);
    } finally {
      if (releaseHandler) (releaseHandler as () => void)();
      await app.close();
    }
  }, 10_000);
});

describe("requests closed before handler execution", () => {
  useIsolatedDb();
  it("releases the slot and does not execute a handler after transport closure", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const key = seedAdminKey();
    const app = await buildApp();
    let executed = false;
    app.addHook("preHandler", async (_request, reply) => {
      reply.raw.emit("close");
    });
    app.get("/api/__closed-before-handler", async () => {
      executed = true;
      return { ok: true };
    });
    try {
      await app
        .inject({
          method: "GET",
          url: "/api/__closed-before-handler",
          cookies: { mp_device_key: key },
        })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(executed).toBe(false);
      expect(getInFlightCount()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
