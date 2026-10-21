import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app";

import { useIsolatedDb } from "../helpers/db";

const fixtureDb = useIsolatedDb({ pluginState: "inactive" });

const TOKEN = "mpg-test-access-token";
const SHELL_SENTINEL = "APP_SHELL_SENTINEL";

function makeStaticRoot(): string {
  const dir = join(fixtureDb.dir(), "static");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<div id="root">${SHELL_SENTINEL}</div>`);
  return dir;
}

beforeEach(() => {
  process.env.MP_ACCESS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.MP_ACCESS_TOKEN;
});

describe("access gate", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("form-not-shell: GET / with no cookie → form (no shell, no 401)", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.body).not.toContain(SHELL_SENTINEL);

    const unrelatedCookie = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: "unrelated=value" },
    });
    expect(unrelatedCookie.statusCode).toBe(200);
    expect(unrelatedCookie.body).toContain("access-gate-form");
    expect(unrelatedCookie.body).not.toContain(SHELL_SENTINEL);
  });

  it("any frontend route: GET /some/deep/route with no cookie → form (no shell, no 401)", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({ method: "GET", url: "/some/deep/route" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.body).not.toContain(SHELL_SENTINEL);
  });

  it("wrong token: POST /gate with wrong token → form, no set-cookie", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wrong",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a refused submission explains the rejection without echoing it or revealing the setup", async () => {
    const gateApp = await buildApp({ staticRoot: makeStaticRoot() });
    app = gateApp;
    const post = (body: string) =>
      gateApp.inject({
        method: "POST",
        url: "/gate",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });

    const wrong = await post("token=mpg-wrong-guess-1234");
    expect(wrong.statusCode).toBe(200);
    expect(wrong.body).toContain('data-testid="access-gate-rejected"');
    expect(wrong.body).toContain('role="alert"');
    expect(wrong.body).toContain("ask whoever set up this");
    expect(wrong.body).not.toContain("mpg-wrong-guess-1234");
    expect(wrong.body).not.toContain(TOKEN);

    const empty = await post("token=");
    expect(empty.body).toContain('data-testid="access-gate-rejected"');

    const firstVisit = await gateApp.inject({ method: "GET", url: "/" });
    expect(firstVisit.body).toContain("access-gate-form");
    expect(firstVisit.body).not.toContain("access-gate-rejected");

    // Fail-closed (no usable token configured) reads exactly like a wrong token.
    delete process.env.MP_ACCESS_TOKEN;
    const unconfigured = await post("token=mpg-wrong-guess-1234");
    expect(unconfigured.body).toBe(wrong.body);

    process.env.MP_ACCESS_TOKEN = TOKEN;
    const valid = await post(`token=${TOKEN}`);
    expect(valid.statusCode).toBe(303);
  });

  it("fail-closed: unset token ⇒ gate unpassable", async () => {
    delete process.env.MP_ACCESS_TOKEN;
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.headers["set-cookie"]).toBeUndefined();

    const frontend = await app.inject({ method: "GET", url: "/" });
    expect(frontend.statusCode).toBe(200);
    expect(frontend.body).toContain("access-gate-form");
    expect(frontend.body).not.toContain(SHELL_SENTINEL);
  });

  it("fail-closed: non-mpg token ⇒ gate unpassable", async () => {
    process.env.MP_ACCESS_TOKEN = "password"; // non-mpg- value: must be treated as unset
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=password",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("success sets cookie: POST /gate with correct token → 303, set-cookie with mp_gate", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN}`,
    });
    expect(res.statusCode).toBe(303);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(Array.isArray(setCookie) ? setCookie.join(",") : setCookie!).toContain("mp_gate=");
    expect(Array.isArray(setCookie) ? setCookie.join(",") : setCookie!).toContain("HttpOnly");
    expect(Array.isArray(setCookie) ? setCookie.join(",") : setCookie!).toContain("Secure");
    expect(res.headers.location).toBe("/");
  });

  it("gated browser gets shell: valid gate cookie → SPA shell", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const submitRes = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN}`,
    });
    expect(submitRes.statusCode).toBe(303);
    const setCookie = submitRes.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
    const mpGateMatch = cookieHeader.match(/mp_gate=([^;]+)/);
    expect(mpGateMatch).toBeDefined();
    const gateValue = mpGateMatch![1];

    const getRes = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: `mp_gate=${gateValue}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toContain(SHELL_SENTINEL);
  });

  it("gate never authenticates /api: valid gate cookie + no API key → 401", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const submitRes = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN}`,
    });
    const setCookie = submitRes.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
    const mpGateMatch = cookieHeader.match(/mp_gate=([^;]+)/);
    expect(mpGateMatch).toBeDefined();
    const gateValue = mpGateMatch![1];

    const res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: `mp_gate=${gateValue}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("health untouched: GET /health with no cookie → 200", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /gate with no cookie returns form (not shell sentinel)", async () => {
    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({ method: "GET", url: "/gate" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.body).not.toContain(SHELL_SENTINEL);
  });

  it("form HTML inlines shared tokens.css (single palette source)", async () => {
    // The perimeter form must not carry a parallel hex sheet: it embeds
    // src/client/styles/tokens.css so SPA + gate cannot drift (ui-foundation).
    const tokensCss = readFileSync(join(process.cwd(), "src/client/styles/tokens.css"), "utf8");
    const background = tokensCss.match(/--background:\s*([^;]+);/)?.[1]?.trim();
    const primary = tokensCss.match(/--primary:\s*([^;]+);/)?.[1]?.trim();
    expect(background).toBeTruthy();
    expect(primary).toBeTruthy();

    app = await buildApp({ staticRoot: makeStaticRoot() });
    const res = await app.inject({ method: "GET", url: "/gate" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("access-gate-form");
    expect(res.body).toContain(`--background: ${background}`);
    expect(res.body).toContain(`--primary: ${primary}`);
    // Contracts e2e/helpers still rely on.
    expect(res.body).toContain('name="token"');
    expect(res.body).toMatch(/<label[^>]*>Access token<\/label>/);
    expect(res.body).toMatch(/<button[^>]*>Enter<\/button>/);
  });
  it("loads shared tokens relative to its module when started outside the project directory", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixtureDb.dir());
    try {
      vi.resetModules();
      const { sendGateForm } = await import("../../src/server/auth/gate");
      const { default: Fastify } = await import("fastify");
      app = Fastify();
      app.get("/gate", (_request, reply) => sendGateForm(reply));
      const response = await app.inject({ method: "GET", url: "/gate" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("--background: #f5f2ed");
      expect(response.body).toContain('name="token"');
    } finally {
      cwd.mockRestore();
    }
  });
});
