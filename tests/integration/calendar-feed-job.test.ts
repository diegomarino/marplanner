import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import {
  CALENDAR_FEED_POLL_JOB_ID,
  registerCalendarFeedJob,
  sweepCalendarFeeds,
} from "../../src/server/modules/calendar/job";
import { startExternalSourceSynchronization } from "../../src/server/modules/calendar/sync-coordinator";
import { useIsolatedDb } from "../helpers/db";

const MINUTE = 60_000;
const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:poll-event\nDTSTAMP:${date}Z\nDTSTART;VALUE=DATE:${date}\nSUMMARY:Poll event\nEND:VEVENT\nEND:VCALENDAR`;

function insertSource(
  id: string,
  options: { interval?: number; attempted?: number | null; enabled?: boolean } = {}
) {
  if (options.interval === undefined) {
    getDb()
      .prepare(
        `INSERT INTO calendar_external_sources
         (id, name, provider, feed_url, enabled, last_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'ics_generic', ?, ?, ?, 1, 1)`
      )
      .run(
        id,
        id,
        `https://${id}.example.test/feed`,
        options.enabled === false ? 0 : 1,
        options.attempted ?? null
      );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO calendar_external_sources
       (id, name, provider, feed_url, enabled, poll_interval_min, last_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'ics_generic', ?, ?, ?, ?, 1, 1)`
    )
    .run(
      id,
      id,
      `https://${id}.example.test/feed`,
      options.enabled === false ? 0 : 1,
      options.interval,
      options.attempted ?? null
    );
}

function dependencies(onRequest: (id: string) => Promise<string>) {
  return {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async (url: URL) => onRequest(url.hostname.split(".")[0]),
  };
}

describe("calendar feed polling job", () => {
  useIsolatedDb();
  afterEach(async () => {
    try {
      await getScheduler().stop();
    } catch {
      // Some tests call the sweep without initializing a scheduler.
    }
    vi.restoreAllMocks();
  });

  it("selects only enabled sources due at each persisted interval, including the default 15 minutes", async () => {
    const now = Date.now();
    insertSource("fresh");
    insertSource("one-due", { interval: 1, attempted: now - MINUTE });
    insertSource("one-early", { interval: 1, attempted: now - MINUTE + 1 });
    insertSource("thirty-due", { interval: 30, attempted: now - 30 * MINUTE });
    insertSource("thirty-early", { interval: 30, attempted: now - 30 * MINUTE + 1 });
    insertSource("default-due", { attempted: now - 15 * MINUTE });
    insertSource("default-early", { attempted: now - 15 * MINUTE + 1 });
    insertSource("disabled", { interval: 1, attempted: null, enabled: false });
    const requested: string[] = [];

    await sweepCalendarFeeds(
      now,
      dependencies(async (id) => {
        requested.push(id);
        return feed;
      })
    );

    expect(requested.sort()).toEqual(["default-due", "fresh", "one-due", "thirty-due"]);
    expect(
      getDb()
        .prepare("SELECT last_attempt_at FROM calendar_external_sources WHERE id = 'disabled'")
        .get()
    ).toEqual({ last_attempt_at: null });
  });

  it("registers one one-minute host job and contains overlapping sweeps", async () => {
    insertSource("overlap");
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const scheduler = initScheduler();
    registerCalendarFeedJob(
      dependencies(async () => {
        requests += 1;
        return pending;
      })
    );

    const first = scheduler.runJobNow(CALENDAR_FEED_POLL_JOB_ID);
    await vi.waitFor(() => expect(requests).toBe(1));
    const second = await scheduler.runJobNow(CALENDAR_FEED_POLL_JOB_ID);
    expect(second).toEqual({ status: "already_running" });
    const manual = startExternalSourceSynchronization(
      "overlap",
      dependencies(async () => {
        requests += 1;
        return pending;
      })
    );
    try {
      expect(requests).toBe(1);
    } finally {
      release(feed);
    }
    expect((await first).status).toBe("completed");
    await manual;
    expect(requests).toBe(1);
    expect(scheduler.getJobState(CALENDAR_FEED_POLL_JOB_ID)?.lastError).toBeNull();
  });

  it("starts immediately and re-evaluates at one-minute cadence", async () => {
    insertSource("cadence", { interval: 1 });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let requests = 0;
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const scheduler = initScheduler({
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return callback;
      },
      clearTimeout: () => undefined,
    });
    registerCalendarFeedJob(
      dependencies(async () => {
        requests += 1;
        return feed;
      })
    );
    await scheduler.start();
    const startup = timers.shift();
    expect(startup?.delay).toBe(0);
    startup?.callback();
    await vi.waitFor(() => expect(requests).toBe(1));
    await vi.waitFor(() => expect(timers.length).toBe(1));
    const earlyTick = timers.shift();
    expect(earlyTick?.delay).toBe(MINUTE);
    now += MINUTE - 1;
    earlyTick?.callback();
    await vi.waitFor(() => expect(timers.length).toBe(1));
    expect(requests).toBe(1);
    const dueTick = timers.shift();
    expect(dueTick?.delay).toBe(MINUTE);
    now += 1;
    dueTick?.callback();
    await vi.waitFor(() => expect(requests).toBe(2));
  });

  it("registers under SCHEDULER_DISABLED posture without arming timers", async () => {
    insertSource("disabled-mode");
    const timers: number[] = [];
    const scheduler = initScheduler({
      setTimeout: (_callback, delay) => {
        timers.push(delay);
        return delay;
      },
      clearTimeout: () => undefined,
    });
    let requests = 0;
    registerCalendarFeedJob(
      dependencies(async () => {
        requests += 1;
        return feed;
      })
    );
    expect(timers).toEqual([]);
    expect(requests).toBe(0);
    expect((await scheduler.runJobNow(CALENDAR_FEED_POLL_JOB_ID)).status).toBe("completed");
    expect(requests).toBe(1);
    expect(timers).toEqual([]);
  });

  it("drains an active feed before scheduler shutdown completes", async () => {
    insertSource("drain");
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const scheduler = initScheduler({
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return callback;
      },
      clearTimeout: () => undefined,
    });
    registerCalendarFeedJob(
      dependencies(async () => {
        requests += 1;
        return pending;
      })
    );
    await scheduler.start();
    const startup = timers.shift();
    expect(startup?.delay).toBe(0);
    startup?.callback();
    await vi.waitFor(() => expect(requests).toBe(1));
    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    try {
      expect(stopped).toBe(false);
    } finally {
      release(feed);
    }
    await stop;
    expect(stopped).toBe(true);
    expect(requests).toBe(1);
  });
});
