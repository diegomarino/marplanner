import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { getEvents } from "../../src/server/modules/calendar";
import { listMessages } from "../../src/server/modules/daily-messages";
import { getWeekMenu } from "../../src/server/modules/meals";
import { listReminders } from "../../src/server/modules/reminders";
import { getBoard } from "../../src/server/modules/routines";
import { listTimeAnnouncementRules } from "../../src/server/modules/time-announcements";
import { useIsolatedDb } from "../helpers/db";

const SEEDS_DIRECTORY = resolve(process.cwd(), "seeds");
const ALL_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MEMBERS_WITH_DAILY_MESSAGES = ["bart", "homer", "lisa", "marge"].map(
  (slug) => `demo:member:${slug}`
);

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Monday of the household week (the public settings seed sets weekStartDay=1). */
function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset));
}

function demoEventsOn(date: string) {
  return getEvents({ source: "all", range: { from: date, to: date } }).filter(({ id }) =>
    id.startsWith("demo:calendar:event:")
  );
}

function completionDates(): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT date FROM chore_completions WHERE id GLOB 'demo:chore-completion:*' ORDER BY date"
      )
      .all() as { date: string }[]
  ).map(({ date }) => date);
}

async function seedAt(asOfDate: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Calendar expansion is bounded relative to "now"; keep it at the seeded household day.
  vi.setSystemTime(new Date(`${asOfDate}T10:00:00.000Z`));
  await runSeedProfile({
    mode: "public",
    asOfDate,
    nowMs: Date.parse(`${asOfDate}T10:00:00.000Z`),
    disposableTarget: true,
    seedsDirectory: SEEDS_DIRECTORY,
  });
}

describe("demo seed week coverage", () => {
  useIsolatedDb();
  afterEach(() => vi.useRealTimers());

  it.each([
    ["Monday", "2026-09-21"],
    ["Wednesday", "2026-09-23"],
    ["Sunday", "2026-09-27"],
  ])(
    "populates every day of the current week in every module when as-of is a %s",
    async (_label, asOfDate) => {
      await seedAt(asOfDate);
      const weekStart = mondayOf(asOfDate);
      const days = weekDates(weekStart);
      const menu = getWeekMenu(asOfDate);

      for (const date of days) {
        // Calendar: at least two seeded events touch every day of the week.
        expect(demoEventsOn(date).length, `calendar ${date}`).toBeGreaterThanOrEqual(2);
        // Meals: breakfast, lunch and dinner are planned every day.
        for (const slot of ["breakfast", "lunch", "dinner"] as const) {
          expect(menu[date]?.[slot]?.length ?? 0, `meals ${date} ${slot}`).toBeGreaterThan(0);
        }
        // Routines: every child has chores scheduled every day.
        for (const column of getBoard(date)) {
          const chores = column.dayPeriods.flatMap((period) => period.chores);
          expect(chores.length, `routines ${date} ${column.memberId}`).toBeGreaterThan(0);
        }
      }
      expect(getBoard(asOfDate).map((column) => column.memberId)).toEqual(
        expect.arrayContaining(["demo:member:bart", "demo:member:lisa", "demo:member:maggie"])
      );

      // Daily messages: the four talking members have a note every day; Maggie on some days.
      for (const memberId of MEMBERS_WITH_DAILY_MESSAGES) {
        expect(listMessages(memberId, weekStart, 7).map(({ date }) => date)).toEqual(days);
      }
      expect(listMessages("demo:member:maggie", weekStart, 7).length).toBeGreaterThanOrEqual(3);

      // Reminders: scheduled reminders cover every weekday, and every calendar-gated query
      // matches at least one seeded event in this week.
      const reminders = listReminders();
      const scheduledDays = new Set(
        reminders
          .filter(({ kind }) => kind === "scheduled")
          .flatMap((reminder) => [
            ...(reminder.weekdays ?? []),
            ...reminder.assignments.flatMap((assignment) => assignment.weekdays),
          ])
      );
      expect([...scheduledDays].sort()).toEqual([...ALL_WEEKDAYS].sort());
      for (const reminder of reminders.filter(({ kind }) => kind === "calendar_gated")) {
        expect(
          getEvents({
            source: "all",
            query: reminder.query ?? "",
            queryFields: reminder.queryFields ?? ["title"],
            range: { from: addDays(weekStart, -7), to: addDays(weekStart, 13) },
          }).length,
          `calendar-gated reminder ${reminder.id}`
        ).toBeGreaterThan(0);
      }

      // Time announcements: some rule fires on every weekday.
      const announcedDays = new Set(listTimeAnnouncementRules().flatMap((rule) => rule.weekDays));
      expect([...announcedDays].sort()).toEqual([...ALL_WEEKDAYS].sort());

      // Chore history: every day from the previous week's Monday through today, never later.
      const historyDays = Array.from({ length: days.indexOf(asOfDate) + 8 }, (_, offset) =>
        addDays(weekStart, offset - 7)
      );
      expect(completionDates()).toEqual(historyDays);
    }
  );

  it("spreads content over the previous and next weeks", async () => {
    await seedAt("2026-09-23");
    for (const weekStart of ["2026-09-14", "2026-09-28"]) {
      const days = weekDates(weekStart);
      const eventDays = days.filter((date) => demoEventsOn(date).length > 0);
      expect(eventDays, `calendar week of ${weekStart}`).toEqual(days);
      const oneoffMealDays = Object.entries(getWeekMenu(weekStart)).filter(([, slots]) =>
        Object.values(slots).some((items) => items.some((item) => item.source === "oneoff"))
      );
      expect(oneoffMealDays.length, `meals week of ${weekStart}`).toBeGreaterThanOrEqual(4);
      for (const memberId of MEMBERS_WITH_DAILY_MESSAGES) {
        expect(
          listMessages(memberId, weekStart, 7).length,
          `messages ${memberId} week of ${weekStart}`
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("rolls every week-relative row forward with the as-of date without leaving stale rows", async () => {
    await seedAt("2026-09-23");
    const counts = () =>
      Object.fromEntries(
        ["calendar_events", "meal_entries", "daily_messages", "chore_completions"].map((table) => [
          table,
          (
            getDb()
              .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id GLOB 'demo:*'`)
              .get() as { count: number }
          ).count,
        ])
      );
    const before = counts();
    await seedAt("2026-09-30");

    const after = counts();
    expect(after.calendar_events).toBe(before.calendar_events);
    expect(after.meal_entries).toBe(before.meal_entries);
    expect(after.daily_messages).toBe(before.daily_messages);
    expect(completionDates()[0]).toBe("2026-09-21");
    expect(completionDates().at(-1)).toBe("2026-09-30");
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_messages WHERE date < '2026-09-21'")
        .get()
    ).toEqual({ count: 0 });
  });
});
