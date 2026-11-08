import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getEvents } from "../../src/server/modules/calendar/index";
import {
  deleteExternalSource,
  setExternalSourceEnabled,
} from "../../src/server/modules/calendar/external-sources";
import { startExternalSourceSynchronization } from "../../src/server/modules/calendar/sync-coordinator";
import { useIsolatedDb } from "../helpers/db";

let sourceId = "";
let sequence = 0;
const range = { from: "2026-10-15", to: "2026-10-15" };
const feed = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:school-day",
  "DTSTAMP:20260928T000000Z",
  "DTSTART;VALUE=DATE:20261015",
  "SUMMARY:Alex school day",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function insertSource(): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_external_sources (id, name, provider, feed_url, created_at, updated_at)
       VALUES (?, 'School', 'ics_generic', 'https://calendar.example.test/feed', 1, 1)`
    )
    .run(sourceId);
  getDb()
    .prepare(
      `INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at)
       VALUES ('alex', 'Alex', 'child', 'active', 1, 1)`
    )
    .run();
}

const dependencies = {
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  transport: async () => feed,
};

describe("calendar external-source lifecycle", () => {
  useIsolatedDb();
  // Keep fixed Calendar fixtures inside the production rolling window; leave async timers real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    sourceId = `lifecycle-source-${++sequence}`;
  });

  it("hides retained rows on disable and immediately restores them on enable", async () => {
    insertSource();
    await startExternalSourceSynchronization(sourceId, dependencies);
    expect(getEvents({ source: "external", range })).toHaveLength(1);

    expect(setExternalSourceEnabled(sourceId, false)?.enabled).toBe(false);
    expect(getEvents({ source: "external", range })).toEqual([]);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM calendar_events").get()).toEqual({
      count: 1,
    });
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM calendar_external_event_meta").get()
    ).toEqual({
      count: 1,
    });

    expect(setExternalSourceEnabled(sourceId, true)?.enabled).toBe(true);
    expect(getEvents({ source: "external", range })).toHaveLength(1);
  });

  it("lets an active run settle after disable but blocks every later trigger", async () => {
    insertSource();
    let release!: (body: string) => void;
    let entered!: () => void;
    const waiting = new Promise<string>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let requests = 0;
    const run = startExternalSourceSynchronization(sourceId, {
      ...dependencies,
      transport: async () => {
        requests += 1;
        entered();
        return waiting;
      },
    });
    await started;
    try {
      setExternalSourceEnabled(sourceId, false);
      const later = startExternalSourceSynchronization(sourceId, dependencies);
      release(feed);
      await Promise.all([run, later]);
    } finally {
      release(feed);
      await run;
    }
    await startExternalSourceSynchronization(sourceId, dependencies);
    expect(requests).toBe(1);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM calendar_events").get()).toEqual({
      count: 1,
    });
    expect(getEvents({ source: "external", range })).toEqual([]);
  });

  it("waits for an active run, blocks waiting triggers, and leaves no source-owned rows", async () => {
    insertSource();
    let release!: (body: string) => void;
    let entered!: () => void;
    const waiting = new Promise<string>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let requests = 0;
    const run = startExternalSourceSynchronization(sourceId, {
      ...dependencies,
      transport: async () => {
        requests += 1;
        entered();
        return waiting;
      },
    });
    await started;
    const deletion = deleteExternalSource(sourceId);
    const waitingTrigger = startExternalSourceSynchronization(sourceId, dependencies);
    try {
      expect(
        getDb().prepare("SELECT COUNT(*) AS count FROM calendar_external_sources").get()
      ).toEqual({ count: 1 });
      release(feed);
      expect(await deletion).toBe(true);
      await Promise.all([run, waitingTrigger]);
    } finally {
      release(feed);
      await Promise.allSettled([run, deletion, waitingTrigger]);
    }
    await startExternalSourceSynchronization(sourceId, dependencies);
    expect(requests).toBe(1);
    for (const table of [
      "calendar_external_sources",
      "calendar_external_event_meta",
      "calendar_assignments",
      "calendar_events",
    ]) {
      expect(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(getEvents({ source: "external", range })).toEqual([]);
    expect(await deleteExternalSource(sourceId)).toBe(false);
  });

  it("keeps the successful snapshot after a later failed retrieval", async () => {
    insertSource();
    await startExternalSourceSynchronization(sourceId, dependencies);
    const before = getEvents({ source: "external", range });
    await startExternalSourceSynchronization(sourceId, {
      ...dependencies,
      transport: async () => {
        throw new Error("upstream unavailable");
      },
    });
    expect(getEvents({ source: "external", range })).toEqual(before);
    expect(
      getDb()
        .prepare("SELECT last_error_code, consecutive_failures FROM calendar_external_sources")
        .get()
    ).toEqual({
      last_error_code: "unavailable",
      consecutive_failures: 1,
    });
  });

  it("publishes the rest of a feed and logs only counts when one event exceeds the feed limits", async () => {
    insertSource();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const overLimit = [
      "BEGIN:VEVENT",
      "UID:over-limit",
      "DTSTAMP:20260928T000000Z",
      "DTSTART:20261015T080000Z",
      "SUMMARY:Over limit",
      "RRULE:FREQ=HOURLY",
      "END:VEVENT",
    ];
    const lines = feed.split("\r\n");
    const mixed = [...lines.slice(0, -1), ...overLimit, lines.at(-1)].join("\r\n");
    try {
      await startExternalSourceSynchronization(sourceId, {
        ...dependencies,
        transport: async () => mixed,
      });
      expect(getEvents({ source: "external", range }).map((event) => event.title)).toEqual([
        "Alex school day",
      ]);
      expect(warn).toHaveBeenCalledWith("calendar.external-sources.feed-limits", {
        sourceId,
        unsupported_rrule: 1,
      });
      expect(
        getDb()
          .prepare("SELECT last_error_code, last_skipped_count FROM calendar_external_sources")
          .get()
      ).toEqual({ last_error_code: null, last_skipped_count: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  const timedEvent = (uid: string, rule: string): string[] => [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260928T000000Z",
    "DTSTART:20261015T080000Z",
    `SUMMARY:${uid}`,
    rule,
    "END:VEVENT",
  ];
  const calendarOf = (...events: string[][]): string =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR"].join("\r\n");
  const statusByUid = () =>
    Object.fromEntries(
      (
        getDb()
          .prepare(
            "SELECT external_uid, MIN(status) AS status FROM calendar_external_event_meta GROUP BY external_uid"
          )
          .all() as Array<{ external_uid: string; status: string }>
      ).map(({ external_uid, status }) => [external_uid, status])
    );

  it("fails the sync and keeps the previous snapshot when a feed exceeds a feed-wide limit", async () => {
    insertSource();
    await startExternalSourceSynchronization(sourceId, dependencies);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const series = Array.from({ length: 30 }, (_, index) =>
      timedEvent(`daily-${index}`, "RRULE:FREQ=DAILY")
    );
    try {
      await startExternalSourceSynchronization(sourceId, {
        ...dependencies,
        transport: async () => calendarOf(...series),
      });
      expect(getEvents({ source: "external", range }).map((event) => event.title)).toEqual([
        "Alex school day",
      ]);
      expect(statusByUid()).toEqual({ "school-day": "active" });
      expect(
        getDb()
          .prepare("SELECT last_error_code, consecutive_failures FROM calendar_external_sources")
          .get()
      ).toEqual({ last_error_code: "parse_failed", consecutive_failures: 1 });
      expect(warn).toHaveBeenCalledWith("calendar.external-sources.feed-limits", {
        sourceId,
        feed_occurrences_truncated: 1,
      });

      // A feed node-ical itself rejects fails the same way but logs no limit counts.
      warn.mockClear();
      await startExternalSourceSynchronization(sourceId, {
        ...dependencies,
        transport: async () => calendarOf(timedEvent("broken", "RRULE:freq=daily")),
      });
      expect(statusByUid()).toEqual({ "school-day": "active" });
      expect(
        getDb().prepare("SELECT last_error_code FROM calendar_external_sources").get()
      ).toEqual({ last_error_code: "parse_failed" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps an imported event a feed limit now drops and still cancels one the feed removed", async () => {
    insertSource();
    const weekly = timedEvent("club", "RRULE:FREQ=WEEKLY;COUNT=3");
    const school = timedEvent("school", "");
    await startExternalSourceSynchronization(sourceId, {
      ...dependencies,
      transport: async () => calendarOf(weekly, school),
    });
    expect(statusByUid()).toEqual({ club: "active", school: "active" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await startExternalSourceSynchronization(sourceId, {
        ...dependencies,
        transport: async () => calendarOf(timedEvent("club", "RRULE:FREQ=HOURLY")),
      });
    } finally {
      warn.mockRestore();
    }
    expect(statusByUid()).toEqual({ club: "active", school: "cancelled" });
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS count FROM calendar_external_event_meta WHERE external_uid = 'club'"
        )
        .get()
    ).toEqual({ count: 3 });
    expect(getDb().prepare("SELECT last_error_code FROM calendar_external_sources").get()).toEqual({
      last_error_code: null,
    });
  });
});
