import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { listExternalSources } from "../../src/server/modules/calendar";
import { hashKey } from "../../src/server/auth/credentials";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW = 1_790_121_600_000;
const RAW_URLS = [
  "https://web-api.worldpublicholiday.com/v1/holidays/calendar.ics?country=ES&year=2026",
  "https://cantonbecker.com/astronomy-calendar/astrocal.ics",
  "https://cdn.celtics.com/schedule/ics/2026_celtics_schedule.ics",
  "https://api.sports-calendar.com/ics/soccer/english-premier-league/2026-2027/matches.ics",
];

describe("Calendar demo seed integration", () => {
  useIsolatedDb();
  // Keep fixed Calendar fixtures inside the production rolling window; leave async timers real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("runs through the seed runner and exposes only masked source URLs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await runSeedProfile({
        mode: "public",
        asOfDate: AS_OF_DATE,
        nowMs: NOW,
        disposableTarget: true,
      });

      const publicSources = listExternalSources();
      const publicResponse = JSON.stringify(publicSources);
      expect(publicSources).toEqual([
        {
          id: "demo:calendar:source:astronomy",
          name: "Astronomy calendar",
          provider: "ics_generic",
          maskedUrl: "https://cantonbecker.com/***",
          enabled: true,
          pollIntervalMin: 60,
          phase: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastErrorCode: null,
          consecutiveFailures: 0,
          lastImportedCount: 0,
          lastSkippedCount: 0,
        },
        {
          id: "demo:calendar:source:boston-celtics",
          name: "Boston Celtics 2026 season",
          provider: "ics_generic",
          maskedUrl: "https://cdn.celtics.com/***",
          enabled: true,
          pollIntervalMin: 60,
          phase: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastErrorCode: null,
          consecutiveFailures: 0,
          lastImportedCount: 0,
          lastSkippedCount: 0,
        },
        {
          id: "demo:calendar:source:english-premier-league",
          name: "English Premier League 2026-2027",
          provider: "ics_generic",
          maskedUrl: "https://api.sports-calendar.com/***",
          enabled: true,
          pollIntervalMin: 60,
          phase: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastErrorCode: null,
          consecutiveFailures: 0,
          lastImportedCount: 0,
          lastSkippedCount: 0,
        },
        {
          id: "demo:calendar:source:spain-holidays",
          name: "Spain public holidays (2026)",
          provider: "ics_generic",
          maskedUrl: "https://web-api.worldpublicholiday.com/***",
          enabled: true,
          pollIntervalMin: 60,
          phase: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastErrorCode: null,
          consecutiveFailures: 0,
          lastImportedCount: 0,
          lastSkippedCount: 0,
        },
      ]);
      for (const rawUrl of RAW_URLS) expect(publicResponse).not.toContain(rawUrl);
      // Lifecycle assembly may load embedded WASM; no external fetch is allowed.
      expect(
        fetchSpy.mock.calls.filter(
          ([input]) => !String(input).startsWith("data:application/octet-stream;base64,")
        )
      ).toEqual([]);
      expect(
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE source = 'external'")
          .get()
      ).toEqual({ count: 0 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reads stable local seed events through the Calendar route after a changed-clock rerun", async () => {
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW,
      disposableTarget: true,
    });
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW + 1,
      disposableTarget: true,
    });
    const deviceKey = "calendar-seed-route-key";
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run("calendar-seed-route-device", hashKey(deviceKey), NOW);
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/calendar/events?source=all&from=2026-09-23&to=2026-09-26",
        cookies: { mp_device_key: deviceKey },
      });

      expect(response.statusCode).toBe(200);
      const events = JSON.parse(response.body);
      // Wed 23 – Sat 26: 6 asOfDate-relative events, 5 week-relative one-offs, 6 occurrences of
      // weekly recurring events (3 plant shifts, saxophone, bowling league, baby gym) and the
      // grandparents' visit that began on the 22nd and is still running (reads are overlaps).
      expect(events).toHaveLength(18);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "demo:calendar:event:lisa-homework-club",
            title: "Lisa homework club",
            source: "local",
            allDay: false,
          }),
          expect.objectContaining({
            id: "demo:calendar:event:grandparents-visiting",
            occurrenceStart: "2026-09-22",
            allDay: true,
          }),
          expect.objectContaining({
            id: "demo:calendar:event:family-bowling",
            title: "Family bowling night",
            source: "local",
            allDay: true,
          }),
        ])
      );
    } finally {
      await app.close();
    }
  });
});
