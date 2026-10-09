import { upsertExternalSource, upsertSeedEvent } from "../src/server/modules/calendar";
import { upsertSeedHighlightRule } from "../src/server/modules/calendar/highlights";
import { wallClockToInstant } from "../src/server/modules/calendar/recurrence";
import type { SeedContext, SeedModule } from "../src/server/db/seeds/types";

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
    for (const { memberIds, ...event } of localEvents(context.asOfDate)) {
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
