import { requestAppPath } from "../../src/shared/base-path";
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
  delete process.env.BASE_PATH;
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

  it("serves one client build under a nested runtime mount with injected assets and gated APIs", async () => {
    process.env.BASE_PATH = "/family/planner/";
    const root = makeClientRoot();
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><html><head><title>SPA shell</title></head><body><script src="./assets/app.js"></script></body></html>'
    );
    app = await buildApp({ staticRoot: root });
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/family/planner/api/settings")).statusCode).toBe(401);
    expect((await app.inject("/api/settings")).statusCode).toBe(404);
    expect((await app.inject("/family/planner-extra/calendar")).statusCode).toBe(404);
    const form = await app.inject("/family/planner/calendar");
    expect(form.body).toContain('action="/family/planner/gate"');
    const passed = await app.inject({
      method: "POST",
      url: "/family/planner/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${TOKEN}`,
    });
    expect(passed.statusCode).toBe(303);
    expect(passed.headers.location).toBe("/family/planner/");
    expect(passed.headers["set-cookie"]).toContain("Path=/family/planner/");
    for (const url of [
      "/family/planner/",
      "/family/planner/index.html",
      "/family/planner/admin/members",
    ]) {
      const shell = await app.inject({ url, headers: { cookie: GATE_COOKIE_HEADER } });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('<head><base href="/family/planner/">');
      expect(shell.body).toContain('name="mp-base-path" content="/family/planner"');
    }
    expect(
      (
        await app.inject({
          url: "/family/planner/assets/app.js",
          headers: { cookie: GATE_COOKIE_HEADER },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/family/planner/server.js",
          headers: { cookie: GATE_COOKIE_HEADER },
        })
      ).statusCode
    ).toBe(404);
    expect(requestAppPath("/family/planner/api/%broken", "/family/planner")).toBe("/api/%broken");
    const malformed = await app.inject("/family/planner/api/%broken");
    expect(malformed.statusCode).toBeGreaterThanOrEqual(400);
    expect(malformed.body).not.toContain("SPA shell");
    for (const method of ["GET", "HEAD"] as const) {
      const bare = await app.inject({ method, url: "/family/planner?route=calendar" });
      expect(bare.statusCode).toBe(302);
      expect(bare.headers.location).toBe("/family/planner/?route=calendar");
    }
  });

  it("rejects malformed runtime mount paths before serving routes", async () => {
    for (const base of ["//host", "/a/../b", "/a%2fb", "/a?b", "/a#b", "/a\\b", "/a//b"]) {
      process.env.BASE_PATH = base;
      await expect(buildApp()).rejects.toThrow(/BASE_PATH/);
    }
  });
});
