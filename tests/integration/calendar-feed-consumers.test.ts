import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getEvents } from "../../src/server/modules/calendar/index";
import { startExternalSourceSynchronization } from "../../src/server/modules/calendar/sync-coordinator";
import { generateBriefing } from "../../src/server/modules/daily-briefing/index";
import { createReminder, getReminders } from "../../src/server/modules/reminders/index";
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";

const date = "2026-10-15";
const now = Date.parse("2026-10-10T12:00:00Z");

function event(uid: string, title: string, start: string, extra = ""): string {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261010T120000Z",
    `DTSTART${start}`,
    `SUMMARY:${title}`,
    extra,
    "END:VEVENT",
  ]
    .filter(Boolean)
    .join("\r\n");
}

const activeFeed = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  event("assigned-day", "Alex vetcheck day", ";VALUE=DATE:20261015"),
 event("assigned-timed", "Alex vetcheck timed", ":20261015T080000Z", "DTEND:20261015T090000Z"),
  event("unassigned", "vetcheck unassigned", ";VALUE=DATE:20261015"),
  event("nonmatching", "Alex library", ";VALUE=DATE:20261015"),
 event("next-household-day", "Alex vetcheck late", ":20261015T230000Z", "DTEND:20261016T000000Z"),
  event("cancelled", "Alex vetcheck cancelled", ";VALUE=DATE:20261015", "STATUS:CANCELLED"),
  "END:VCALENDAR",
].join("\r\n");

describe("synchronized Calendar consumers", () => {
  useIsolatedDb();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("uses the public merged Calendar read for reminder gates and daily briefing on the household date", async () => {
    seedMember("alex");
    getDb().prepare("UPDATE members SET display_name = 'Alex' WHERE id = 'alex'").run();
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
      )
      .run(JSON.stringify({ timezone: "Europe/Madrid", language: "en" }), now);
    for (const id of ["active", "disabled"]) {
      getDb()
        .prepare(
          `INSERT INTO calendar_external_sources
        (id, name, provider, feed_url, created_at, updated_at)
        VALUES (?, ?, 'ics_generic', ?, ?, ?)`
        )
        .run(id, id, `https://calendar.example.test/${id}`, now, now);
    }
    const dependencies = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      transport: async () => activeFeed,
    };
    await startExternalSourceSynchronization("active", dependencies);
    await startExternalSourceSynchronization("disabled", {
      ...dependencies,
      transport: async () => activeFeed.replaceAll("vetcheck", "disabledfeed"),
    });
    getDb().prepare("UPDATE calendar_external_sources SET enabled = 0 WHERE id = 'disabled'").run();

    const visible = getEvents({
      source: "external",
      assignedTo: "alex",
      range: { from: date, to: date },
    });
    expect(visible.map((item) => item.title).sort()).toEqual([
      "Alex library",
      "Alex vetcheck day",
      "Alex vetcheck timed",
    ]);

    const reminder = createReminder({
      kind: "calendar_gated",
      targetingMode: "apply_to_all",
      text: "Prepare vetcheck",
      query: "vetcheck",
    });
    expect(getReminders("alex", date).filter((item) => item.id === reminder.id)).toEqual([
      { id: reminder.id, text: "Prepare vetcheck" },
    ]);
    expect(getReminders("alex", "2026-10-14").some((item) => item.id === reminder.id)).toBe(false);
    const absent = createReminder({
      kind: "calendar_gated",
      targetingMode: "apply_to_all",
      text: "Absent match",
      query: "absent-event",
    });
    expect(getReminders("alex", date).some((item) => item.id === absent.id)).toBe(false);

    const briefing = await generateBriefing("alex", date);
    const today = briefing.payload.blocks.find((block) => block.type === "today");
    expect(today?.status).toBe("ok");
    const bullets = (today?.data as { bullets: string[] }).bullets;
    expect(bullets.filter((bullet) => bullet.includes("Alex vetcheck day"))).toEqual([
      "Alex vetcheck day",
    ]);
    expect(bullets.filter((bullet) => bullet.includes("Alex vetcheck timed"))).toHaveLength(1);
    expect(bullets).toContain("Alex library");
    expect(bullets.join(" ")).not.toContain("unassigned");
    expect(bullets.join(" ")).not.toContain("cancelled");
    expect(bullets.join(" ")).not.toContain("late");
    expect(bullets.join(" ")).not.toContain("disabledfeed");
  });

  it("keeps Reminders and Daily Briefing out of Calendar external tables", () => {
    const consumers = ["src/server/modules/reminders", "src/server/modules/daily-briefing"];
    for (const file of consumers) {
      const directory = new URL(`../../${file}/`, import.meta.url);
      const inspect = (url: URL): void => {
        for (const entry of readdirSync(url, { withFileTypes: true })) {
          const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), url);
          if (entry.isDirectory()) inspect(child);
          else if (entry.name.endsWith(".ts")) {
            const source = readFileSync(child, "utf8");
            expect(source, child.pathname).not.toMatch(
              /calendar_external_(?:sources|event_meta)|calendarExternal(?:Sources|EventMeta)/
            );
          }
        }
      };
      inspect(directory);
    }
  });
});
