import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { registerRoutesWithCapabilities } from "../../src/server/auth/capability";
import { useIsolatedDb } from "../helpers/db";

/** capability seam boundary tests (CLIENT-LOGGING-TELEMETRY-INV-10 / -AC-05).
 */
describe("telemetry capability seam (T004)", () => {
  useIsolatedDb();

  function seedApiKey(scope: string): { rawKey: string; id: string } {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, ?, 'device', ?)"
      )
      .run(id, hashKey(rawKey), scope, now);
    return { rawKey, id };
  }

  it("CLIENT-LOGGING-TELEMETRY-AC-05: a `*` scoped key satisfies BOTH telemetry:write and telemetry:admin", async () => {
    const { rawKey, id } = seedApiKey("*");

    const app = Fastify();
    // Minimal stand-in for authBoundary: attach apiKeyId the same way it would in the real app.
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { apiKeyId?: string }).apiKeyId = id;
    });
    registerRoutesWithCapabilities(app, [
      {
        method: "get",
        path: "/probe/write",
        capability: "telemetry:write",
        handler: async () => ({ ok: true }),
      },
      {
        method: "get",
        path: "/probe/admin",
        capability: "telemetry:admin",
        handler: async () => ({ ok: true }),
      },
    ]);

    try {
      const writeRes = await app.inject({ method: "GET", url: "/probe/write" });
      expect(writeRes.statusCode).toBe(200);
      const adminRes = await app.inject({ method: "GET", url: "/probe/admin" });
      expect(adminRes.statusCode).toBe(200);
      void rawKey; // seeded but not exercised over HTTP auth in this unit-level test
    } finally {
      await app.close();
    }
  });

  it("CLIENT-LOGGING-TELEMETRY-AC-05: a scoped key that does NOT include the capability is rejected (403)", async () => {
    const { id } = seedApiKey("other:scope");

    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { apiKeyId?: string }).apiKeyId = id;
    });
    registerRoutesWithCapabilities(app, [
      {
        method: "get",
        path: "/probe/write",
        capability: "telemetry:write",
        handler: async () => ({ ok: true }),
      },
    ]);

    try {
      const res = await app.inject({ method: "GET", url: "/probe/write" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-10: a route registered WITHOUT a declared capability throws at registration (fail-closed)", () => {
    const app = Fastify();
    expect(() =>
      registerRoutesWithCapabilities(app, [
        {
          method: "get",
          path: "/probe/undeclared",
          capability: undefined,
          handler: async () => ({ ok: true }),
        },
      ])
    ).toThrow(/capability/i);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-10: no request without apiKeyId attached can pass a capability check", async () => {
    const app = Fastify();
    registerRoutesWithCapabilities(app, [
      {
        method: "get",
        path: "/probe/write",
        capability: "telemetry:write",
        handler: async () => ({ ok: true }),
      },
    ]);
    try {
      const res = await app.inject({ method: "GET", url: "/probe/write" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-10: the PIN is never read server-side by the capability seam or telemetry routes (grep proof)", () => {
    // Strip block/line comments so the grep checks executable CODE only — the module's own
    // JSDoc legitimately discusses (and disclaims) PIN-checking in prose.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    const capabilitySrc = stripComments(
      readFileSync(resolve(process.cwd(), "src/server/auth/capability.ts"), "utf8")
    );
    const telemetryRouteSrc = stripComments(
      readFileSync(resolve(process.cwd(), "src/server/routes/telemetry.ts"), "utf8")
    );
    const telemetryIndexSrc = stripComments(
      readFileSync(resolve(process.cwd(), "src/server/telemetry/index.ts"), "utf8")
    );
    for (const src of [capabilitySrc, telemetryRouteSrc, telemetryIndexSrc]) {
      expect(src).not.toMatch(/\bpin\b/i);
      expect(src).not.toMatch(/admin_?config/i);
      expect(src).not.toMatch(/argon2/i);
    }
  });
});
