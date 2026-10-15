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
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";

/** Admin parity (docs/superpowers/specs/2026-10-15-admin-briefing-design.md): weekday pause
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
        "mon", "tue", "wed", "thu", "fri", "sat", "sun",
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
});
