import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Cold-settings locale-completeness test (FR-008 / FR-009 / FR-010 / FR-011).
 * Uses buildApp and Fastify.inject to verify a cold settings read returns
 * timezone, language, and weekStartDay, including defaults for unset values.
 * Scenario (per User Story 1, acceptance scenario 4):
 * 1. useIsolatedDb sets DATA_DIR, resets DB, runs migrations.
 * 2. Seed a bootstrap key row + a device key into api_keys (mimicking bootstrap and device-key setup).
 * 3. Seed the locale settings_object and admin_config rows.
 * 4. Cold-read effective settings with the device key and no PIN.
 * 5. Assert the locale object has all three fields (timezone, language, weekStartDay).
 *
 */
describe("settings-coldread (red-by-design, turns green)", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("valid key + no PIN ⇒ GET /api/settings returns locale with all three fields (FR-008/009/010/011)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Seed a bootstrap key row into api_keys (mimicking startup reconciliation).
    // ADR-032: if the bootstrap env value is set and no active * row matches it, seed one.
    const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bootstrapHash = hashKey(bootstrapKey);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
    ).run(`${Date.now()}-bootstrap`, bootstrapHash, now);

    // Seed a device key row (mimicking device provisioning).
    // The device key is * scoped, no expiry (expires_at IS NULL), active (revoked_at IS NULL).
    // CRITICAL: use hashKey— the same function the auth boundary uses — so the device
    // The key authenticates through the active-record check in boundary.ts.
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);

    // Persist an explicit Spanish preference; the English initial default must not replace it.
    const localeData = JSON.stringify({
      timezone: "Europe/Madrid",
      language: "es",
      weekStartDay: 1,
    });
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
    ).run(localeData, now);

    // Seed the admin_config row (seeded at provisioning from ADMIN_PIN).
    const adminPinHash = hashKey(process.env.ADMIN_PIN ?? "0000");
    db.prepare("INSERT INTO admin_config (id, pin_hash, updated_at) VALUES (1, ?, ?)").run(
      adminPinHash,
      now
    );

    // Build the app (authBoundary registered; /health only).
    const app = await buildApp();

    try {
      // Cold-read effective settings with the device key and no PIN.
      // FR-008/009/011: valid key + no PIN ⇒ settings returned with locale all-three-fields.
      // FR-010: defaults fill any unset persisted value.
      //
      // A successful cold read returns EffectiveSettings with a complete LocaleObject.
      const settingsRes = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: deviceKey },
      });

      // GET /api/settings returns 200 with EffectiveSettings containing LocaleObject.
      expect(settingsRes.statusCode).toBe(200);

      const body = JSON.parse(settingsRes.body);

      // EffectiveSettings: { locale: LocaleObject } (openapi.yaml).
      expect(body).toHaveProperty("locale");

      const locale = body.locale;

      // LocaleObject: all three fields always present (openapi.yaml required: [timezone, language, weekStartDay]).
      expect(locale).toHaveProperty("timezone");
      expect(locale).toHaveProperty("language");
      expect(locale).toHaveProperty("weekStartDay");

      // FR-011: the locale object has all three of its fields.
      // FR-010: defaults fill any unset persisted value.
      // Configured Spanish remains effective; initial defaults apply only to missing values.
      expect(typeof locale.timezone).toBe("string");
      expect(locale.timezone).toBe("Europe/Madrid");

      expect(typeof locale.language).toBe("string");
      expect(locale.language).toBe("es");

      expect(typeof locale.weekStartDay).toBe("number");
      expect(locale.weekStartDay).toBe(1);

      // Fresh lifecycle stores seed every plugin inactive. Plugin-owned settings must therefore
      // stay outside the effective response even though their schemas/defaults are registered.
      expect(body).not.toHaveProperty("weather");
      expect(body).not.toHaveProperty("printer");
      expect(body).not.toHaveProperty("printerTransport");
    } finally {
      await app.close();
    }
  });
});
