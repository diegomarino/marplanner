import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ICS_FEED_LIMITS,
  IcsFeedLimitError,
  parseIcs,
} from "../../src/server/modules/calendar/parse-ics";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/calendar/${name}`, import.meta.url), "utf8");

const referenceDate = new Date("2026-03-25T12:00:00.000Z");

const calendar = (...events: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (uid: string, ...lines: string[]): string =>
  [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260101T000000Z",
    `SUMMARY:${uid}`,
    "DTSTART:20260101T090000Z",
    "DTEND:20260101T093000Z",
    ...lines,
    "END:VEVENT",
  ].join("\r\n");
const exdateList = (count: number): string =>
  Array.from({ length: count }, (_, day) =>
    new Date(Date.UTC(2020, 0, 1, 9) + day * 86_400_000).toISOString().replace(/[-:]|\.\d{3}/g, "")
  ).join(",");

describe("Calendar ICS parser adapter", () => {
  it("normalizes RRULE, RDATE, EXDATE, overrides, cancellations, and DST instants", () => {
    const parsed = parseIcs(fixture("recurrence-matrix.ics"), { now: referenceDate });

    expect(
      parsed.occurrences.map((occurrence) => ({
        recurrenceId: occurrence.recurrenceId,
        title: occurrence.title,
        startUtc: occurrence.startUtc,
        endUtc: occurrence.endUtc,
        tzid: occurrence.tzid,
        status: occurrence.status,
      }))
    ).toEqual([
      {
        recurrenceId: "2026-03-23T08:00:00.000Z",
        title: "Weekly probe",
        startUtc: "2026-03-23T08:00:00.000Z",
        endUtc: "2026-03-23T09:00:00.000Z",
        tzid: "Europe/Madrid",
        status: "active",
      },
      {
        recurrenceId: "2026-03-30T07:00:00.000Z",
        title: "Moved probe",
        startUtc: "2026-03-30T09:30:00.000Z",
        endUtc: "2026-03-30T10:30:00.000Z",
        tzid: "Europe/Madrid",
        status: "active",
      },
      {
        recurrenceId: "2026-04-13T07:00:00.000Z",
        title: "Cancelled probe",
        startUtc: "2026-04-13T07:00:00.000Z",
        endUtc: "2026-04-13T08:00:00.000Z",
        tzid: "Europe/Madrid",
        status: "cancelled",
      },
      {
        recurrenceId: "2026-04-27T07:00:00.000Z",
        title: "Weekly probe",
        startUtc: "2026-04-27T07:00:00.000Z",
        endUtc: "2026-04-27T08:00:00.000Z",
        tzid: "Europe/Madrid",
        status: "active",
      },
    ]);
    expect(parsed.skippedCount).toBe(0);
  });

  it("keeps all-day values date-only and applies RFC default end semantics", () => {
    const parsed = parseIcs(fixture("adapter-defaults.ics"), { now: referenceDate });

    expect(parsed.occurrences).toMatchObject([
      {
        externalUid: "all-day-default@example.test",
        recurrenceId: "",
        allDay: true,
        startDate: "2026-03-28",
        endDate: "2026-03-29",
        status: "active",
      },
      {
        externalUid: "timed-default@example.test",
        recurrenceId: "",
        allDay: false,
        startUtc: "2026-03-28T10:00:00.000Z",
        endUtc: "2026-03-28T10:00:00.000Z",
        tzid: "UTC",
        status: "active",
      },
    ]);
    expect(parsed.occurrences[0]).not.toHaveProperty("startUtc");
    expect(parsed.occurrences[1]).not.toHaveProperty("startDate");
    expect(parsed.skippedCount).toBe(1);
  });

  it("retains valid events while counting malformed and duplicate identities", () => {
    const parsed = parseIcs(fixture("adapter-isolation.ics"), { now: referenceDate });

    expect(
      parsed.occurrences.map(({ externalUid, recurrenceId, title }) => ({
        externalUid,
        recurrenceId,
        title,
      }))
    ).toEqual([
      {
        externalUid: "duplicate-rdate@example.test",
        recurrenceId: "2026-05-01T08:00:00.000Z",
        title: "Duplicate RDATE probe",
      },
      {
        externalUid: "valid-neighbour@example.test",
        recurrenceId: "",
        title: "Valid neighbour",
      },
    ]);
    expect(parsed.skippedCount).toBe(2);
  });

  it("bounds expansion to the fixed -30 day and +365 day window", () => {
    const parsed = parseIcs(fixture("adapter-window.ics"), {
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(parsed.occurrences.map((occurrence) => occurrence.externalUid)).toEqual([
      "window-lower@example.test",
      "window-upper@example.test",
    ]);
  });

  it("produces stable hashes and one identity per occurrence", () => {
    const first = parseIcs(fixture("recurrence-matrix.ics"), { now: referenceDate });
    const second = parseIcs(fixture("recurrence-matrix.ics"), { now: referenceDate });

    expect(second).toEqual(first);
    expect(
      new Set(first.occurrences.map((event) => `${event.externalUid}\0${event.recurrenceId}`)).size
    ).toBe(first.occurrences.length);
    expect(first.occurrences.every((event) => /^[0-9a-f]{64}$/.test(event.rawHash))).toBe(true);
  });

  it("fails an invalid whole calendar without returning partial output", () => {
    expect(() => parseIcs(fixture("invalid-whole-calendar.ics"), { now: referenceDate })).toThrow(
      "invalid_calendar"
    );
  });

  it("bounds hostile recurrence and still expands ordinary series inside the window", () => {
    const source = calendar(
      vevent("ordinary-weekly", "RRULE:FREQ=WEEKLY;BYDAY=WE"),
      vevent("sub-daily", "RRULE:FREQ=HOURLY"),
      vevent("lower-case-sub-daily", "rrule:FREQ=HOURLY;INTERVAL=1"),
      vevent("time-of-day-product", "RRULE:FREQ=DAILY;BYHOUR=1,2,3,4,5;BYMINUTE=1,2,3,4,5,6"),
      vevent("date-list", `EXDATE:${exdateList(ICS_FEED_LIMITS.maxExdatesPerEvent + 1)}`),
      vevent("dense-daily", "RRULE:FREQ=DAILY;BYHOUR=8,9,10,11,12,13;COUNT=1000000000"),
      ...Array.from({ length: 20 }, (_, index) => vevent(`daily-${index}`, "RRULE:FREQ=DAILY"))
    );

    const started = performance.now();
    const parsed = parseIcs(source, { now: referenceDate });
    expect(performance.now() - started).toBeLessThan(5_000);

    const byUid = (uid: string) => parsed.occurrences.filter((item) => item.externalUid === uid);
    // Wednesdays between 2026-02-23 and 2027-03-25 (the -30d/+365d window).
    expect(byUid("ordinary-weekly")).toHaveLength(57);
    expect(byUid("ordinary-weekly")[0]).toMatchObject({
      startUtc: "2026-02-25T09:00:00.000Z",
      endUtc: "2026-02-25T09:30:00.000Z",
    });
    for (const uid of ["sub-daily", "lower-case-sub-daily", "time-of-day-product", "date-list"]) {
      expect(byUid(uid)).toEqual([]);
    }
    expect(byUid("dense-daily")).toHaveLength(ICS_FEED_LIMITS.maxOccurrencesPerEvent);
    expect(byUid("dense-daily")[0].startUtc).toBe("2026-02-23T12:00:00.000Z");
    expect(byUid("daily-19")).toHaveLength(395);
    expect(parsed.limits).toEqual({
      unsupported_rrule: 3,
      too_many_dates: 1,
      event_occurrences_truncated: 1,
    });
    expect(parsed.retainedUids).toEqual([
      "date-list",
      "dense-daily",
      "lower-case-sub-daily",
      "sub-daily",
      "time-of-day-product",
    ]);
  });

  it("screens recurrence wherever node-ical would read it: stray, nested, or unterminated", () => {
    const hourly = "RRULE:FREQ=HOURLY";
    const nested = [
      "BEGIN:VEVENT",
      "UID:outer",
      "DTSTAMP:20260101T000000Z",
      "SUMMARY:outer",
      "DTSTART:20260401T090000Z",
      vevent("inner"),
      hourly,
      "END:VEVENT",
    ].join("\r\n");
    const now = new Date("2026-01-02T00:00:00Z");
    const parsed = parseIcs(
      calendar(hourly, vevent("neighbour", "RRULE:FREQ=WEEKLY;COUNT=2"), nested),
      { now }
    );

    expect(parsed.occurrences.map(({ externalUid }) => externalUid)).toEqual([
      "neighbour",
      "neighbour",
    ]);
    expect(parsed.limits).toEqual({ unsupported_rrule: 2 });
    expect(parsed.retainedUids).toEqual(["inner", "outer"]);

    // node-ical yields nothing for an unterminated VEVENT; its rule is still never built.
    const unterminated = ["BEGIN:VEVENT", "UID:open", "SUMMARY:open", hourly].join("\r\n");
    expect(parseIcs(calendar(unterminated), { now })).toEqual({
      occurrences: [],
      skippedCount: 2,
      retainedUids: ["open"],
      limits: { unsupported_rrule: 1 },
    });
  });

  it("fails a feed that exceeds its occurrence cap or time budget instead of returning part of it", () => {
    const weekly = ["first", "second", "third"].map((uid) => vevent(uid, "RRULE:FREQ=WEEKLY"));
    let clock = 0;
    const overBudget = () =>
      parseIcs(calendar(...weekly), {
        now: referenceDate,
        clock: () => (clock += ICS_FEED_LIMITS.parseBudgetMs * 0.75),
      });
    expect(overBudget).toThrow(IcsFeedLimitError);
    clock = 0;
    expect(overBudget).toThrow("time_budget_exhausted");

    const dailySeries = Math.ceil(ICS_FEED_LIMITS.maxOccurrencesPerFeed / 396) + 1;
    const overCap = calendar(
      ...Array.from({ length: dailySeries }, (_, index) =>
        vevent(`daily-${index}`, "RRULE:FREQ=DAILY")
      )
    );
    let failure: unknown;
    try {
      parseIcs(overCap, { now: referenceDate });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "feed_occurrences_truncated",
      limits: { feed_occurrences_truncated: 1 },
    });
  });

  it("drops an over-long property line in linear time, clips stored text, and refuses an oversized feed", () => {
    const longLine = `DESCRIPTION:${"x".repeat(ICS_FEED_LIMITS.maxLineChars)}`;
    const folded = longLine.match(/.{1,74}/g)!.join("\r\n ");
    const started = performance.now();
    const parsed = parseIcs(calendar(vevent("kept", folded)), {
      now: new Date("2026-01-02T00:00:00Z"),
    });
    expect(performance.now() - started).toBeLessThan(200);
    expect(parsed.occurrences).toMatchObject([{ externalUid: "kept", title: "kept" }]);
    expect(parsed.occurrences[0]).not.toHaveProperty("description");
    expect(parsed.limits).toEqual({ line_too_long: 1 });

    const wordy = parseIcs(
      calendar(
        vevent(
          "wordy",
          `DESCRIPTION:${"d".repeat(ICS_FEED_LIMITS.maxDescriptionChars + 10)}`,
          `LOCATION:${"😀".repeat(ICS_FEED_LIMITS.maxLocationChars + 10)}`
        ).replace("SUMMARY:wordy", `SUMMARY:${"t".repeat(ICS_FEED_LIMITS.maxTitleChars + 10)}`)
      ),
      { now: new Date("2026-01-02T00:00:00Z") }
    ).occurrences[0];
    expect(wordy.title).toHaveLength(ICS_FEED_LIMITS.maxTitleChars);
    expect(wordy.description).toHaveLength(ICS_FEED_LIMITS.maxDescriptionChars);
    expect(Array.from(wordy.location!)).toHaveLength(ICS_FEED_LIMITS.maxLocationChars);
    expect(wordy.location!.endsWith("😀")).toBe(true);

    const oversized = calendar(
      vevent("big", `DESCRIPTION:${"é".repeat(ICS_FEED_LIMITS.maxFeedBytes / 2)}`)
    );
    expect(() => parseIcs(oversized, { now: referenceDate })).toThrow("too_large");
  });
});
