import { createHash } from "node:crypto";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app";
import { authBoundary } from "../../src/server/auth/boundary";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

useIsolatedDb();

const ACCESS_TOKEN = "mpg-route-boundary-access-token";
const BOOTSTRAP_KEY = "mpg-route-boundary-bootstrap-key";
const DEVICE_KEY = "route-boundary-device-key";
// The frontend gate cookie is a shared browser secret (and public by default), never an API
// credential: requests below carry it so only the API-key boundary stands in the way.
const GATE = `mp_gate=${createHash("sha256").update(ACCESS_TOKEN).digest("hex")}`;
const DEVICE = `mp_device_key=${DEVICE_KEY}`;
const BASE_PATHS = ["", "/family/planner"];

function seedKey(raw: string, kind: "device" | "bootstrap"): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', ?, ?)"
    )
    .run(`${kind}-${now}`, hashKey(raw), kind, now);
}

function memberCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }).n;
}

interface RawResponse {
  status: number;
  headers: string;
  body: string;
}

/** `inject` normalizes the request target, so send the exact bytes over a real socket. */
function rawRequest(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body = ""
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, "Host: planner.test", "Connection: close"];
      const all = { "Content-Length": String(Buffer.byteLength(body)), ...headers };
      for (const [name, value] of Object.entries(all)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const split = data.indexOf("\r\n\r\n");
      const head = data.slice(0, split);
      resolve({
        status: Number(head.split(" ")[1]),
        headers: head.toLowerCase(),
        body: data.slice(split + 4),
      });
    });
  });
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return (app.server.address() as net.AddressInfo).port;
}

async function listenApp(basePath: string): Promise<{ app: FastifyInstance; port: number }> {
  process.env.BASE_PATH = basePath;
  const app = await buildApp();
  return { app, port: await listen(app) };
}

/** Request targets that are not origin-form but that the router would still match. */
function nonOriginForms(basePath: string, apiPath: string): string[] {
  return [
    `http://planner.test${basePath}${apiPath}`,
    `https://planner.test${basePath}${apiPath}`,
    `http://user@planner.test:80${basePath}${apiPath}`,
    `HTTP://planner.test${basePath}${apiPath}`,
    `http://planner.test?${basePath}${apiPath}`,
    `planner.test${basePath}${apiPath}`,
    "*",
  ];
}

/** Origin-form spellings of an `/api` resource that a lenient router could normalize. */
function originFormVariants(basePath: string, apiPath: string): string[] {
  return [
    `${basePath}${apiPath.replace("/api/", "/API/")}`,
    `${basePath}${apiPath.replace("/api/", "/Api/")}`,
    `${basePath}/${apiPath}`,
    `${basePath}//${apiPath}`,
    `${basePath}${apiPath.replace("/api/", "/api//")}`,
    `${basePath}${apiPath}/`,
    `${basePath}/.${apiPath}`,
    `${basePath}/x/..${apiPath}`,
    `${basePath}/%2F${apiPath.slice(1)}`,
    `${basePath}/%2e${apiPath}`,
    `${basePath}/%61${apiPath.slice(2)}`,
    `${basePath}${apiPath.replace("/api/", "/api%2F")}`,
    `${basePath}${apiPath.replace("/api/", "/api;x/")}`,
    `${basePath}${apiPath};x`,
    `${basePath}${basePath}${apiPath}`,
    ...(basePath ? [`/${basePath}${apiPath}`, `${basePath.toUpperCase()}${apiPath}`, apiPath] : []),
  ];
}

describe("API-key boundary covers every URL spelling that routes to an /api handler", () => {
  afterEach(() => {
    delete process.env.BASE_PATH;
    delete process.env.MP_ACCESS_TOKEN;
    delete process.env.MP_BOOTSTRAP_KEY;
  });

  it.each(BASE_PATHS)(
    "refuses non-origin-form request targets before routing, even with a device key (BASE_PATH=%j)",
    async (basePath) => {
      process.env.MP_ACCESS_TOKEN = ACCESS_TOKEN;
      seedKey(DEVICE_KEY, "device");
      const { app, port } = await listenApp(basePath);
      try {
        for (const cookie of [GATE, `${GATE}; ${DEVICE}`]) {
          for (const target of nonOriginForms(basePath, "/api/settings")) {
            for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
              const res = await rawRequest(port, method, target, { Cookie: cookie });
              const label = `${method} ${target} → ${res.status} ${res.body.slice(0, 60)}`;
              expect(res.status, label).toBe(400);
              expect(res.body, label).not.toContain("timezone");
            }
          }
        }
        // A write through an absolute-form target creates nothing.
        const before = memberCount();
        const write = await rawRequest(
          port,
          "POST",
          `http://planner.test${basePath}/api/members`,
          { Cookie: GATE, "Content-Type": "application/json" },
          JSON.stringify({ displayName: "Route boundary", role: "child" })
        );
        expect(write.status).toBe(400);
        expect(memberCount()).toBe(before);
      } finally {
        await app.close();
      }
    }
  );

  it.each(BASE_PATHS)(
    "unauthenticated origin-form variants never return /api data (BASE_PATH=%j)",
    async (basePath) => {
      process.env.MP_ACCESS_TOKEN = ACCESS_TOKEN;
      const { app, port } = await listenApp(basePath);
      try {
        for (const apiPath of ["/api/settings", "/api/members", "/api/auth/credentials"]) {
          for (const target of originFormVariants(basePath, apiPath)) {
            for (const method of ["GET", "HEAD"]) {
              const res = await rawRequest(port, method, target, { Cookie: GATE });
              const label = `${method} ${target} → ${res.status} ${res.body.slice(0, 60)}`;
              expect([401, 404], label).toContain(res.status);
              expect(res.body, label).not.toContain("timezone");
              expect(res.body, label).not.toMatch(/^\[/);
            }
          }
        }
      } finally {
        await app.close();
      }
    }
  );

  it.each(BASE_PATHS)(
    "authenticates by the matched route even under a router that normalizes URLs (BASE_PATH=%j)",
    async (basePath) => {
      seedKey(DEVICE_KEY, "device");
      // Deliberately lenient router and no origin-form guard: the boundary on its own must
      // cover every spelling the router resolves to an /api handler.
      const app = Fastify({
        routerOptions: {
          caseSensitive: false,
          ignoreTrailingSlash: true,
          ignoreDuplicateSlashes: true,
        },
      });
      await authBoundary(app, basePath);
      let disclosures = 0;
      await app.register(
        async (scope) => {
          scope.get("/api/settings", async () => {
            disclosures += 1;
            return { timezone: "Europe/Madrid" };
          });
          scope.get("/open", async () => ({ open: true }));
        },
        { prefix: basePath }
      );
      const port = await listen(app);
      try {
        const targets = [
          ...nonOriginForms(basePath, "/api/settings").filter((t) => t.startsWith("http")),
          ...originFormVariants(basePath, "/api/settings"),
          `${basePath}/api/unknown`,
        ];
        for (const target of targets) {
          const res = await rawRequest(port, "GET", target);
          const label = `GET ${target} → ${res.status} ${res.body.slice(0, 60)}`;
          expect(res.body, label).not.toContain("timezone");
          expect(res.status, label).not.toBe(200);
        }
        expect(disclosures).toBe(0);

        // Every spelling the router resolved is rejected by the boundary itself.
        for (const target of [
          `http://planner.test${basePath}/api/settings`,
          `${basePath}/API/settings`,
          `${basePath}//api/settings`,
          `${basePath}/api/settings/`,
        ]) {
          const res = await rawRequest(port, "GET", target);
          expect(res.status, target).toBe(401);
          expect(JSON.parse(res.body), target).toMatchObject({ error: "unauthorized" });
          const authed = await rawRequest(port, "GET", target, { Cookie: DEVICE });
          expect(authed.status, target).toBe(200);
        }
        expect(disclosures).toBe(4);

        // Non-/api routes stay outside the API-key boundary.
        expect((await rawRequest(port, "GET", `${basePath}/open`)).status).toBe(200);
      } finally {
        await app.close();
      }
    }
  );

  it.each(BASE_PATHS)(
    "a live device key keeps working on canonical targets (BASE_PATH=%j)",
    async (basePath) => {
      seedKey(DEVICE_KEY, "device");
      const { app, port } = await listenApp(basePath);
      try {
        const settings = await rawRequest(port, "GET", `${basePath}/api/settings?x=1`, {
          Cookie: DEVICE,
        });
        expect(settings.status).toBe(200);
        expect(settings.body).toContain("timezone");
        const members = await rawRequest(port, "GET", `${basePath}/api/members`, {
          Cookie: DEVICE,
        });
        expect(members.status).toBe(200);
        expect(members.body).toBe("[]");
      } finally {
        await app.close();
      }
    }
  );

  it.each(BASE_PATHS)(
    "provisioning and /health stay the only unauthenticated routes (BASE_PATH=%j)",
    async (basePath) => {
      process.env.MP_BOOTSTRAP_KEY = BOOTSTRAP_KEY;
      seedKey(BOOTSTRAP_KEY, "bootstrap");
      const { app, port } = await listenApp(basePath);
      try {
        const health = await rawRequest(port, "GET", "/health");
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });
        const provision = await rawRequest(port, "POST", `${basePath}/api/auth/provision`, {
          Authorization: `Bearer ${BOOTSTRAP_KEY}`,
        });
        expect(provision.status).toBe(200);
        expect(provision.headers).toContain("mp_device_key=");
        // Other methods and near-miss paths around provisioning are not exempt.
        const read = await rawRequest(port, "GET", `${basePath}/api/auth/provision`);
        expect(read.status).toBe(401);
        const nearMiss = await rawRequest(port, "POST", `${basePath}/api/auth/provision-x`);
        expect(nearMiss.status).toBe(401);
      } finally {
        await app.close();
      }
    }
  );
});
