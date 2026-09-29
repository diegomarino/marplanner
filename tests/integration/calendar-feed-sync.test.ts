import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { listExternalSources } from "../../src/server/modules/calendar/external-sources";
import { getEvents } from "../../src/server/modules/calendar/index";
import {
  getExternalSourcePhase,
  startExternalSourceSynchronization,
} from "../../src/server/modules/calendar/sync-coordinator";
import { useIsolatedDb } from "../helpers/db";

const sourceId = "sync-source";

function calendar(title: string): string {
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
  return `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:sync-event\nDTSTAMP:${date}T000000Z\nDTSTART;VALUE=DATE:${date}\nSUMMARY:${title}\nEND:VEVENT\nEND:VCALENDAR`;
}

describe("calendar feed synchronization", () => {
  useIsolatedDb();

  function insertSource(): void {
    getDb()
      .prepare(
        "INSERT INTO calendar_external_sources (id, name, provider, feed_url, created_at, updated_at) VALUES (?, 'Source', 'ics_generic', 'https://calendar.example.test/feed', 1, 1)"
      )
      .run(sourceId);
  }

  it("shares one active retrieval, then publishes and exposes a terminal phase", async () => {
    insertSource();
    let release!: (body: string) => void;
    const waiting = new Promise<string>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => {
        requests += 1;
        return waiting;
      },
    };

    const first = startExternalSourceSynchronization(sourceId, dependencies);
    const second = startExternalSourceSynchronization(sourceId, dependencies);
    expect(second).toBe(first);
    release(calendar("Shared event"));
    await Promise.all([first, second]);

    expect(requests).toBe(1);
    expect(getExternalSourcePhase(sourceId)).toBe("succeeded");
    expect(listExternalSources()[0]).toMatchObject({
      lastErrorCode: null,
      lastImportedCount: 1,
      consecutiveFailures: 0,
    });
    expect(
      getDb()
        .prepare("SELECT content_hash FROM calendar_external_sources WHERE id = ?")
        .get(sourceId)
    ).toMatchObject({ content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("keeps a terminal-phase run shared until its promise settles", async () => {
    insertSource();
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => calendar("One run"),
      phaseDelayMs: 15,
    };
    const first = startExternalSourceSynchronization(sourceId, dependencies);
    while (getExternalSourcePhase(sourceId) !== "succeeded") {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    const second = startExternalSourceSynchronization(sourceId, dependencies);
    try {
      expect(second).toBe(first);
    } finally {
      await Promise.all([first, second]);
    }
  });

  it("retains a failed first source for retry and records safe durable health", async () => {
    insertSource();
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => {
        throw new Error("private upstream detail");
      },
    };
    await startExternalSourceSynchronization(sourceId, dependencies);
    expect(getExternalSourcePhase(sourceId)).toBe("failed");
    expect(listExternalSources()[0]).toMatchObject({
      lastErrorCode: "unavailable",
      consecutiveFailures: 1,
      lastSuccessAt: null,
    });

    await startExternalSourceSynchronization(sourceId, {
      ...dependencies,
      transport: async () => calendar("Recovered"),
    });
    expect(getExternalSourcePhase(sourceId)).toBe("succeeded");
    expect(listExternalSources()[0]).toMatchObject({
      lastErrorCode: null,
      consecutiveFailures: 0,
      lastImportedCount: 1,
    });
  });

  it("publishes valid neighbours and records malformed-event isolation", async () => {
    insertSource();
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const body = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:valid-neighbour\nDTSTAMP:${date}T000000Z\nDTSTART;VALUE=DATE:${date}\nSUMMARY:Visible\nEND:VEVENT\nBEGIN:VEVENT\nUID:invalid-neighbour\nDTSTAMP:${date}T000000Z\nDTSTART;VALUE=DATE:${date}\nEND:VEVENT\nEND:VCALENDAR`;
    await startExternalSourceSynchronization(sourceId, {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => body,
    });
    expect(getExternalSourcePhase(sourceId)).toBe("succeeded");
    expect(listExternalSources()[0]).toMatchObject({ lastImportedCount: 1, lastSkippedCount: 1 });
    expect(getDb().prepare("SELECT external_uid FROM calendar_external_event_meta").all()).toEqual([
      { external_uid: "valid-neighbour" },
    ]);
  });

  it("persists validators and treats a conditional 304 as success without republishing events", async () => {
    insertSource();
    let requestedValidator: string | undefined;
    let requests = 0;
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      request: async ({ headers }: { headers: Record<string, string> }) => {
        requests += 1;
        requestedValidator = headers["if-none-match"];
        return requests === 1
          ? {
              status: 200,
              headers: new Headers({ "content-type": "text/calendar", etag: '"version-one"' }),
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(calendar("Stable")));
                  controller.close();
                },
              }),
              dispose: async () => undefined,
            }
          : {
              status: 304,
              headers: new Headers(),
              body: null,
              dispose: async () => undefined,
            };
      },
    };
    await startExternalSourceSynchronization(sourceId, dependencies);
    const before = getDb().prepare("SELECT * FROM calendar_events").all();
    await startExternalSourceSynchronization(sourceId, dependencies);
    expect(requestedValidator).toBe('"version-one"');
    expect(getExternalSourcePhase(sourceId)).toBe("succeeded");
    expect(getDb().prepare("SELECT * FROM calendar_events").all()).toEqual(before);
    expect(
      getDb()
        .prepare("SELECT etag, content_hash FROM calendar_external_sources WHERE id = ?")
        .get(sourceId)
    ).toMatchObject({
      etag: '"version-one"',
      content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("preserves the complete prior snapshot after a failed publication and records failure health", async () => {
    insertSource();
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => calendar("Original"),
    };
    await startExternalSourceSynchronization(sourceId, dependencies);
    const before = {
      events: getDb().prepare("SELECT * FROM calendar_events").all(),
      meta: getDb().prepare("SELECT * FROM calendar_external_event_meta").all(),
      read: getEvents({
        source: "all",
        range: {
          from: new Date().toISOString().slice(0, 10),
          to: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        },
      }),
    };
    getDb().exec(
      "CREATE TRIGGER fail_calendar_publication BEFORE UPDATE ON calendar_events BEGIN SELECT RAISE(ABORT, 'forced publication failure'); END"
    );

    await startExternalSourceSynchronization(sourceId, {
      ...dependencies,
      transport: async () => calendar("Changed"),
    });
    expect(getExternalSourcePhase(sourceId)).toBe("failed");
    expect(listExternalSources()[0]).toMatchObject({
      lastErrorCode: "reconcile_failed",
      consecutiveFailures: 1,
    });
    expect(getDb().prepare("SELECT * FROM calendar_events").all()).toEqual(before.events);
    expect(getDb().prepare("SELECT * FROM calendar_external_event_meta").all()).toEqual(
      before.meta
    );
    expect(
      getEvents({
        source: "all",
        range: {
          from: new Date().toISOString().slice(0, 10),
          to: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        },
      })
    ).toEqual(before.read);
  });
});
