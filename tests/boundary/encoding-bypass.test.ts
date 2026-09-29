import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../../src/server/app";
import { getDb } from "../../src/server/db/client";
import { hashKey } from "../../src/server/auth/credentials";
import { useIsolatedDb } from "../helpers/db";

useIsolatedDb();

const BOOTSTRAP_KEY = "mpg-test-bootstrap-key-for-encoding";

/** Seed an active bootstrap row (mimics startup reconciliation) so a valid
 * provision request can actually succeed — the control that keeps the encoded
 * provisioning assertion non-vacuous. */
function seedBootstrapKey(key: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    )
    .run(`${now}-bootstrap`, hashKey(key), now);
}

/** Percent-encoding /api bypass — multi-variant invariant.
 * INVARIANT: no percent-encoding variant of an `/api` path may reach an `/api`
 * resource without authorization. Empirically the app fails closed in two correct
 * shapes, and this test pins BOTH so a future decode/classification change can't
 * silently open a bypass:
 * (a) A variant that single-decodes to `/api/*` is caught by the auth-boundary
 * `onRequest` hook (which `decodeURIComponent`s once before the `/api/`
 * check) → 401 `{ error: "unauthorized" }`. This is the boundary's own
 * signature — asserting it (not merely "not 200") proves the MIDDLEWARE
 * rejected the request, distinct from an incidental router 404.
 * (b) A variant that does NOT single-decode to `/api/*` (double-encoded, or an
 * uppercase `%41`→`A` case-variant of `/Api`) is a non-API/frontend route:
 * it receives the access-gate FORM, never `/api` data.
 * What must NEVER happen: a 200 carrying settings/members JSON, or a successful
 * provision, via any encoding of the path.
 */
describe("percent-encoded /api bypass is blocked — multi-variant (#99)", () => {
  // Group (a): single-decodes to /api/* → the auth boundary enforces → 401.
  const boundaryEnforced = [
    "/%61pi/settings", // %61 = 'a'
    "/%61pi/members",
    "/api%2Fsettings", // %2F = '/', upper hex
    "/api%2fmembers", // %2f = '/', lower hex
  ];
  it.each(boundaryEnforced)(
    "GET %s → 401 unauthorized at the auth-boundary middleware",
    async (url) => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      // The boundary's own error shape — proves the middleware rejected it.
      expect(JSON.parse(res.body)).toMatchObject({ error: "unauthorized" });
      await app.close();
    }
  );

  // Group (b): does NOT single-decode to /api/* → non-API route, never /api data.
  const nonApiFailClosed = [
    "/%2561pi/settings", // double-encoded 'a' → decodes once to /%61pi/settings
    "/%2541pi/settings", // double-encoded 'A'
    "/%41pi/settings", // single-encoded 'A' → /Api (case-variant, not /api)
  ];
  it.each(nonApiFailClosed)(
    "GET %s → over-decode guard: never leaks /api data (stays a non-API route)",
    async (url) => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url });
      // Must NOT be an authorized settings payload.
      expect(res.body).not.toContain("timezone");
      expect(res.body).not.toContain("Europe/Madrid");
      // Positively: it is the frontend access-gate form, not an /api JSON response.
      expect(res.body).toContain("access-gate-form");
      await app.close();
    }
  );

  // Provisioning must not be reachable via an encoded path — exercised with a
  // VALID bootstrap key so the assertion is non-vacuous (a missing key would fail
  // regardless of the encoding). Control: the real path DOES provision with the
  // same setup, proving the encoded path is blocked by the ENCODING, not the key.
  afterEach(() => {
    delete process.env.MP_BOOTSTRAP_KEY;
  });

  it("POST /%61pi/auth/provision with a VALID bootstrap key still does not provision", async () => {
    process.env.MP_BOOTSTRAP_KEY = BOOTSTRAP_KEY;
    seedBootstrapKey(BOOTSTRAP_KEY);
    const app = await buildApp();
    try {
      // Control: the canonical path provisions with this exact setup.
      const control = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: { Authorization: `Bearer ${BOOTSTRAP_KEY}` },
      });
      expect(control.statusCode).toBe(200);
      const controlCookie = control.headers["set-cookie"];
      expect(
        Array.isArray(controlCookie) ? controlCookie.join(",") : (controlCookie ?? "")
      ).toContain("mp_device_key");

      // The encoded variant, same valid key, must NOT provision.
      const encoded = await app.inject({
        method: "POST",
        url: "/%61pi/auth/provision",
        headers: { Authorization: `Bearer ${BOOTSTRAP_KEY}` },
      });
      expect(encoded.body).not.toContain("provisioned");
      const encodedCookie = encoded.headers["set-cookie"];
      expect(
        Array.isArray(encodedCookie) ? encodedCookie.join(",") : (encodedCookie ?? "")
      ).not.toContain("mp_device_key");
      // CONCRETE fail-closed shape (empirically confirmed): the encoded path is
      // NOT 404. `/api/auth/provision` is boundary-EXEMPT, so a decoded provision
      // is never 401'd; instead the access-gate onRequest hook — which classifies
      // the still-encoded `/%61pi/...` path as a non-API route — replies with the
      // gate FORM (200) before routing. Pinning that exact shape makes a router-
      // /gate-decode regression (which would instead reach the provision handler →
      // 200 `{provisioned:true}` + cookie) unambiguous.
      expect(encoded.statusCode).toBe(200);
      expect(encoded.body).toContain("access-gate-form");
    } finally {
      await app.close();
    }
  });
});
