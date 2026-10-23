import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { __setPrintingPluginActiveForTests } from "../../src/server/modules/printing/index";
import {
  isBriefingScheduledOn,
  readMemberWeekdays,
  setMemberSchedule,
} from "../../src/server/modules/daily-briefing/schedule";
import { todayInHouseholdTz } from "../../src/server/host-api";
import { useIsolatedDb } from "../helpers/db";
import {
  __setQuoteSourceForTests,
  generateAllBriefings,
  generateBriefing,
  isBriefingGenerating,
} from "../../src/server/modules/daily-briefing/index";
import { isMissed, regenerateFailedBriefings } from "../../src/server/modules/daily-briefing/job";
import { findBriefingRow, seedBriefingRow, seedMember } from "../helpers/daily-briefing-seed";

/** Admin parity (docs/features/daily-briefing.md): weekday pause
 * schedule, skip semantics, history, manual print through the queue, 202 while rendering. */
describe("daily-briefing admin parity", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;

  beforeEach(async () => {
    const now = Date.now();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`device-${now}`, hashKey(deviceKey), now);
    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    __setPrintingPluginActiveForTests(undefined);
    await app?.close();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  describe("weekday pause schedule", () => {
    it("defaults to every day and stores a canonical, de-duplicated list", () => {
      seedMember("m-sched");
      expect(readMemberWeekdays("m-sched")).toEqual([
        "mon",
        "tue",
        "wed",
        "thu",
        "fri",
        "sat",
        "sun",
      ]);
      expect(setMemberSchedule("m-sched", ["sun", "mon", "mon"])).toEqual({
        memberId: "m-sched",
        weekdays: ["mon", "sun"],
      });
      expect(readMemberWeekdays("m-sched")).toEqual(["mon", "sun"]);
      // 2026-09-07 is a Monday, 2026-09-08 a Tuesday.
      expect(isBriefingScheduledOn("m-sched", "2026-09-07")).toBe(true);
      expect(isBriefingScheduledOn("m-sched", "2026-09-08")).toBe(false);
    });

    it("allows pausing every day, and creates an opted-out row for a member with no opt-in", () => {
      seedMember("m-new", { optedIn: false });
      expect(setMemberSchedule("m-new", [])).toEqual({ memberId: "m-new", weekdays: [] });
      const row = getDb()
        .prepare("SELECT enabled, weekdays FROM daily_briefing_optin WHERE member_id = ?")
        .get("m-new");
      expect(row).toEqual({ enabled: 0, weekdays: "[]" });
    });

    it("keeps the opt-in flag when the schedule changes and vice versa", () => {
      seedMember("m-keep");
      setMemberSchedule("m-keep", ["fri"]);
      const row = getDb()
        .prepare("SELECT enabled, weekdays FROM daily_briefing_optin WHERE member_id = ?")
        .get("m-keep");
      expect(row).toEqual({ enabled: 1, weekdays: '["fri"]' });
    });

    it("PUT /schedule/:memberId saves and GET /settings returns memberSchedules", async () => {
      seedMember("m-route");
      const put = await app.inject({
        method: "PUT",
        url: "/api/daily-briefing/schedule/m-route",
        cookies: auth(),
        payload: { weekdays: ["wed", "mon"] },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ memberId: "m-route", weekdays: ["mon", "wed"] });

      const get = await app.inject({
        method: "GET",
        url: "/api/daily-briefing/settings",
        cookies: auth(),
      });
      expect(get.json().memberSchedules).toEqual([
        { memberId: "m-route", weekdays: ["mon", "wed"] },
      ]);
    });

    it("PUT /schedule rejects bad weekdays, unknown keys, missing weekdays and inactive members", async () => {
      seedMember("m-bad");
      seedMember("m-archived", { active: false });
      for (const [memberId, payload] of [
        ["m-bad", { weekdays: ["monday"] }],
        ["m-bad", { weekdays: "mon" }],
        ["m-bad", {}],
        ["m-bad", { weekdays: ["mon"], extra: true }],
        ["m-archived", { weekdays: ["mon"] }],
      ] as const) {
        const res = await app.inject({
          method: "PUT",
          url: `/api/daily-briefing/schedule/${memberId}`,
          cookies: auth(),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json()).toMatchObject({ error: "validation_error" });
      }
      expect(readMemberWeekdays("m-bad")).toHaveLength(7);
    });
  });

  describe("paused weekdays are skipped", () => {
    // 2026-09-07 is a Monday.
    const MONDAY = "2026-09-07";

    beforeEach(() => {
      __setPrintingPluginActiveForTests(false); // no render needed for these assertions
    });

    it("generateBriefing writes nothing and the route answers skipped", async () => {
      seedMember("m-paused");
      setMemberSchedule("m-paused", ["tue"]);
      await expect(generateBriefing("m-paused", MONDAY)).rejects.toMatchObject({
        name: "DailyBriefingPausedError",
        memberId: "m-paused",
        date: MONDAY,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/daily-briefing/generate",
        cookies: auth(),
        payload: { memberId: "m-paused", date: MONDAY },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        skipped: true,
        reason: "paused",
        memberId: "m-paused",
        date: MONDAY,
      });
      expect(findBriefingRow("m-paused", MONDAY)).toBeUndefined();
    });

    it("Generate all skips a paused member but generates the others", async () => {
      seedMember("m-a-paused");
      seedMember("m-b-running");
      setMemberSchedule("m-a-paused", ["tue"]);
      const generated = await generateAllBriefings(MONDAY);
      expect(generated.map((briefing) => briefing.memberId)).toEqual(["m-b-running"]);
      expect(findBriefingRow("m-a-paused", MONDAY)).toBeUndefined();
    });

    it("the retry pass skips a member paused after their row was written", async () => {
      seedMember("m-retry");
      seedBriefingRow("m-retry", MONDAY);
      getDb()
        .prepare("UPDATE daily_briefing SET status = 'failed' WHERE member_id = ? AND date = ?")
        .run("m-retry", MONDAY);
      setMemberSchedule("m-retry", ["tue"]);
      await expect(regenerateFailedBriefings(MONDAY)).resolves.toBeUndefined();
      const row = getDb()
        .prepare("SELECT status FROM daily_briefing WHERE member_id = ? AND date = ?")
        .get("m-retry", MONDAY);
      expect(row).toEqual({ status: "failed" });
    });

    it("catch-up does not count a paused member as missed", () => {
      seedMember("m-catchup");
      expect(isMissed(MONDAY)).toBe(true);
      setMemberSchedule("m-catchup", ["tue"]);
      expect(isMissed(MONDAY)).toBe(false);
    });
  });

  function insertRow(
    memberId: string,
    date: string,
    opts: { raster?: boolean; status?: string } = {}
  ) {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO daily_briefing
           (id, member_id, date, status, payload, failed_render_blocks, raster_bits, raster_height,
            png, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '[]', ?, ?, ?, ?, ?)`
      )
      .run(
        `row-${memberId}-${date}`,
        memberId,
        date,
        opts.status ?? "ready",
        opts.raster ? Buffer.from([0]) : null,
        opts.raster ? 1 : null,
        opts.raster ? Buffer.from([0]) : null,
        now,
        now
      );
  }

  describe("history", () => {
    it("returns the household today and the latest 30 rows newest first", async () => {
      seedMember("m-hist");
      for (let day = 1; day <= 31; day += 1) {
        insertRow("m-hist", `2026-08-${String(day).padStart(2, "0")}`, {
          status: day === 31 ? "partial" : "ready",
        });
      }
      const res = await app.inject({
        method: "GET",
        url: "/api/daily-briefing/history/m-hist",
        cookies: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.today).toBe(todayInHouseholdTz(Date.now()));
      expect(body.entries).toHaveLength(30);
      expect(body.entries[0]).toMatchObject({ date: "2026-08-31", status: "partial" });
      expect(body.entries[29]).toMatchObject({ date: "2026-08-02" });
      expect(typeof body.entries[0].updatedAt).toBe("number");
    });

    it("is an empty, write-free read for an unknown member", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/daily-briefing/history/nobody",
        cookies: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries).toEqual([]);
    });
  });

  describe("manual print", () => {
    function jobsFor(memberId: string) {
      return getDb()
        .prepare(
          `SELECT j.state, j.target_date, j.output_ref, r.record_key
           FROM print_jobs j JOIN print_records r ON r.id = j.record_id
           WHERE j.member_id = ? ORDER BY j.created_at ASC`
        )
        .all(memberId) as Array<{
        state: string;
        target_date: string;
        output_ref: string;
        record_key: string;
      }>;
    }

    async function print(memberId: string, date: string) {
      return app.inject({
        method: "POST",
        url: `/api/daily-briefing/${memberId}/${date}/print`,
        cookies: auth(),
      });
    }

    it("queues a past briefing for TODAY under the manual record key", async () => {
      seedMember("m-print");
      insertRow("m-print", "2026-08-01", { raster: true });
      const res = await print("m-print", "2026-08-01");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enqueued: true, jobId: expect.any(String) });
      expect(jobsFor("m-print")).toEqual([
        {
          state: "pending",
          target_date: todayInHouseholdTz(Date.now()),
          output_ref: "daily-briefing:m-print:2026-08-01",
          record_key: "daily-briefing:m-print:manual:2026-08-01",
        },
      ]);
    });

    it("reuses a job still waiting in the queue", async () => {
      seedMember("m-twice");
      insertRow("m-twice", "2026-08-01", { raster: true });
      const first = (await print("m-twice", "2026-08-01")).json();
      const second = (await print("m-twice", "2026-08-01")).json();
      expect(second).toEqual({ jobId: first.jobId, enqueued: false });
      expect(jobsFor("m-twice")).toHaveLength(1);
    });

    it("re-arms and queues again after a completed print", async () => {
      seedMember("m-reprint");
      insertRow("m-reprint", "2026-08-01", { raster: true });
      const first = (await print("m-reprint", "2026-08-01")).json();
      // Simulate the printer finishing the job.
      const db = getDb();
      db.prepare("UPDATE print_jobs SET state = 'printed', printed_at = ? WHERE id = ?").run(
        Date.now(),
        first.jobId
      );
      db.prepare(
        "UPDATE print_records SET printed_job_id = ? WHERE id = (SELECT record_id FROM print_jobs WHERE id = ?)"
      ).run(first.jobId, first.jobId);

      const second = await print("m-reprint", "2026-08-01");
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ enqueued: true });
      expect(second.json().jobId).not.toBe(first.jobId);
    });

    it("maps every refusal to its error code", async () => {
      seedMember("m-errors");
      insertRow("m-errors", "2026-08-02"); // no raster
      expect((await print("m-errors", "2026-08-03")).statusCode).toBe(404);
      const noRaster = await print("m-errors", "2026-08-02");
      expect(noRaster.statusCode).toBe(409);
      expect(noRaster.json()).toMatchObject({ error: "printable_raster_missing" });
      expect((await print("m-errors", "not-a-date")).json()).toMatchObject({
        error: "validation_error",
      });

      seedMember("m-gone", { active: false });
      insertRow("m-gone", "2026-08-02", { raster: true });
      expect((await print("m-gone", "2026-08-02")).statusCode).toBe(400);

      __setPrintingPluginActiveForTests(false);
      const inactive = await print("m-errors", "2026-08-02");
      expect(inactive.statusCode).toBe(409);
      expect(inactive.json()).toMatchObject({ error: "plugin_inactive" });
    });
  });

  describe("still rendering", () => {
    const DATE = "2026-09-07";
    let release: () => void = () => {};

    beforeEach(() => {
      __setPrintingPluginActiveForTests(false);
      const gate = new Promise<null>((resolve) => {
        release = () => resolve(null);
      });
      // quoteOfDay is an external block: generation awaits this port before it can finish.
      __setQuoteSourceForTests(() => gate);
    });

    afterEach(() => {
      release();
      __setQuoteSourceForTests(undefined);
    });

    async function preview(memberId: string) {
      return app.inject({
        method: "GET",
        url: `/api/daily-briefing/${memberId}/${DATE}/preview.png`,
        cookies: auth(),
      });
    }

    it("answers 202 while a first generation is in flight, then the final state", async () => {
      seedMember("m-render");
      const pending = generateBriefing("m-render", DATE);
      expect(isBriefingGenerating("m-render", DATE)).toBe(true);
      const during = await preview("m-render");
      expect(during.statusCode).toBe(202);
      expect(during.json()).toEqual({ status: "rendering" });

      release();
      await pending;
      expect(isBriefingGenerating("m-render", DATE)).toBe(false);
      expect((await preview("m-render")).statusCode).toBe(409); // Printing off: no raster
    });

    it("stays generating until the last overlapping generation finishes", async () => {
      seedMember("m-overlap");
      const first = generateBriefing("m-overlap", DATE);
      const second = generateBriefing("m-overlap", DATE);
      expect(isBriefingGenerating("m-overlap", DATE)).toBe(true);
      release();
      await Promise.all([first, second]);
      expect(isBriefingGenerating("m-overlap", DATE)).toBe(false);
    });

    it("clears the in-flight mark when generation throws", async () => {
      seedMember("m-throws");
      setMemberSchedule("m-throws", ["tue"]); // Monday paused: throws inside the read transaction
      await expect(generateBriefing("m-throws", DATE)).rejects.toThrow();
      expect(isBriefingGenerating("m-throws", DATE)).toBe(false);
    });

    it("keeps serving a stored PNG while a regeneration is in flight", async () => {
      seedMember("m-stored");
      const { PNG } = await import("pngjs");
      const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
      getDb()
        .prepare(
          `INSERT INTO daily_briefing (id, member_id, date, status, payload, png, created_at, updated_at)
           VALUES ('stored', 'm-stored', ?, 'ready', '{}', ?, 1, 1)`
        )
        .run(DATE, Buffer.from(png));
      const pending = generateBriefing("m-stored", DATE);
      expect((await preview("m-stored")).statusCode).toBe(200);
      release();
      await pending;
    });
  });
});
