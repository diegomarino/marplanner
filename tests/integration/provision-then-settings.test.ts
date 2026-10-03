import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Integration test: provision → cold settings in one process.
 * Realizes: FR-007 → FR-008 → FR-009 → FR-010 → FR-011
 * Scenario (per User Story 1):
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key row (mimicking startup reconciliation).
 * 3. POST /api/auth/provision with the raw bootstrap key → provisions a device cookie,
 * returns {provisioned:true}, leaks no raw key (FR-007).
 * 4. Follow the redirect/fetch using the device cookie from the provision response.
 * 5. GET /api/settings with that device credential and no PIN → 200 with full locale object
 * (all three fields: timezone, language, weekStartDay) (FR-008/009/010/011).
 * The provisioning and settings endpoints are exercised in one process.
 * This integration test chains both in a single running process.
 */
describe("provision→settings integration (FR-007→FR-011)", () => {
  useIsolatedDb();

  it("POST /api/auth/provision + GET /api/settings in one process: provision with raw bootstrap key, then cold-read settings with device cookie (FR-007→FR-011)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // --- Step 1: Seed a bootstrap key row into api_keys before startup reconciliation. ---
    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;
    const bootstrapHash = hashKey(bootstrapKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${now}-bootstrap`, bootstrapHash, now);

    // Seed a PARTIAL locale object — only `language` is persisted, `timezone` and
    // `weekStartDay` are absent. This exercises FR-010: the
    // derive-on-read endpoint MUST overlay schema defaults onto the persisted
    // JSON so that every field is present even when the persisted data is
    // incomplete. An implementation that merely echoes stored JSON would
    // fail this test.
    const partialLocaleData = JSON.stringify({ language: "es" });
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
    ).run(partialLocaleData, now);

    // Seed the admin_config row (seeded at provisioning from ADMIN_PIN).
    const adminPinHash = hashKey(process.env.ADMIN_PIN ?? "0000");
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      adminPinHash,
      now
    );

    // --- Step 2: Build the app and provision. ---
    const app = await buildApp();

    try {
      // --- Step 3: POST /api/auth/provision with the raw bootstrap key (FR-007). ---
      const provisionRes = await app.inject({
        method: "POST",
        url: "/api/auth/provision",
        headers: {
          Authorization: `Bearer ${bootstrapKey}`,
        },
      });

      // FR-007: On successful provision the response MUST be 200.
      expect(provisionRes.statusCode).toBe(200);

      // FR-007: The response MUST set an HttpOnly+Secure+SameSite=Lax cookie named
      // `mp_device_key` containing a device key that starts with "mpk-".
      const setCookie = provisionRes.headers["set-cookie"];
      expect(Array.isArray(setCookie)).toBe(true);
      expect(setCookie!.length).toBeGreaterThan(0);

      // Extract the device key value from the Set-Cookie header.
      // Format: "mp_device_key=mpk-xxx; Path=/; HttpOnly; Secure; SameSite=Lax"
      const deviceCookie = (setCookie as string[]).find((c) => c.startsWith("mp_device_key="));
      expect(deviceCookie).toBeDefined();
      expect(deviceCookie).toMatch(/mp_device_key=mpk-[a-z]+(-[a-z]+)*/);

      // Extract the raw device key value from the cookie string.
      // generateKey produces diceware-style keys: mpk-word-word-word-word-word-word
      const deviceKeyMatch = deviceCookie!.match(/mp_device_key=(mpk-[a-z]+(-[a-z]+)*)/);
      expect(deviceKeyMatch).not.toBeNull();
      const deviceKey = deviceKeyMatch![1];

      // FR-007: The response body MUST NOT contain the raw bootstrap key value.
      // The body should be { provisioned: true } (per openapi.yaml ProvisionResult).
      const provisionBody = JSON.parse(provisionRes.body);
      expect(provisionBody).toHaveProperty("provisioned", true);
      expect(provisionRes.body).not.toContain(bootstrapKey);

      // --- Step 4: GET /api/settings with the device cookie and no PIN (FR-008/009/010/011). ---
      const settingsRes = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: deviceKey },
      });

      // FR-008/009/011: GET /api/settings returns 200 with EffectiveSettings containing LocaleObject.
      expect(settingsRes.statusCode).toBe(200);

      const settingsBody = JSON.parse(settingsRes.body);

      // EffectiveSettings: { locale: LocaleObject } (openapi.yaml).
      expect(settingsBody).toHaveProperty("locale");

      const locale = settingsBody.locale;

      // LocaleObject: all three fields always present (openapi.yaml required: [timezone, language, weekStartDay]).
      expect(locale).toHaveProperty("timezone");
      expect(locale).toHaveProperty("language");
      expect(locale).toHaveProperty("weekStartDay");

      // FR-011: the locale object has all three of its fields.
      // FR-010: defaults fill any unset persisted value.
      // The partial locale persisted only { language: "es" }; timezone and
      // weekStartDay are ABSENT from the persisted data. The derive-on-read
      // implementation MUST fill them from defaults:
      // timezone='Europe/Madrid', weekStartDay=1.
      expect(typeof locale.timezone).toBe("string");
      expect(locale.timezone).toBe("Europe/Madrid");

      expect(typeof locale.language).toBe("string");
      expect(locale.language).toBe("es");

      expect(typeof locale.weekStartDay).toBe("number");
      expect(locale.weekStartDay).toBe(1);
    } finally {
      await app.close();
    }
  });
});
