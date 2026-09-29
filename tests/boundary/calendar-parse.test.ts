import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIcs } from "../../src/server/modules/calendar/parse-ics";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/calendar/${name}`, import.meta.url), "utf8");

const referenceDate = new Date("2026-03-25T12:00:00.000Z");

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
});
