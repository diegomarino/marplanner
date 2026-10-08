import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { calendarRoutes } from "../../src/server/routes/calendar";
import { startExternalSourceSynchronization } from "../../src/server/modules/calendar/sync-coordinator";
import { upsertExternalSource } from "../../src/server/modules/calendar/external-sources";
import { useIsolatedDb } from "../helpers/db";

const id = "route-source";
const feed = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:route-event",
  "DTSTAMP:20260928T000000Z",
  "DTSTART;VALUE=DATE:20261015",
  "SUMMARY:Route event",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("calendar source lifecycle routes", () => {
  useIsolatedDb();
  // Keep fixed Calendar fixtures inside the production rolling window; leave async timers real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("serializes URL replacement with an active sync and removes the old feed snapshot", async () => {
    const sourceId = "replacement-source";
    const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
    await upsertExternalSource(
      {
        id: sourceId,
        name: "Original source",
        provider: "ics_generic",
        feedUrl: "https://calendar.example.test/original",
      },
      { lookup }
    );

    let enterTransport!: () => void;
    let releaseTransport!: () => void;
    const enteredTransport = new Promise<void>((resolve) => (enterTransport = resolve));
    const heldTransport = new Promise<void>((resolve) => (releaseTransport = resolve));
    const activeSync = startExternalSourceSynchronization(sourceId, {
      lookup,
      transport: async () => {
        enterTransport();
        await heldTransport;
        return feed;
      },
    });
    await enteredTransport;

    let replacementSettled = false;
    const replacement = upsertExternalSource(
      {
        id: sourceId,
        name: "Replacement source",
        provider: "google",
        feedUrl: "https://calendar.example.test/replacement",
        pollIntervalMin: 30,
      },
      { lookup }
    ).then((source) => {
      replacementSettled = true;
      return source;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(replacementSettled).toBe(false);
    } finally {
      releaseTransport();
      await Promise.allSettled([activeSync, replacement]);
    }
    await activeSync;
    await replacement;

    expect(getDb().prepare("SELECT COUNT(*) AS count FROM calendar_events").get()).toEqual({
      count: 0,
    });
    expect(
      getDb()
        .prepare(
          `SELECT feed_url, etag, last_modified, content_hash, last_attempt_at, last_success_at,
                  last_error_code, consecutive_failures, last_imported_count, last_skipped_count
           FROM calendar_external_sources WHERE id = ?`
        )
        .get(sourceId)
    ).toEqual({
      feed_url: "https://calendar.example.test/replacement",
      etag: null,
      last_modified: null,
      content_hash: null,
      last_attempt_at: null,
      last_success_at: null,
      last_error_code: null,
      consecutive_failures: 0,
      last_imported_count: 0,
      last_skipped_count: 0,
    });
  });

  it("rejects a PUT suspended before DELETE but permits a fresh PUT afterward", async () => {
    const sourceId = "race-source";
    getDb()
      .prepare(
        `INSERT INTO calendar_external_sources (id, name, provider, feed_url, created_at, updated_at)
         VALUES (?, 'Original', 'ics_generic', 'https://calendar.example.test/original', 1, 1)`
      )
      .run(sourceId);

    let enterLookup!: () => void;
    let releaseLookup!: () => void;
    const enteredLookup = new Promise<void>((resolve) => (enterLookup = resolve));
    const heldLookup = new Promise<void>((resolve) => (releaseLookup = resolve));
    let lookups = 0;
    const app = Fastify();
    await calendarRoutes(app, {
      lookup: async () => {
        lookups += 1;
        if (lookups === 1) {
          enterLookup();
          await heldLookup;
        }
        return [{ address: "8.8.8.8", family: 4 }];
      },
      transport: async () => feed,
    });

    const put = () =>
      app.inject({
        method: "PUT",
        url: `/api/calendar/external-sources/${sourceId}`,
        payload: {
          name: "New source",
          provider: "apple",
          feedUrl: "https://calendar.example.test/new",
          pollIntervalMin: 60,
        },
      });
    try {
      const stalePut = put();
      await enteredLookup;
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/calendar/external-sources/${sourceId}`,
      });
      expect(deleted.statusCode).toBe(204);
      expect(
        getDb().prepare("SELECT COUNT(*) AS count FROM calendar_external_sources").get()
      ).toEqual({ count: 0 });

      releaseLookup();
      const staleResponse = await stalePut;
      expect(staleResponse.statusCode).toBe(400);
      expect(staleResponse.json()).toEqual({ error: "invalid_external_source" });
      expect(
        getDb().prepare("SELECT COUNT(*) AS count FROM calendar_external_sources").get()
      ).toEqual({ count: 0 });

      const freshResponse = await put();
      expect(freshResponse.statusCode).toBe(202);
      expect(freshResponse.json()).toMatchObject({ id: sourceId, pollIntervalMin: 60 });
    } finally {
      releaseLookup();
      await app.close();
    }
  });

  it("keeps PATCH independent of PUT policy and DELETE, with safe not-found outcomes", async () => {
    const app = Fastify();
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => feed,
    };
    await calendarRoutes(app, dependencies);
    try {
      const created = await app.inject({
        method: "PUT",
        url: `/api/calendar/external-sources/${id}`,
        payload: {
          name: "Route source",
          provider: "apple",
          feedUrl: "https://calendar.example.test/private?token=secret",
          pollIntervalMin: 60,
        },
      });
      expect(created.statusCode).toBe(202);
      await startExternalSourceSynchronization(id, dependencies);

      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/calendar/external-sources/${id}`,
        payload: { enabled: false, feedUrl: "https://other.example.test" },
      });
      expect(invalid.statusCode).toBe(400);
      const disabled = await app.inject({
        method: "PATCH",
        url: `/api/calendar/external-sources/${id}`,
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ id, enabled: false, pollIntervalMin: 60 });
      expect(disabled.body).not.toContain("token=secret");
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/calendar/events?source=external&from=2026-10-15&to=2026-10-15",
          })
        ).json()
      ).toEqual([]);
      expect(
        (await app.inject({ method: "POST", url: `/api/calendar/external-sources/${id}/sync` }))
          .statusCode
      ).toBe(409);

      const enabled = await app.inject({
        method: "PATCH",
        url: `/api/calendar/external-sources/${id}`,
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/calendar/events?source=external&from=2026-10-15&to=2026-10-15",
          })
        ).json()
      ).toHaveLength(1);

      expect(
        (await app.inject({ method: "DELETE", url: `/api/calendar/external-sources/${id}` }))
          .statusCode
      ).toBe(204);
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM calendar_events").get()).toEqual({
        count: 0,
      });
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/calendar/external-sources/${id}`,
            payload: { enabled: true },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/calendar/external-sources/${id}` }))
          .statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: "POST", url: `/api/calendar/external-sources/${id}/sync` }))
          .statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
