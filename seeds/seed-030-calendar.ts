import { upsertExternalSource, upsertSeedEvent } from "../src/server/modules/calendar";
import { upsertSeedHighlightRule } from "../src/server/modules/calendar/highlights";
import { wallClockToInstant } from "../src/server/modules/calendar/recurrence";
import type { SeedContext, SeedModule } from "../src/server/db/seeds/types";
import { readWeekStartDay } from "../src/server/lib/household-date";

const POLL_INTERVAL_MINUTES = 60;
const HOUSEHOLD_TIMEZONE = "Europe/Madrid";
const PUBLIC_ADDRESS = { address: "1.1.1.1", family: 4 } as const;

const SOURCES = [
  {
    id: "demo:calendar:source:spain-holidays",
    name: "Spain public holidays (2026)",
    provider: "worldpublicholiday",
    feedUrl: "https://web-api.worldpublicholiday.com/v1/holidays/calendar.ics?country=ES&year=2026",
  },
  {
    id: "demo:calendar:source:astronomy",
    name: "Astronomy calendar",
    provider: "astronomy",
    feedUrl: "https://cantonbecker.com/astronomy-calendar/astrocal.ics",
  },
  {
    id: "demo:calendar:source:boston-celtics",
    name: "Boston Celtics 2026 season",
    provider: "celtics",
    feedUrl: "https://cdn.celtics.com/schedule/ics/2026_celtics_schedule.ics",
  },
  {
    id: "demo:calendar:source:english-premier-league",
    name: "English Premier League 2026-2027",
    provider: "sports-calendar",
    feedUrl:
      "https://api.sports-calendar.com/ics/soccer/english-premier-league/2026-2027/matches.ics",
  },
] as const;

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localInstant(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return wallClockToInstant(HOUSEHOLD_TIMEZONE, {
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
  }).toISOString();
}

/** The original asOfDate-relative ordering-demo matrix (yesterday / today / tomorrow). */
function localEvents(asOfDate: string) {
  const yesterday = shiftDate(asOfDate, -1);
  const tomorrow = shiftDate(asOfDate, 1);
  const afterWindow = shiftDate(asOfDate, 3);
  return [
    {
      id: "demo:calendar:event:lisas-science-fair",
      title: "Lisa's science fair",
      allDay: true,
      startDate: yesterday,
      endDate: asOfDate,
      memberIds: ["demo:member:lisa"],
    },
    {
      id: "demo:calendar:event:family-bowling",
      title: "Family bowling night",
      allDay: true,
      startDate: asOfDate,
      endDate: tomorrow,
      memberIds: ["demo:member:bart", "demo:member:lisa", "demo:member:maggie"],
    },
    {
      id: "demo:calendar:event:grandparents-visiting",
      title: "Grandparents visiting",
      allDay: true,
      startDate: yesterday,
      endDate: afterWindow,
      memberIds: ["demo:member:bart", "demo:member:lisa"],
    },
    timedEvent("bart-dentist", "Bart dentist appointment", yesterday, "16:00", "17:00", [
      "demo:member:bart",
    ]),
    timedEvent("lisa-music-lesson", "Lisa music lesson", yesterday, "16:00", "18:00", [
      "demo:member:lisa",
    ]),
    timedEvent("family-afternoon", "Family afternoon", asOfDate, "15:00", "18:00", [
      "demo:member:bart",
      "demo:member:lisa",
      "demo:member:maggie",
    ]),
    timedEvent("pharmacy-stop", "Bart pharmacy stop", asOfDate, "16:00", "16:20", [
      "demo:member:bart",
    ]),
    timedEvent("lisa-homework-club", "Lisa homework club", asOfDate, "16:30", "18:00", [
      "demo:member:lisa",
    ]),
    timedEvent("school-pickup", "School pickup", tomorrow, "15:30", "16:00", [
      "demo:member:bart",
      "demo:member:lisa",
    ]),
    timedEvent("maggie-checkup", "Maggie's check-up", tomorrow, "15:45", "16:00", [
      "demo:member:maggie",
    ]),
  ];
}

const HOMER = "demo:member:homer";
const MARGE = "demo:member:marge";
const BART = "demo:member:bart";
const LISA = "demo:member:lisa";
const MAGGIE = "demo:member:maggie";
const FAMILY = [HOMER, MARGE, BART, LISA, MAGGIE];
const KIDS = [BART, LISA];

/** First day of the household week containing `asOfDate` (weekStartDay: 0=Sunday, 1=Monday). */
export function weekStartOf(asOfDate: string, weekStartDay: number): string {
  const weekday = new Date(`${asOfDate}T00:00:00.000Z`).getUTCDay();
  return shiftDate(asOfDate, -((weekday - weekStartDay + 7) % 7));
}

/**
 * Week-relative demo events. Offsets count days from the first day of the current household
 * week, so the previous (-7..-1), current (0..6) and next (7..13) weeks are always populated.
 */
function weekEvents(weekStart: string) {
  const day = (offset: number) => shiftDate(weekStart, offset);
  const allDay = (slug: string, title: string, offset: number, memberIds: string[]) => ({
    id: `demo:calendar:event:${slug}`,
    title,
    allDay: true,
    startDate: day(offset),
    endDate: day(offset + 1),
    memberIds,
  });
  const timed = (
    slug: string,
    title: string,
    offset: number,
    start: string,
    end: string,
    memberIds: string[]
  ) => timedEvent(slug, title, day(offset), start, end, memberIds);
  return [
    // Previous week
    timed(
      "parent-teacher-night",
      "Parent-teacher night at Springfield Elementary",
      -6,
      "19:00",
      "20:30",
      [HOMER, MARGE]
    ),
    timed("bart-chalkboard-lines", "Bart's chalkboard lines", -4, "15:30", "16:30", [BART]),
    allDay("isotopes-road-trip", "Isotopes road trip", -2, [HOMER, BART]),
    timed("lunch-with-grampa", "Lunch with Grampa", -1, "13:00", "15:00", FAMILY),
    // Current week
    timed("junior-campers", "Lisa's Junior Campers meeting", 0, "18:00", "19:00", [LISA]),
    timed("bart-detention", "Bart's detention with Mrs. Krabappel", 1, "15:30", "16:30", [BART]),
    timed("marge-book-club", "Marge's book club", 2, "19:30", "21:00", [MARGE]),
    timed("krusty-show-taping", "Krusty the Clown Show taping", 3, "17:00", "18:30", KIDS),
    timed("moes-trivia-night", "Trivia night at Moe's", 4, "20:00", "22:00", [HOMER]),
    allDay("chili-cookoff", "Springfield chili cook-off", 5, FAMILY),
    timed("flanders-playdate", "Playdate at the Flanders'", 5, "10:00", "11:30", [MARGE, MAGGIE]),
    timed("flanders-barbecue", "Barbecue at Ned Flanders'", 6, "13:00", "16:00", FAMILY),
    // Next week
    allDay("school-picture-day", "Springfield Elementary picture day", 7, KIDS),
    timed("plant-safety-inspection", "Power plant safety inspection", 8, "10:00", "11:30", [HOMER]),
    timed("lisa-sax-recital", "Lisa's saxophone recital", 9, "19:00", "20:30", FAMILY),
    allDay("museum-field-trip", "Field trip to the Springfield Museum", 11, KIDS),
    timed("anniversary-dinner", "Homer and Marge's anniversary dinner", 12, "20:00", "22:30", [
      HOMER,
      MARGE,
    ]),
    timed("grampa-birthday-lunch", "Grampa's birthday lunch", 13, "13:00", "15:30", FAMILY),
  ];
}

/** Weekly recurring events anchored in the previous week, so they repeat across every week. */
function recurringEvents(weekStart: string) {
  const weekly = (
    slug: string,
    title: string,
    offset: number,
    start: string,
    end: string,
    byDay: string,
    memberIds: string[]
  ) => ({
    ...timedEvent(slug, title, shiftDate(weekStart, offset - 7), start, end, memberIds),
    rrule: `FREQ=WEEKLY;BYDAY=${byDay}`,
  });
  return [
    weekly("power-plant-shift", "Power plant shift", 0, "09:00", "17:00", "MO,TU,WE,TH,FR", [
      HOMER,
    ]),
    weekly("marge-painting-class", "Marge's painting class", 0, "10:00", "11:30", "MO", [MARGE]),
    weekly("saxophone-practice", "Saxophone practice", 1, "18:00", "18:30", "TU,TH", [LISA]),
    weekly("bowling-league", "Bowling league at Barney's Bowlarama", 2, "20:00", "22:00", "WE", [
      HOMER,
    ]),
    weekly("maggie-baby-gym", "Maggie's baby gym", 4, "10:30", "11:15", "FR", [MARGE, MAGGIE]),
    weekly("church", "Church with Reverend Lovejoy", 6, "10:00", "11:00", "SU", FAMILY),
  ];
}

function timedEvent(
  slug: string,
  title: string,
  date: string,
  start: string,
  end: string,
  memberIds: string[]
) {
  return {
    id: `demo:calendar:event:${slug}`,
    title,
    allDay: false,
    startUtc: localInstant(date, start),
    endUtc: localInstant(date, end),
    tzid: HOUSEHOLD_TIMEZONE,
    memberIds,
  };
}

const SAFE_SOURCE_HOSTS = new Set(SOURCES.map((source) => new URL(source.feedUrl).hostname));

const seedCalendar: SeedModule = {
  id: "calendar:demo",

  async run(context) {
    upsertSeedHighlightRule({
      id: "demo:calendar:highlight:music",
      emoji: "🎵",
      keywords: ["music lesson"],
      nowMs: context.nowMs,
    });
    upsertSeedHighlightRule({
      id: "demo:calendar:highlight:pharmacy",
      emoji: "💊",
      keywords: ["pharmacy"],
      nowMs: context.nowMs,
    });
    for (const source of SOURCES) {
      if (isCanonicalSource(context, source)) continue;
      await upsertExternalSource(
        { ...source, enabled: true, pollIntervalMin: POLL_INTERVAL_MINUTES },
        { lookup: resolveSeedSourceHost }
      );
    }

    const upsertAssignment = context.db.prepare(
      `INSERT INTO calendar_assignments (id, event_id, member_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO NOTHING`
    );
    const weekStart = weekStartOf(context.asOfDate, readWeekStartDay());
    const events = [
      ...localEvents(context.asOfDate),
      ...weekEvents(weekStart),
      ...recurringEvents(weekStart),
    ];
    for (const { memberIds, ...event } of events) {
      upsertSeedEvent({ ...event, nowMs: context.nowMs });
      for (const memberId of memberIds) {
        upsertAssignment.run(
          `demo:calendar:assignment:${event.id.split(":").at(-1)}:${memberId.split(":").at(-1)}`,
          event.id,
          memberId,
          context.nowMs
        );
      }
    }
  },
};

function isCanonicalSource(context: SeedContext, source: (typeof SOURCES)[number]): boolean {
  const row = context.db
    .prepare(
      `SELECT name, provider, feed_url, enabled, poll_interval_min
       FROM calendar_external_sources WHERE id = ?`
    )
    .get(source.id) as
    | {
        name: string;
        provider: string;
        feed_url: string;
        enabled: number;
        poll_interval_min: number;
      }
    | undefined;
  return (
    row?.name === source.name &&
    row.provider === "ics_generic" &&
    row.feed_url === source.feedUrl &&
    row.enabled === 1 &&
    row.poll_interval_min === POLL_INTERVAL_MINUTES
  );
}

async function resolveSeedSourceHost(hostname: string) {
  if (!SAFE_SOURCE_HOSTS.has(hostname)) {
    throw new Error("Unexpected Calendar demo source hostname");
  }
  return [PUBLIC_ADDRESS];
}

export default seedCalendar;
