import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { createServerPluginLifecycle } from "../../src/server/plugins/http";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const SEEDS_DIRECTORY = resolve(process.cwd(), "seeds");

describe("daily content demo seed integration", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("rolls back failed demo activation and repairs the same-date profile", async () => {
    const db = getDb();
    db.exec(`CREATE TRIGGER reject_demo_activation BEFORE UPDATE ON plugin_activation_registry
      WHEN NEW.plugin_id = 'printing' AND NEW.state = 'active'
      BEGIN SELECT RAISE(ABORT, 'synthetic activation failure'); END`);
    const request = {
      mode: "public" as const,
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    };

    await expect(runSeedProfile(request)).rejects.toThrow("Seed module failed: plugins:demo");
    expect(
      db
        .prepare("SELECT count(*) AS count FROM plugin_activation_registry WHERE state = 'active'")
        .get()
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM plugin_lifecycle_operations").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "running",
    });

    db.exec("DROP TRIGGER reject_demo_activation");
    expect((await runSeedProfile(request)).markerAction).toBe("repair");
    expect(
      db
        .prepare("SELECT count(*) AS count FROM plugin_activation_registry WHERE state = 'active'")
        .get()
    ).toEqual({ count: 9 });
    expect(db.prepare("SELECT status FROM seed_profile_state").get()).toEqual({
      status: "complete",
    });
  });

  it("activates every demo plugin and restores deactivated plugins on a public profile rerun", async () => {
    const request = {
      mode: "public" as const,
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    };
    expect(
      getDb()
        .prepare("SELECT count(*) AS count FROM plugin_activation_registry WHERE state = 'active'")
        .get()
    ).toEqual({ count: 0 });

    await runSeedProfile(request);
    const lifecycle = createServerPluginLifecycle();
    const catalog = await lifecycle.listCatalog();
    expect(catalog).toHaveLength(9);
    expect(catalog.every((plugin) => plugin.state === "active" && plugin.operation === null)).toBe(
      true
    );
    await lifecycle.deactivate("meals-recipes");
    expect(lifecycle.isActive("meals-recipes")).toBe(false);

    const report = await runSeedProfile(request);
    expect(report.markerAction).toBe("rerun");
    expect((await lifecycle.listCatalog()).every((plugin) => plugin.state === "active")).toBe(true);
    expect(
      getDb().prepare("SELECT count(*) AS count FROM plugin_lifecycle_operations").get()
    ).toEqual({ count: 0 });
    expect(getDb().prepare("SELECT count(*) AS count FROM recipes").get()).toEqual({ count: 10 });
    expect(
      getDb().prepare("SELECT data FROM settings_objects WHERE object_name = 'weather'").get()
    ).toEqual({
      data: JSON.stringify({ lat: 39.7817, lon: -89.6501, label: "Springfield" }),
    });
  });

  it("exposes messages, briefing settings, opt-ins, and announcements through public HTTP reads", async () => {
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    const deviceKey = "seed-daily-content-device";
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run("seed-daily-content-device", hashKey(deviceKey), NOW_MS);

    const { buildApp } = await import("../../src/server/app");
    const app = await buildApp();
    try {
      const options = { cookies: { mp_device_key: deviceKey } };
      expect(
        await read(
          app,
          "/api/daily-messages/current?memberId=demo%3Amember%3Ahomer&date=2026-09-23",
          options
        )
      ).toEqual({
        id: "demo:daily-message:homer:2026-09-23",
        memberId: "demo:member:homer",
        date: AS_OF_DATE,
        text: "Remember: family game night starts after dinner.",
        createdAt: NOW_MS,
        updatedAt: NOW_MS,
      });
      expect(await read(app, "/api/daily-briefing/settings", options)).toEqual({
        generationTime: "06:30",
        autoPrintTrigger: "morning_complete",
        blockOrder: [
          { type: "today" },
          { type: "message" },
          { type: "meals" },
          { type: "reminders" },
          { type: "dadJoke", params: { difficulty: "easy" } },
        ],
        memberBlockSettings: [
          {
            memberId: "demo:member:bart",
            blockType: "dadJoke",
            enabled: false,
            weekdays: [],
            params: { difficulty: "easy" },
            updatedAt: NOW_MS,
          },
          {
            memberId: "demo:member:homer",
            blockType: "message",
            enabled: true,
            weekdays: null,
            params: null,
            updatedAt: NOW_MS,
          },
          {
            memberId: "demo:member:lisa",
            blockType: "message",
            enabled: true,
            weekdays: null,
            params: null,
            updatedAt: NOW_MS,
          },
        ],
        memberSchedules: [],
      });
      expect(await read(app, "/api/daily-briefing/opt-in", options)).toEqual([
        { memberId: "demo:member:bart", enabled: false },
        { memberId: "demo:member:homer", enabled: true },
        { memberId: "demo:member:lisa", enabled: true },
        { memberId: "demo:member:maggie", enabled: false },
        { memberId: "demo:member:marge", enabled: true },
      ]);
      expect(await read(app, "/api/time-announcements", options)).toEqual([
        {
          id: "demo:time-announcement:morning",
          time: "07:00",
          weekDays: ["mon", "tue", "wed", "thu", "fri"],
          isActive: true,
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
        },
        {
          id: "demo:time-announcement:evening",
          time: "19:00",
          weekDays: ["mon", "tue", "wed", "thu", "fri"],
          isActive: true,
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
        },
      ]);

      const briefing = await app.inject({
        method: "GET",
        url: `/api/daily-briefing/demo%3Amember%3Ahomer/${AS_OF_DATE}`,
        ...options,
      });
      expect(briefing.statusCode).toBe(200);
      expect(briefing.json()).toEqual({ generated: false });
    } finally {
      await app.close();
    }
  });
});

async function read(
  app: FastifyInstance,
  url: string,
  options: { cookies: { mp_device_key: string } }
): Promise<unknown> {
  const response = await app.inject({ method: "GET", url, ...options });
  expect(response.statusCode).toBe(200);
  return response.json();
}
