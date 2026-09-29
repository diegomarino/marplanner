import { describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("calendar external-source routes", () => {
  useIsolatedDb();

  it("delegates persisted source writes to the Calendar seam and never returns or fetches the raw URL", async () => {
    const deviceKey = `mpk-${Date.now()}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run("device", hashKey(deviceKey), Date.now());
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rawUrl = "https://8.8.8.8/feed?token=top-secret";
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp({
      calendarFeed: {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        transport: async () =>
          "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:public-holiday\nDTSTART;VALUE=DATE:20260928\nSUMMARY:Public holiday\nEND:VEVENT\nEND:VCALENDAR",
      },
    });
    // App assembly may load an in-process data URI; assert only the source-write interval.
    fetchSpy.mockClear();

    try {
      for (const payload of [
        null,
        [],
        {
          name: "Incomplete source",
          provider: "ics_generic",
          pollIntervalMin: 60,
        },
        {
          name: "Unexpected source field",
          provider: "ics_generic",
          feedUrl: "https://8.8.8.8/feed",
          enabled: true,
          pollIntervalMin: 60,
          unexpected: true,
        },
      ]) {
        const invalidEnvelope = await app.inject({
          method: "PUT",
          url: "/api/calendar/external-sources/invalid-envelope",
          cookies: { mp_device_key: deviceKey },
          headers: { "content-type": "application/json" },
          payload: JSON.stringify(payload),
        });
        expect(invalidEnvelope.statusCode).toBe(400);
      }

      const write = await app.inject({
        method: "PUT",
        url: "/api/calendar/external-sources/public",
        cookies: { mp_device_key: deviceKey },
        payload: {
          name: "Public holidays",
          provider: "unknown",
          feedUrl: rawUrl,
          pollIntervalMin: 60,
        },
      });
      expect(write.statusCode).toBe(202);
      expect(write.body).not.toContain(rawUrl);
      expect(JSON.parse(write.body)).toMatchObject({
        provider: "ics_generic",
        maskedUrl: "https://8.8.8.8/***",
      });

      const read = await app.inject({
        method: "GET",
        url: "/api/calendar/external-sources",
        cookies: { mp_device_key: deviceKey },
      });
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain(rawUrl);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
