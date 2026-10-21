/** Code-first OpenAPI surface: `GET /api/openapi.json` and the reference UI under `/api/docs`
 * sit behind the same API-key boundary as every other `/api/*` route, honour BASE_PATH, and
 * serve the document generated from the route schemas (identical to docs/api/openapi.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import { useIsolatedDb } from "../helpers/db.js";

const KEY = "mpk-openapi-docs-device";

function seedDeviceKey(): void {
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run("openapi-docs-key", hashKey(KEY), Date.now());
}

async function withBasePath<T>(basePath: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.BASE_PATH;
  if (basePath === undefined) delete process.env.BASE_PATH;
  else process.env.BASE_PATH = basePath;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.BASE_PATH;
    else process.env.BASE_PATH = previous;
  }
}

describe("OpenAPI document and reference UI", () => {
  useIsolatedDb();

  for (const url of ["/api/openapi.json", "/api/docs", "/api/docs/", "/api/docs/js/scalar.js"]) {
    it(`${url} is not public: no credential → 401 envelope`, async () => {
      const app = await buildApp();
      try {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: "unauthorized" });
      } finally {
        await app.close();
      }
    });
  }

  it("serves the generated OpenAPI 3.1 document, identical to the committed docs/api/openapi.json", async () => {
    seedDeviceKey();
    const app = await withBasePath(undefined, () => buildApp());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/openapi.json",
        cookies: { mp_device_key: KEY },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      const document = response.json();
      expect(document.openapi).toBe("3.1.0");
      expect(document.servers).toEqual([{ url: "/" }]);
      const committed = JSON.parse(readFileSync("docs/api/openapi.json", "utf8"));
      expect(document).toEqual(committed);
    } finally {
      await app.close();
    }
  });

  it("serves the reference UI and its bundled script with a valid device key", async () => {
    seedDeviceKey();
    const app = await buildApp();
    try {
      const redirect = await app.inject({
        method: "GET",
        url: "/api/docs",
        cookies: { mp_device_key: KEY },
      });
      expect(redirect.statusCode).toBe(301);
      expect(redirect.headers.location).toBe("/api/docs/");
      const page = await app.inject({
        method: "GET",
        url: "/api/docs/",
        cookies: { mp_device_key: KEY },
      });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toMatch(/^text\/html/);
      expect(page.body).toContain("../openapi.json");
      const script = await app.inject({
        method: "GET",
        url: "/api/docs/js/scalar.js",
        cookies: { mp_device_key: KEY },
      });
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toMatch(/^application\/javascript/);
    } finally {
      await app.close();
    }
  });

  it("honours BASE_PATH: prefixed routes, unprefixed paths and a matching server URL", async () => {
    seedDeviceKey();
    await withBasePath("/family/planner", async () => {
      const app = await buildApp();
      try {
        const unauthenticated = await app.inject({
          method: "GET",
          url: "/family/planner/api/openapi.json",
        });
        expect(unauthenticated.statusCode).toBe(401);
        const response = await app.inject({
          method: "GET",
          url: "/family/planner/api/openapi.json",
          cookies: { mp_device_key: KEY },
        });
        expect(response.statusCode).toBe(200);
        const document = response.json();
        expect(document.servers).toEqual([{ url: "/family/planner" }]);
        expect(Object.keys(document.paths)).toContain("/api/members");
        expect(Object.keys(document.paths).some((p) => p.startsWith("/family"))).toBe(false);
        const page = await app.inject({
          method: "GET",
          url: "/family/planner/api/docs/",
          cookies: { mp_device_key: KEY },
        });
        expect(page.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  it("documents every API route it serves (no schemaless /api route reaches the document)", async () => {
    seedDeviceKey();
    const app = await buildApp();
    try {
      const document = (
        await app.inject({
          method: "GET",
          url: "/api/openapi.json",
          cookies: { mp_device_key: KEY },
        })
      ).json() as { paths: Record<string, Record<string, Record<string, unknown>>> };
      for (const [path, item] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(item)) {
          expect(operation.operationId, `${method} ${path}`).toEqual(expect.any(String));
          expect(operation.tags, `${method} ${path}`).toHaveLength(1);
          const responses = operation.responses as Record<string, { description: string }>;
          for (const response of Object.values(responses))
            expect(response.description, `${method} ${path}`).not.toBe("Default Response");
        }
      }
    } finally {
      await app.close();
    }
  });
});
