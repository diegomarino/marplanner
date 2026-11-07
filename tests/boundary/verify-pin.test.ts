import argon2 from "argon2";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** verify-pin match/no-match no-session test (FR-016 / FR-026).
 * Uses buildApp and Fastify.inject to verify correct and incorrect PIN
 * results and confirm neither outcome creates a server-side session.
 * Scenario (per User Story 2, acceptance scenarios 2 & 3):
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key + device key into api_keys (mimicking bootstrap and device-key setup).
 * 3. Seed the admin_config row with a known PIN hash (mimicking provisioning).
 * 4. POST /api/auth/verify-pin with the CORRECT PIN → expect {match:true}.
 * 5. POST /api/auth/verify-pin with an INCORRECT PIN → expect {match:false}.
 * 6. Assert NO session row exists in either outcome (there is no session table).
 *
 */
describe("verify-pin: match/no-match no-session", () => {
  useIsolatedDb();

  it("correct PIN ⇒ {match:true} and incorrect PIN ⇒ {match:false}, no session row either way (FR-016/FR-026)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a bootstrap key row into api_keys (mimicking startup reconciliation).
    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);

    // Seed a device key row (mimicking provisioning).
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);

    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    // Seed the admin_config row (seeded at provisioning from MP_ADMIN_PIN).
    // Use a known correct PIN so we can verify match/no-match.
    // CRITICAL: seed with argon2id (not hashKey/SHA-256) so the verify-pin route's
    // argon2.verify can actually match it —:79 requires argon2id/scrypt.
    const correctPin = "1234";
    const correctPinHash = await argon2.hash(correctPin);
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      correctPinHash,
      now
    );

    const app = await buildApp();

    try {
      // ---- Positive path: correct PIN → {match:true} (FR-016) ----
      const correctRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        cookies: { mp_device_key: deviceKey },
        payload: { pin: correctPin },
      });

      // POST /api/auth/verify-pin returns 200 with { match: true } for correct PIN.
      expect(correctRes.statusCode).toBe(200);

      const correctBody = JSON.parse(correctRes.body);
      expect(correctBody).toHaveProperty("match");
      expect(correctBody.match).toBe(true);

      // ---- Negative path: incorrect PIN → {match:false} (FR-026) ----
      const incorrectPin = "9999";
      const incorrectRes = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        cookies: { mp_device_key: deviceKey },
        payload: { pin: incorrectPin },
      });

      // POST /api/auth/verify-pin returns 200 with { match: false } for incorrect PIN.
      expect(incorrectRes.statusCode).toBe(200);

      const incorrectBody = JSON.parse(incorrectRes.body);
      expect(incorrectBody).toHaveProperty("match");
      expect(incorrectBody.match).toBe(false);

      // ---- No session row in either outcome (FR-015 / FR-016 / FR-026) ----
      // There is no session table by design — a PIN check grants no server-side authority.
      // Verify the sqlite_master has no the essions' or the ession' table.
      const sessionTables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'")
        .all() as { name: string }[];
      expect(sessionTables).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("repeated 6-digit entries with 4- and 5-digit auto-submit probes never trigger backoff or lockout", async () => {
    // The admin keypad submits at 4, 5 and 6 digits (ADR-034), so one typed 6-digit PIN is up to
    // three verify-pin requests, two of them failed probes. Ten entries in a row (30 requests, 20+
    // of them mismatches) exceed the API-boundary failure threshold, which must not apply here:
    // only failed device credentials count, never a PIN mismatch.
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    const correctPin = "135790";
    // Minimal Argon2 cost keeps thirty verifications fast; the route verifies any argon2 hash.
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      await argon2.hash(correctPin, { memoryCost: 1024, timeCost: 1, parallelism: 1 }),
      now
    );

    const app = await buildApp();
    try {
      for (let entry = 0; entry < 10; entry += 1) {
        const typed = entry % 2 === 0 ? correctPin : "135791";
        for (const length of [4, 5, 6]) {
          const res = await app.inject({
            method: "POST",
            url: "/api/auth/verify-pin",
            cookies: { mp_device_key: deviceKey },
            payload: { pin: typed.slice(0, length) },
          });
          expect(res.statusCode).toBe(200);
          expect(res.headers["retry-after"]).toBeUndefined();
          expect(JSON.parse(res.body)).toEqual({ match: typed === correctPin && length === 6 });
        }
      }

      // The device stays fully usable for ordinary API traffic afterwards.
      const settings = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: deviceKey },
      });
      expect(settings.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);
});
