import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { listOptIns } from "../../src/server/modules/daily-briefing";
import {
  readAllSettings,
  resolveMemberBlockSettings,
} from "../../src/server/modules/daily-briefing/settings";
import { listMessages } from "../../src/server/modules/daily-messages";
import { listTimeAnnouncementRules } from "../../src/server/modules/time-announcements";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const PREVIOUS_DATE = "2026-09-22";
const NEXT_DATE = "2026-09-24";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const RERUN_NOW_MS = Date.parse("2026-09-23T18:00:00.000Z");
const SEEDS_DIRECTORY = resolve(process.cwd(), "seeds");

describe("daily content demo seed boundary", () => {
  useIsolatedDb();

  it("configures the complete briefing catalogue and enables history for opted-in demo members", async () => {
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
    });
    const types = [
      "shotgun",
      "message",
      "streak",
      "today",
      "weather",
      "meals",
      "birthday",
      "reminders",
      "dadJoke",
      "wordOfDay",
      "animalFact",
      "numberFact",
      "onThisDay",
      "quoteOfDay",
      "trivia",
      "riddle",
      "wouldYouRather",
      "wordSearch",
      "drawingPrompt",
      "streakText",
      "weatherText",
    ];
    expect(readAllSettings().blockOrder.map(({ type }) => type)).toEqual(types);
    for (const memberId of ["demo:member:homer", "demo:member:lisa", "demo:member:marge"]) {
      for (const type of types) {
        expect(resolveMemberBlockSettings(memberId, type)).toMatchObject({
          enabled: true,
          weekdays: null,
        });
      }
    }
  });

  it("seeds fictional messages and briefing preferences through authoritative reads", async () => {
    const report = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    const dailyContentIndex = report.moduleIds.indexOf("daily:content:demo");
    const timeAnnouncementsIndex = report.moduleIds.indexOf("time:announcements:demo");
    expect(dailyContentIndex).toBeGreaterThanOrEqual(0);
    expect(timeAnnouncementsIndex).toBeGreaterThan(dailyContentIndex);
    expect(listMessages("demo:member:bart", PREVIOUS_DATE, 3)).toEqual([
      expect.objectContaining({
        id: "demo:daily-message:bart:2026-09-22",
        memberId: "demo:member:bart",
        date: PREVIOUS_DATE,
        text: "Return the library book after school.",
      }),
      expect.objectContaining({
        id: "demo:daily-message:bart:2026-09-23",
        memberId: "demo:member:bart",
        date: AS_OF_DATE,
        text: "Bring your skateboard after school.",
      }),
      expect.objectContaining({
        id: "demo:daily-message:bart:2026-09-24",
        memberId: "demo:member:bart",
        date: NEXT_DATE,
        text: "Science project materials are ready for tomorrow.",
      }),
    ]);
    expect(listMessages("demo:member:homer", AS_OF_DATE, 1)).toEqual([
      expect.objectContaining({
        id: "demo:daily-message:homer:2026-09-23",
        memberId: "demo:member:homer",
        date: AS_OF_DATE,
        text: "Remember: family game night starts after dinner.",
        createdAt: NOW_MS,
        updatedAt: NOW_MS,
      }),
    ]);
    expect(listMessages("demo:member:lisa", AS_OF_DATE, 1)).toEqual([
      expect.objectContaining({
        id: "demo:daily-message:lisa:2026-09-23",
        memberId: "demo:member:lisa",
        date: AS_OF_DATE,
        text: "Practice one new song before screen time.",
        createdAt: NOW_MS,
        updatedAt: NOW_MS,
      }),
    ]);
    expect(listOptIns()).toEqual([
      { memberId: "demo:member:bart", enabled: false },
      { memberId: "demo:member:homer", enabled: true },
      { memberId: "demo:member:lisa", enabled: true },
      { memberId: "demo:member:maggie", enabled: false },
      { memberId: "demo:member:marge", enabled: true },
    ]);
    expect(readAllSettings()).toMatchObject({
      generationTime: "06:30",
      autoPrintTrigger: "morning_complete",
      blockOrder: [
        { type: "shotgun" },
        { type: "message" },
        { type: "streak" },
        { type: "today" },
        { type: "weather" },
        { type: "meals" },
        { type: "birthday" },
        { type: "reminders" },
        { type: "dadJoke", params: { difficulty: "easy" } },
        { type: "wordOfDay" },
        { type: "animalFact" },
        { type: "numberFact" },
        { type: "onThisDay" },
        { type: "quoteOfDay" },
        { type: "trivia" },
        { type: "riddle" },
        { type: "wouldYouRather" },
        { type: "wordSearch" },
        { type: "drawingPrompt" },
        { type: "streakText" },
        { type: "weatherText" },
      ],
      memberBlockSettings: [
        {
          memberId: "demo:member:bart",
          blockType: "dadJoke",
          enabled: false,
          weekdays: [],
          params: { difficulty: "easy" },
        },
        {
          memberId: "demo:member:homer",
          blockType: "message",
          enabled: true,
          weekdays: null,
          params: null,
        },
        {
          memberId: "demo:member:homer",
          blockType: "onThisDay",
          enabled: true,
          weekdays: null,
          params: null,
        },
        {
          memberId: "demo:member:lisa",
          blockType: "message",
          enabled: true,
          weekdays: null,
          params: null,
        },
        {
          memberId: "demo:member:lisa",
          blockType: "onThisDay",
          enabled: true,
          weekdays: null,
          params: null,
        },
        {
          memberId: "demo:member:marge",
          blockType: "onThisDay",
          enabled: true,
          weekdays: null,
          params: null,
        },
      ],
    });
  });

  it("seeds stable ordered announcements and is idempotent when nowMs changes", async () => {
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });
    const firstMessages = listMessages("demo:member:homer", AS_OF_DATE, 1);
    const firstOptIns = listOptIns();
    const firstSettings = readAllSettings();
    const firstAnnouncements = listTimeAnnouncementRules();
    const firstOwnedRows = getDb()
      .prepare(
        `SELECT id, time, week_days, is_active, created_at, updated_at
         FROM time_announcements ORDER BY time ASC, id ASC`
      )
      .all();

    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: RERUN_NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    expect(listMessages("demo:member:homer", AS_OF_DATE, 1)).toEqual(firstMessages);
    expect(listOptIns()).toEqual(firstOptIns);
    expect(readAllSettings()).toEqual(firstSettings);
    expect(listTimeAnnouncementRules()).toEqual(firstAnnouncements);
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM daily_messages WHERE date = ?").get(AS_OF_DATE)
    ).toEqual({ count: 3 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM daily_messages").get()).toEqual({
      count: 5,
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM time_announcements").get()).toEqual({
      count: 2,
    });
    expect(
      getDb()
        .prepare(
          `SELECT id, time, week_days, is_active, created_at, updated_at
           FROM time_announcements ORDER BY time ASC, id ASC`
        )
        .all()
    ).toEqual(firstOwnedRows);
  });

  it("omits generated briefing, cache, dispatch, execution, spoken, and external-observation state", async () => {
    await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory: SEEDS_DIRECTORY,
    });

    for (const table of [
      "daily_briefing",
      "daily_briefing_block_cache",
      "print_jobs",
      "print_records",
      "client_log",
      "network_devices",
    ]) {
      expect(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
