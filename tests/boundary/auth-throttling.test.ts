import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticationBackoff } from "../../src/server/auth/throttle";
import { buildApp } from "../../src/server/app";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

const START = 1_800_000_000_000;
function seed(
  raw: string,
  kind = "device",
  scope = "*",
  expires: number | null = null,
  revoked: number | null = null
) {
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(raw, hashKey(raw), scope, kind, START, expires, revoked);
}

describe("authentication failure backoff public paths", () => {
  useIsolatedDb();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("aggregates cookie, bearer and missing failures across routes; valid traffic survives cooldown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    seed("live-cookie");
    seed("live-bearer", "integration");
    const app = await buildApp();
    let independentApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const backoff = authenticationBackoff(app);
      expect(authenticationBackoff(app)).toBe(backoff);
      for (let i = 0; i < 19; i++) {
        const response = await app.inject(
          i % 2
            ? { url: "/api/settings", cookies: { mp_device_key: "wrong-cookie" } }
            : { url: "/api/plugins", headers: { authorization: "Bearer wrong-bearer" } }
        );
        expect(response.statusCode).toBe(401);
      }
      const limited = await app.inject({ url: "/api/settings" });
      expect(limited.statusCode).toBe(429);
      independentApp = await buildApp();
      expect(authenticationBackoff(independentApp)).not.toBe(backoff);
      expect((await independentApp.inject({ url: "/api/settings" })).statusCode).toBe(401);
      expect(limited.headers["retry-after"]).toBe("1");
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(limited.json()).toEqual({
        error: "too_many_requests",
        message: "Authentication retry required",
      });
      expect(
        (await app.inject({ url: "/api/settings", cookies: { mp_device_key: "live-cookie" } }))
          .statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            url: "/api/plugins",
            headers: { authorization: "Bearer live-bearer" },
          })
        ).statusCode
      ).toBe(200);
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(429);
    } finally {
      await independentApp?.close();
      await app.close();
    }
  });

  it("doubles at exact cooldown boundaries, caps at 60 seconds and does not extend cooldown", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const app = await buildApp();
    try {
      for (let i = 0; i < 19; i++)
        expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
      for (const seconds of [1, 2, 4, 8, 16, 32, 60, 60]) {
        const response = await app.inject({ url: "/api/settings" });
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe(String(seconds));
        now += seconds * 1000 - 1;
        const remaining = await app.inject({ url: "/api/settings" });
        expect(remaining.headers["retry-after"]).toBe("1");
        now += 1;
      }
      now += 15 * 60_000;
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("excludes unknown routes, transport conflicts, scope denials and input failures", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    seed("scoped", "device", "members:read");
    seed("live");
    seed("integration", "integration");
    const app = await buildApp();
    try {
      for (let i = 0; i < 21; i++) {
        await app.inject({ url: "/api/not-installed" });
        expect(
          (
            await app.inject({
              url: "/api/plugins",
              cookies: { mp_device_key: "live" },
              headers: { authorization: "Bearer integration" },
            })
          ).statusCode
        ).toBe(401);
        expect(
          (await app.inject({ url: "/api/plugins", cookies: { mp_device_key: "scoped" } }))
            .statusCode
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "PUT",
              url: "/api/settings",
              cookies: { mp_device_key: "live" },
              payload: {},
            })
          ).statusCode
        ).toBe(400);
      }
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("counts revoked and exactly expired credentials without leaking them", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    seed("mpk-revoked-secret", "device", "*", null, START);
    seed("mpk-expired-secret", "integration", "*", START);
    const app = await buildApp();
    try {
      for (let i = 0; i < 20; i++) {
        const response = await app.inject(
          i % 2
            ? { url: "/api/plugins", headers: { authorization: "Bearer mpk-expired-secret" } }
            : { url: "/api/settings", cookies: { mp_device_key: "mpk-revoked-secret" } }
        );
        expect(response.statusCode).toBe(i === 19 ? 429 : 403);
        expect(response.body).not.toContain("mpk-");
      }
    } finally {
      await app.close();
    }
  });

  it("isolates transport source and bootstrap flow, ignoring spoofed forwarding headers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubEnv("MP_BOOTSTRAP_KEY", "mpk-bootstrap-secret");
    seed("mpk-bootstrap-secret", "bootstrap");
    const app = await buildApp();
    try {
      for (let i = 0; i < 20; i++)
        await app.inject({
          url: "/api/settings",
          remoteAddress: i % 2 ? "::ffff:192.0.2.1" : "192.0.2.1",
          headers: { "x-forwarded-for": `198.51.100.${i}` },
        });
      expect(
        (await app.inject({ url: "/api/settings", remoteAddress: "192.0.2.1" })).statusCode
      ).toBe(429);
      expect(
        (await app.inject({ url: "/api/settings", remoteAddress: "192.0.2.2" })).statusCode
      ).toBe(401);
      for (let i = 0; i < 5; i++)
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/auth/provision",
              remoteAddress: "192.0.2.1",
              headers: { authorization: "Bearer wrong-bootstrap" },
            })
          ).statusCode
        ).toBe(i === 4 ? 429 : 401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/provision",
            remoteAddress: "192.0.2.1",
            headers: { authorization: "Bearer mpk-bootstrap-secret" },
          })
        ).statusCode
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("resets fixed observation windows at their exact upper boundary", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubEnv("MP_BOOTSTRAP_KEY", "configured");
    const app = await buildApp();
    try {
      for (let i = 0; i < 19; i++) await app.inject({ url: "/api/settings" });
      for (let i = 0; i < 4; i++) await app.inject({ method: "POST", url: "/api/auth/provision" });
      now += 60_000;
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
      now = START + 600_000;
      expect((await app.inject({ method: "POST", url: "/api/auth/provision" })).statusCode).toBe(
        401
      );
    } finally {
      await app.close();
    }
  });

  it("serializes concurrent failures without losing counts or escalating during cooldown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    const app = await buildApp();
    try {
      const responses = await Promise.all(
        Array.from({ length: 40 }, () =>
          app.inject({ url: "/api/settings", cookies: { mp_device_key: "unknown" } })
        )
      );
      expect(responses.filter((r) => r.statusCode === 401)).toHaveLength(19);
      expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(21);
      for (const response of responses.filter((r) => r.statusCode === 429))
        expect(response.headers["retry-after"]).toBe("1");
    } finally {
      await app.close();
    }
  });
  it("retains failures through successful NAT traffic and resets only at the quiet boundary", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    seed("live");
    const app = await buildApp();
    try {
      for (let i = 0; i < 19; i++) {
        expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
        expect(
          (await app.inject({ url: "/api/settings", cookies: { mp_device_key: "live" } }))
            .statusCode
        ).toBe(200);
      }
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(429);
      now += 15 * 60_000 - 1;
      expect((await app.inject({ url: "/api/settings" })).headers["retry-after"]).toBe("2");
      now += 15 * 60_000;
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("bounds state to 5000 entries, evicts the least recently failed source and expires idle state", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const app = await buildApp();
    const fail = (remoteAddress: string) => app.inject({ url: "/api/settings", remoteAddress });
    try {
      for (let i = 0; i < 19; i++) {
        await fail("192.0.2.1");
        await fail("192.0.2.2");
      }
      for (let i = 0; i < 4998; i++) await fail(`198.18.${Math.floor(i / 256)}.${i % 256}`);
      expect((await fail("192.0.2.1")).statusCode).toBe(429);
      await fail("192.0.2.3");
      expect((await fail("192.0.2.2")).statusCode).toBe(401);
      expect((await fail("192.0.2.1")).statusCode).toBe(429);
      now += 15 * 60_000;
      expect((await fail("192.0.2.1")).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("normalizes expanded IPv6 and hexadecimal IPv4-mapped peers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    const app = await buildApp();
    try {
      for (let i = 0; i < 20; i++)
        await app.inject({
          url: "/api/settings",
          remoteAddress: i % 2 ? "2001:db8::1" : "2001:0db8:0000:0000:0000:0000:0000:0001",
        });
      expect(
        (await app.inject({ url: "/api/settings", remoteAddress: "2001:db8::1" })).statusCode
      ).toBe(429);
      for (let i = 0; i < 20; i++)
        await app.inject({
          url: "/api/settings",
          remoteAddress: i % 2 ? "::ffff:c000:201" : "192.0.2.1",
        });
      expect(
        (await app.inject({ url: "/api/settings", remoteAddress: "::ffff:192.0.2.1" })).statusCode
      ).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("bootstrap counts missing, revoked and expired failures, preserving exact expiry semantics", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubEnv("MP_BOOTSTRAP_KEY", "bootstrap");
    seed("bootstrap", "bootstrap", "*", START);
    const app = await buildApp();
    const attempt = (authorization?: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: authorization ? { authorization } : {},
      });
    try {
      expect((await attempt("Bearer bootstrap")).statusCode).toBe(401);
      getDb()
        .prepare("UPDATE api_keys SET expires_at = NULL, revoked_at = ? WHERE id = ?")
        .run(START, "bootstrap");
      expect((await attempt("Bearer bootstrap")).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt("Bearer ")).statusCode).toBe(401);
      const response = await attempt("Bearer wrong");
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.json()).toEqual({
        error: "too_many_requests",
        message: "Authentication retry required",
      });
      expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("does not count absent bootstrap configuration or unreconciled server records", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    vi.stubEnv("MP_BOOTSTRAP_KEY", "");
    const app = await buildApp();
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: { authorization: "Bearer configured" },
      });
    try {
      for (let i = 0; i < 6; i++) expect((await attempt()).statusCode).toBe(401);
      vi.stubEnv("MP_BOOTSTRAP_KEY", "configured");
      for (let i = 0; i < 6; i++) expect((await attempt()).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/provision" })).statusCode).toBe(
        401
      );
    } finally {
      await app.close();
    }
  });
  it("handles scoped IPv6 transport peers without converting credential failures to server errors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    const app = await buildApp();
    try {
      for (let i = 0; i < 20; i++) {
        const response = await app.inject({ url: "/api/settings", remoteAddress: "fe80::1%en0" });
        expect(response.statusCode).toBe(i === 19 ? 429 : 401);
      }
      expect(
        (await app.inject({ url: "/api/settings", remoteAddress: "fe80::1%en1" })).statusCode
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});
