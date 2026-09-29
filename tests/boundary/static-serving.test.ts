import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.ts";

import { useIsolatedDb } from "../helpers/db";

const fixtureDb = useIsolatedDb({ pluginState: "inactive" });

const TOKEN = "mpg-static-serving-test";
const GATE_COOKIE_HEADER = `mp_gate=${createHash("sha256").update(TOKEN).digest("hex")}`;

beforeEach(() => {
  process.env.MP_ACCESS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.MP_ACCESS_TOKEN;
});

describe("static serving — client-only root; backend bundle never leaks", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  function makeClientRoot(): string {
    const root = join(fixtureDb.dir(), "client");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>SPA shell</title>");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "console.log('client');");
    return root;
  }

  it("GET / serves the SPA shell (200 HTML)", async () => {
    app = await buildApp({ staticRoot: makeClientRoot() });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: GATE_COOKIE_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!doctype html");
  });

  it("GET a real client asset is served (200)", async () => {
    app = await buildApp({ staticRoot: makeClientRoot() });
    const res = await app.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { cookie: GATE_COOKIE_HEADER },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /server.js does NOT leak the backend bundle (not 200)", async () => {
    app = await buildApp({ staticRoot: makeClientRoot() });
    const res = await app.inject({
      method: "GET",
      url: "/server.js",
      headers: { cookie: GATE_COOKIE_HEADER },
    });
    expect(res.statusCode).not.toBe(200);
  });

  it("server artifacts via path traversal are blocked (not 200)", async () => {
    app = await buildApp({ staticRoot: makeClientRoot() });
    for (const url of [
      "/../server/index.js",
      "/assets/../../server/index.js",
      "/..%2f..%2fserver%2findex.js",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { cookie: GATE_COOKIE_HEADER },
      });
      expect(res.statusCode, `traversal ${url} must not 200`).not.toBe(200);
    }
  });

  it("an extension-less client route falls back to the SPA shell (200)", async () => {
    app = await buildApp({ staticRoot: makeClientRoot() });
    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: GATE_COOKIE_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!doctype html");
  });

  it("/health and /api/* are unaffected by static serving", async () => {
    app = await buildApp({ staticRoot: makeClientRoot() });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    // no device cookie ⇒ /api stays gated
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
  });
});
