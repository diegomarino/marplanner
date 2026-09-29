import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Settings object registry write matrix:
 * FR-001/FR-002). BLACK-BOX: buildApp + Fastify.inject only.
 * Covers: unknown object -> 400, nothing persisted; schema-invalid payload -> 400 BEFORE
 * any write (weather range/partial-pair, locale partial-payload); valid write -> atomic
 * per-object replace; failed validation leaves the prior object intact; cold GET defaults
 * for BOTH locale and weather; PUT 200 body = the updated EFFECTIVE settings map; key-gated
 * with zero PIN evaluation (no admin_config row is ever seeded in this file).
 */
describe("settings-write (T002)", () => {
  useIsolatedDb({ pluginState: "inactive" });

  function seedDeviceKey(): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const db = getDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return deviceKey;
  }

  function setPluginState(pluginId: "weather" | "printing", state: "active" | "inactive") {
    getDb()
      .prepare(
        `UPDATE plugin_activation_registry
         SET state = ?, updated_at = ?
         WHERE plugin_id = ?`
      )
      .run(state, "2026-09-27T10:15:30.000Z", pluginId);
  }

  async function getSettings(app: FastifyInstance, deviceKey?: string) {
    return app.inject({
      method: "GET",
      url: "/api/settings",
      ...(deviceKey ? { cookies: { mp_device_key: deviceKey } } : {}),
    });
  }

  async function putSettings(
    app: FastifyInstance,
    deviceKey: string | undefined,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: "PUT",
      url: "/api/settings",
      ...(deviceKey ? { cookies: { mp_device_key: deviceKey } } : {}),
      payload: body,
    });
  }

  // ── key-gated, zero PIN evaluation ────────────────────────────────────

  it("GET with no key returns 401 (key-gated)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await getSettings(app);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PUT with no key returns 401, nothing persisted (key-gated)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await putSettings(app, undefined, {
        object: "weather",
        settings: { lat: 40, lon: -3 },
      });
      expect(res.statusCode).toBe(401);

      const db = getDb();
      const row = db.prepare("SELECT * FROM settings_objects WHERE object_name = 'weather'").get();
      expect(row).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  // ── cold-read defaults, both objects ──────────────────────────────────

  it("cold GET (no persisted rows) returns locale AND weather defaults, no PIN state touched", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    setPluginState("weather", "active");
    const app = await buildApp();
    try {
      const res = await getSettings(app, deviceKey);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.locale).toEqual({ timezone: "Europe/Madrid", language: "es", weekStartDay: 1 });
      expect(body.weather).toEqual({ lat: null, lon: null });
    } finally {
      await app.close();
    }
  });

  it("retains an inactive plugin write without publishing it until the registry becomes active", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const write = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json()).not.toHaveProperty("weather");

      expect(
        getDb().prepare("SELECT data FROM settings_objects WHERE object_name = 'weather'").get()
      ).toEqual({ data: '{"lat":40.4168,"lon":-3.7038,"label":"Madrid"}' });

      setPluginState("weather", "active");
      expect((await getSettings(app, deviceKey)).json().weather).toEqual({
        lat: 40.4168,
        lon: -3.7038,
        label: "Madrid",
      });
    } finally {
      await app.close();
    }
  });

  // ── unknown object ─────────────────────────────────────────────────────

  it("PUT with an unregistered object name returns 400, nothing persisted", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "bogus",
        settings: { anything: true },
      });
      expect(res.statusCode).toBe(400);

      const db = getDb();
      const rows = db.prepare("SELECT * FROM settings_objects").all();
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  // ── weather schema-invalid: range + partial pair ──────────────────────

  it("PUT weather with lat=91 (out of range) returns 400 before any write", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    setPluginState("weather", "active");
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 91, lon: 0 },
      });
      expect(res.statusCode).toBe(400);

      const getRes = await getSettings(app, deviceKey);
      expect(JSON.parse(getRes.body).weather).toEqual({ lat: null, lon: null });
    } finally {
      await app.close();
    }
  });

  it("PUT weather with lon=-200 (out of range) returns 400 before any write", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 0, lon: -200 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PUT weather with a partial pair (lat without lon) returns 400, disabled rather than completed", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 40.4, lon: null },
      });
      expect(res.statusCode).toBe(400);

      const db = getDb();
      const row = db.prepare("SELECT * FROM settings_objects WHERE object_name = 'weather'").get();
      expect(row).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("PUT weather with label over 80 chars returns 400", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 40, lon: -3, label: "x".repeat(81) },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PUT locale with a bogus timezone returns 400 before any write, prior locale intact (016-review P2-1)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      // Seed a non-default locale first so a silent pass-through would be observable.
      const initial = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "America/New_York", language: "en", weekStartDay: 0 },
      });
      expect(initial.statusCode).toBe(200);

      const res = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "Foo/Bar", language: "es", weekStartDay: 1 },
      });
      expect(res.statusCode).toBe(400);

      const getRes = await getSettings(app, deviceKey);
      expect(JSON.parse(getRes.body).locale).toEqual({
        timezone: "America/New_York",
        language: "en",
        weekStartDay: 0,
      });
    } finally {
      await app.close();
    }
  });

  // ── locale weekStartDay: exactly 0 or 1 (week-start validation) ────────────────
  // Oracle: design/contracts/app-settings-registry.md ("weekStartDay must be exactly 0 or
  // 1") + ADR-028 ("0 (Sunday) or 1 (Monday)") — a two-value toggle, NOT a 0..6/1..7
  // weekday index. Both this module's earlier 0-6 fix and the pre-existing 1-7 doc were
  // wrong vs the oracle.

  it("PUT locale with weekStartDay=0 (Sunday) returns 200 and round-trips", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "UTC", language: "en", weekStartDay: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).locale.weekStartDay).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("PUT locale with weekStartDay=1 (Monday) returns 200 and round-trips", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "UTC", language: "en", weekStartDay: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).locale.weekStartDay).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("PUT locale with weekStartDay=2 returns 400 before any write, prior locale intact", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const initial = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "America/New_York", language: "en", weekStartDay: 0 },
      });
      expect(initial.statusCode).toBe(200);

      const res = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "America/New_York", language: "en", weekStartDay: 2 },
      });
      expect(res.statusCode).toBe(400);

      const getRes = await getSettings(app, deviceKey);
      expect(JSON.parse(getRes.body).locale).toEqual({
        timezone: "America/New_York",
        language: "en",
        weekStartDay: 0,
      });
    } finally {
      await app.close();
    }
  });

  // ── envelope: closed SettingsWrite shape ───────────────────────────────

  it("PUT with an unknown top-level envelope key returns 400, nothing persisted (016-review P2-3)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 40, lon: -3 },
        extra: 1,
      });
      expect(res.statusCode).toBe(400);

      const db = getDb();
      const row = db.prepare("SELECT * FROM settings_objects WHERE object_name = 'weather'").get();
      expect(row).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  // ── locale partial payload: never a silent default-reset ──────────────

  it("PUT locale with language only (partial payload) returns 400, prior locale unchanged (651-review P1)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      // First set a non-default locale as the whole object.
      const initial = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "America/New_York", language: "en", weekStartDay: 0 },
      });
      expect(initial.statusCode).toBe(200);

      // A language-only PATCH-shaped payload must be rejected — never a silent reset of
      // timezone/weekStartDay to defaults.
      const partial = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { language: "es" },
      });
      expect(partial.statusCode).toBe(400);

      const getRes = await getSettings(app, deviceKey);
      expect(JSON.parse(getRes.body).locale).toEqual({
        timezone: "America/New_York",
        language: "en",
        weekStartDay: 0,
      });
    } finally {
      await app.close();
    }
  });

  // ── valid writes: atomic replace + PUT 200 body shape ──────────────────

  it("PUT valid weather replaces the object atomically; a subsequent read returns it", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    setPluginState("weather", "active");
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
      });
      expect(res.statusCode).toBe(200);

      // PUT 200 returns the updated EFFECTIVE settings map (same shape as GET).
      const putBody = JSON.parse(res.body);
      expect(putBody.weather).toEqual({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
      expect(putBody.locale).toEqual({
        timezone: "Europe/Madrid",
        language: "es",
        weekStartDay: 1,
      });

      const getRes = await getSettings(app, deviceKey);
      expect(JSON.parse(getRes.body).weather).toEqual({
        lat: 40.4168,
        lon: -3.7038,
        label: "Madrid",
      });
    } finally {
      await app.close();
    }
  });

  it("clear-as-unit: writing {lat:null, lon:null} over a set location blanks it atomically", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    setPluginState("weather", "active");
    const app = await buildApp();
    try {
      await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 10, lon: 20 },
      });
      const clearRes = await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: null, lon: null },
      });
      expect(clearRes.statusCode).toBe(200);
      expect(JSON.parse(clearRes.body).weather).toEqual({ lat: null, lon: null });
    } finally {
      await app.close();
    }
  });

  it("PUT valid locale (all three fields) replaces the object and round-trips", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    const app = await buildApp();
    try {
      const res = await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "Pacific/Auckland", language: "en", weekStartDay: 1 },
      });
      expect(res.statusCode).toBe(200);
      const getRes = await getSettings(app, deviceKey);
      expect(JSON.parse(getRes.body).locale).toEqual({
        timezone: "Pacific/Auckland",
        language: "en",
        weekStartDay: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("a write to one object does not disturb the other (atomicity is per-object)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedDeviceKey();
    setPluginState("weather", "active");
    const app = await buildApp();
    try {
      await putSettings(app, deviceKey, {
        object: "locale",
        settings: { timezone: "UTC", language: "en", weekStartDay: 0 },
      });
      await putSettings(app, deviceKey, {
        object: "weather",
        settings: { lat: 1, lon: 2 },
      });

      const getRes = await getSettings(app, deviceKey);
      const body = JSON.parse(getRes.body);
      expect(body.locale).toEqual({ timezone: "UTC", language: "en", weekStartDay: 0 });
      expect(body.weather).toEqual({ lat: 1, lon: 2 });
    } finally {
      await app.close();
    }
  });
});
