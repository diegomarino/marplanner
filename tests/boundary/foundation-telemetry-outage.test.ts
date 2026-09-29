import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { buildApp } from "../../src/server/app";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("foundation telemetry outage isolation", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("serves authenticated settings writes and reads when client_log is unavailable", async () => {
    const key = "mpk-synthetic-telemetry-outage-key";
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run("synthetic-device", hashKey(key), Date.now());
    const app = await buildApp();
    try {
      getDb().exec("DROP TABLE client_log");
      const write = await app.inject({
        method: "PUT",
        url: "/api/settings",
        cookies: { mp_device_key: key },
        payload: {
          object: "locale",
          settings: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
        },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().locale.language).toBe("en");
      const read = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { mp_device_key: key },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().locale).toEqual({
        timezone: "Europe/Madrid",
        language: "en",
        weekStartDay: 1,
      });
    } finally {
      await app.close();
    }
  });
});
