import http from "node:http";
import { createConnection } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("HTTP shutdown drainage", () => {
  const fixture = useIsolatedDb();

  it("preserves an asynchronous handler's durable writes and complete response after close begins", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const key = seedAdminKey();
    const writePath = join(fixture.dir(), "http-drain.txt");
    let release!: () => void;
    let entered!: () => void;
    let closing!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    const shutdown = new Promise<void>((done) => {
      closing = done;
    });
    app.addHook("preClose", async () => {
      closing();
    });
    app.get("/api/__shutdown-write", async () => {
      entered();
      await resume;
      writeFileSync(writePath, "first durable write\n");
      await new Promise((done) => setImmediate(done));
      writeFileSync(`${writePath}.second`, "second durable write\n");
      return { complete: true, content: "x".repeat(128_000) };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const agent = new http.Agent({ keepAlive: true });
    const response = new Promise<{ status: number | undefined; body: string }>((done, reject) => {
      const request = http.get(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/__shutdown-write",
          agent,
          headers: { cookie: `mp_device_key=${key}` },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += String(chunk);
          });
          res.on("error", reject);
          res.on("end", () => done({ status: res.statusCode, body }));
        }
      );
      request.on("error", reject);
    });
    let closed: Promise<void> | undefined;
    try {
      await started;
      closed = app.close();
      await shutdown;
      await new Promise((done) => setTimeout(done, 75));
      release();
      const received = await response;
      expect(received.status).toBe(200);
      expect(JSON.parse(received.body)).toEqual({ complete: true, content: "x".repeat(128_000) });
      expect(readFileSync(writePath, "utf8")).toBe("first durable write\n");
      expect(readFileSync(`${writePath}.second`, "utf8")).toBe("second durable write\n");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("HTTP close stayed pending after handler completed")),
              1000
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(getInFlightCount()).toBe(0);
    } finally {
      release();
      agent.destroy();
      await (closed ?? app.close());
    }
  }, 10_000);

  it("does not discard a partial HTTP header while closing", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const accepted = new Promise<void>((done) =>
      app.server.once("connection", (socket) => {
        socket.once("data", () => done());
      })
    );
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => {});
    let closed: Promise<void> | undefined;
    try {
      await new Promise<void>((done) => socket.once("connect", done));
      socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
      await accepted;
      let completed = false;
      closed = app.close().then(() => {
        completed = true;
      });
      await new Promise((done) => setTimeout(done, 100));
      expect(completed).toBe(false);
      expect(socket.destroyed).toBe(false);
    } finally {
      socket.destroy();
      await (closed ?? app.close());
    }
  });
  it("drains a streamed request body received after shutdown begins", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    const key = seedAdminKey();
    const writePath = join(fixture.dir(), "streamed-body.txt");
    app.post("/api/__shutdown-stream", async (request) => {
      writeFileSync(writePath, JSON.stringify(request.body));
      return { received: request.body };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const parsed = new Promise<void>((done) => app.server.once("request", () => done()));
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    const response = new Promise<string>((done, reject) => {
      let body = "";
      socket.on("data", (chunk) => {
        body += String(chunk);
      });
      socket.on("end", () => done(body));
      socket.on("error", reject);
    });
    let closed: Promise<void> | undefined;
    try {
      await new Promise<void>((done) => socket.once("connect", done));
      const body = '{"value":"complete"}';
      socket.write(
        `POST /api/__shutdown-stream HTTP/1.1\r\nHost: localhost\r\nCookie: mp_device_key=${key}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body.slice(0, 5)}`
      );
      await parsed;
      closed = app.close();
      await new Promise((done) => setTimeout(done, 75));
      expect(socket.destroyed).toBe(false);
      socket.write(body.slice(5));
      const received = await response;
      expect(received).toContain("HTTP/1.1 200 OK");
      expect(received).toContain('{"received":{"value":"complete"}}');
      expect(readFileSync(writePath, "utf8")).toBe(body);
      await closed;
    } finally {
      socket.destroy();
      await (closed ?? app.close());
    }
  }, 10_000);

  it("discards a never-requested connection accepted during preClose and removes its listeners", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((done) => {
      entered = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    app.addHook("preClose", async () => {
      entered();
      await resume;
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const before = app.server.listenerCount("connection");
    const closed = app.close();
    await paused;
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => {});
    socket.resume();
    try {
      await new Promise<void>((done) => socket.once("close", () => done()));
      expect(socket.bytesWritten).toBe(0);
    } finally {
      release();
      socket.destroy();
      await closed;
    }
    expect(app.server.listenerCount("connection")).toBe(before - 1);
  });
});
