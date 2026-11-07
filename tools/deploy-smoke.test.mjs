import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deviceCookie,
  fillParams,
  planSmokeRoutes,
  runSmoke,
  SMOKE_SKIP,
  PLUGIN_UNAVAILABLE,
} from "./deploy/smoke.mjs";

const spec = JSON.parse(readFileSync(new URL("../docs/api/openapi.json", import.meta.url), "utf8"));
const BASE = "https://example.test";
const BOOTSTRAP = "mpk-BOOTSTRAP-SENTINEL";

function cachePath() {
  return join(mkdtempSync(join(tmpdir(), "deploy-smoke-")), ".smoke-device");
}

function provisioned(value) {
  const headers = new Headers();
  headers.append("set-cookie", `mp_device_key=${value}; HttpOnly; Secure; Path=/`);
  headers.append("set-cookie", "mp_provisioned=1; Path=/");
  return new Response('{"provisioned":true}', { status: 200, headers });
}

/** A fake server: `routes` maps "METHOD path" to a function returning a Response. */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    calls.push({ method, path, headers: init.headers ?? {} });
    const handler = routes[`${method} ${path}`] ?? routes[`${method} *`];
    return handler ? handler(init) : new Response("[]", { status: 200 });
  };
}

const tinySpec = {
  paths: {
    "/api/members": { get: {} },
    "/api/routines": { get: {} },
    "/api/routines/{id}": { get: {} },
    "/api/broken": { get: {} },
    "/api/missing-query": { get: {} },
  },
};

test("planSmokeRoutes covers every GET except the skip list", () => {
  const { direct, parametrized } = planSmokeRoutes(spec);
  const gets = Object.entries(spec.paths)
    .filter(([, item]) => item.get)
    .map(([path]) => path);
  for (const path of SMOKE_SKIP) {
    assert.ok(!direct.includes(path) && !parametrized.includes(path), path);
  }
  for (const path of gets.filter((p) => !SMOKE_SKIP.includes(p))) {
    assert.equal(Number(direct.includes(path)) + Number(parametrized.includes(path)), 1, path);
  }
  assert.ok(parametrized.every((path) => path.includes("{")));
  assert.ok(direct.every((path) => !path.includes("{")));
});

test("every skipped route still exists in the API contract", () => {
  for (const path of SMOKE_SKIP) assert.ok(spec.paths[path]?.get, path);
});

test("fillParams substitutes known ids and today's date", () => {
  const bodies = { "/api/routines": [{ id: "r1" }], "/api/members": [{ id: "m1" }] };
  assert.equal(
    fillParams("/api/routines/{id}/chores", bodies, "2026-11-06"),
    "/api/routines/r1/chores"
  );
  assert.equal(
    fillParams("/api/daily-briefing/{memberId}/{date}", bodies, "2026-11-06"),
    "/api/daily-briefing/m1/2026-11-06"
  );
});

test("fillParams returns null for an undiscoverable param", () => {
  assert.equal(fillParams("/api/chores/{id}", {}, "2026-11-06"), null);
  assert.equal(fillParams("/api/recipes/{id}", { "/api/recipes": [] }, "2026-11-06"), null);
});

test("deviceCookie provisions with the bootstrap key and caches it privately", async () => {
  const calls = [];
  const path = cachePath();
  const fetch = fakeFetch({ "POST /api/auth/provision": () => provisioned("dk1") }, calls);
  const cookie = await deviceCookie({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: path,
    fetch,
    fs,
  });
  assert.equal(cookie, "dk1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${BOOTSTRAP}`);
  assert.equal(readFileSync(path, "utf8").trim(), "dk1");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("deviceCookie reuses a cached cookie without provisioning", async () => {
  const calls = [];
  const path = cachePath();
  writeFileSync(path, "cached\n", { mode: 0o600 });
  const fetch = fakeFetch({}, calls);
  const cookie = await deviceCookie({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: path,
    fetch,
    fs,
  });
  assert.equal(cookie, "cached");
  assert.equal(calls.length, 0);
});

test("runSmoke re-provisions once when the cached device is refused with 401", async () => {
  const calls = [];
  const path = cachePath();
  writeFileSync(path, "revoked\n", { mode: 0o600 });
  const fetch = fakeFetch(
    {
      "POST /api/auth/provision": () => provisioned("fresh"),
      "GET *": (init) =>
        new Response("[]", { status: init.headers.cookie === "mp_device_key=fresh" ? 200 : 401 }),
    },
    calls
  );
  const spec = { paths: { "/api/members": { get: {} } } };
  const result = await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: path,
    spec,
    fetch,
    fs,
    log() {},
  });
  assert.deepEqual(result.failures, []);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(readFileSync(path, "utf8").trim(), "fresh");
});

test("runSmoke fails instead of looping when a fresh device is refused", async () => {
  const calls = [];
  const fetch = fakeFetch(
    {
      "POST /api/auth/provision": () => provisioned("fresh"),
      "GET *": () => new Response("{}", { status: 401 }),
    },
    calls
  );
  const path = cachePath();
  writeFileSync(path, "revoked\n", { mode: 0o600 });
  const spec = { paths: { "/api/members": { get: {} } } };
  const result = await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: path,
    spec,
    fetch,
    fs,
    log() {},
  });
  assert.equal(result.failures.length, 1);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("runSmoke fails on 5xx and warns on 4xx", async () => {
  const fetch = fakeFetch({
    "POST /api/auth/provision": () => provisioned("dk"),
    "GET /api/members": () => Response.json([{ id: "m1" }]),
    "GET /api/routines": () => Response.json([{ id: "r1" }]),
    "GET /api/routines/r1": () => Response.json({ id: "r1" }),
    "GET /api/broken": () => new Response("{}", { status: 500 }),
    "GET /api/missing-query": () => new Response("{}", { status: 400 }),
  });
  const result = await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: cachePath(),
    spec: tinySpec,
    fetch,
    fs,
    log() {},
  });
  assert.deepEqual(result.failures, ["GET /api/broken → 500"]);
  assert.deepEqual(result.warnings, ["GET /api/missing-query → 400"]);
});

test("smoke output never contains the bootstrap key or device cookie", async () => {
  const lines = [];
  const fetch = fakeFetch({
    "POST /api/auth/provision": () => provisioned("COOKIE-SENTINEL"),
    "GET /api/broken": () => new Response("{}", { status: 500 }),
  });
  await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: cachePath(),
    spec: tinySpec,
    fetch,
    fs,
    log: (line) => lines.push(line),
  });
  const text = lines.join("\n");
  assert.ok(lines.length > 0);
  assert.ok(!text.includes(BOOTSTRAP));
  assert.ok(!text.includes("COOKIE-SENTINEL"));
});

test("runSmoke records an unreachable route as a failure", async () => {
  const fetch = fakeFetch({
    "POST /api/auth/provision": () => provisioned("dk"),
    "GET /api/members": () => {
      throw new TypeError("fetch failed");
    },
  });
  const result = await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: cachePath(),
    spec: { paths: { "/api/members": { get: {} } } },
    fetch,
    fs,
    log() {},
  });
  assert.deepEqual(result.failures, ["GET /api/members → unreachable"]);
});

test("runSmoke re-provisions once when the cached device is revoked (403)", async () => {
  const calls = [];
  const path = cachePath();
  writeFileSync(path, "revoked\n", { mode: 0o600 });
  const fetch = fakeFetch(
    {
      "POST /api/auth/provision": () => provisioned("fresh"),
      "GET *": (init) =>
        new Response("[]", { status: init.headers.cookie === "mp_device_key=fresh" ? 200 : 403 }),
    },
    calls
  );
  const spec = { paths: { "/api/members": { get: {} } } };
  const result = await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: path,
    spec,
    fetch,
    fs,
    log() {},
  });
  assert.deepEqual(result.failures, []);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("runSmoke skips routes of inactive plugins instead of failing", async () => {
  const lines = [];
  const fetch = fakeFetch({
    "POST /api/auth/provision": () => provisioned("dk"),
    "GET /api/members": () => Response.json([{ id: "m1" }]),
    "GET /api/routines": () =>
      Response.json(
        { code: "plugin_unavailable", message: "This plugin is unavailable." },
        { status: 503 }
      ),
    "GET /api/broken": () => Response.json({ code: "upstream_down" }, { status: 503 }),
    "GET /api/missing-query": () => Response.json([]),
  });
  const result = await runSmoke({
    baseUrl: BASE,
    bootstrapKey: BOOTSTRAP,
    cachePath: cachePath(),
    spec: tinySpec,
    fetch,
    fs,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(result.failures, ["GET /api/broken → 503"]);
  assert.ok(result.skipped.includes("/api/routines"));
  assert.ok(result.skipped.includes("/api/routines/{id}"));
  assert.match(lines.join("\n"), /GET \/api\/routines skipped \(plugin inactive\)/);
});

test("the inactive-plugin code matches the server's plugin_unavailable response", () => {
  const source = readFileSync(new URL("../src/server/plugins/http.ts", import.meta.url), "utf8");
  assert.match(
    source,
    new RegExp(
      `PLUGIN_UNAVAILABLE_RESPONSE = Object\\.freeze\\(\\{\\s*code: "${PLUGIN_UNAVAILABLE}"`
    )
  );
});
