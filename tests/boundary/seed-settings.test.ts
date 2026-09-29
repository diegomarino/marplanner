import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { useIsolatedDb } from "../helpers/db";

const NOW = 1_790_121_600_000;
const AS_OF_DATE = "2026-09-23";

describe("public settings seed", () => {
  useIsolatedDb();

  it("runs through the seed runner and exposes only portable settings through authenticated GET", async () => {
    const report = await runSettingsSeed();
    expect(report).toMatchObject({
      moduleIds: [
        "public:settings",
        "members:demo",
        "calendar:demo",
        "routines:demo",
        "reminders:demo",
        "meals:demo",
        "daily:content:demo",
        "time:announcements:demo",
      ],
      asOfDate: AS_OF_DATE,
      status: "complete",
    });

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const response = await getSettings(app, seedDeviceKey());
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
        weather: { lat: 39.7817, lon: -89.6501, label: "Springfield" },
        printer: { paperWidthDots: 576 },
      });
      expect(JSON.parse(response.body)).not.toHaveProperty("printerTransport");
      expect(JSON.stringify(JSON.parse(response.body))).not.toMatch(
        /deviceId|serviceUuid|characteristicUuid|capabilit|connect|pair|job|activit/i
      );
    } finally {
      await app.close();
    }
    expect(
      getDb().prepare("SELECT object_name, data FROM settings_objects ORDER BY object_name").all()
    ).toEqual([
      {
        object_name: "locale",
        data: JSON.stringify({ timezone: "Europe/Madrid", language: "en", weekStartDay: 1 }),
      },
      {
        object_name: "printer",
        data: JSON.stringify({ paperWidthDots: 576 }),
      },
      {
        object_name: "weather",
        data: JSON.stringify({ lat: 39.7817, lon: -89.6501, label: "Springfield" }),
      },
    ]);
  });

  it("is deterministic on runner rerun and omits private transport and printer runtime state", async () => {
    await runSettingsSeed();
    const firstRows = getDb()
      .prepare("SELECT object_name, data FROM settings_objects ORDER BY object_name")
      .all();

    await expect(runSettingsSeed()).resolves.toMatchObject({
      markerAction: "rerun",
      status: "complete",
    });

    expect(
      getDb().prepare("SELECT object_name, data FROM settings_objects ORDER BY object_name").all()
    ).toEqual(firstRows);
    expect(
      getDb().prepare("SELECT object_name FROM settings_objects ORDER BY object_name").all()
    ).toEqual([{ object_name: "locale" }, { object_name: "printer" }, { object_name: "weather" }]);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM printer_capabilities").get()).toEqual({
      count: 0,
    });
  });
});

function seedDeviceKey(): string {
  const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(`${NOW}-device`, hashKey(deviceKey), NOW);
  return deviceKey;
}

async function getSettings(app: FastifyInstance, deviceKey: string) {
  return app.inject({ method: "GET", url: "/api/settings", cookies: { mp_device_key: deviceKey } });
}

function runSettingsSeed() {
  return runSeedProfile({
    mode: "public",
    asOfDate: AS_OF_DATE,
    nowMs: NOW,
    disposableTarget: true,
  });
}
