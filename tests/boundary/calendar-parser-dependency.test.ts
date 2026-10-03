import { readFileSync } from "node:fs";
import ical, { type VEvent } from "node-ical";
import { describe, expect, it } from "vitest";

type ProbeEvent = VEvent & {
  rdate?: { params?: Record<string, string>; val?: string };
};

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/calendar/${name}`, import.meta.url), "utf8");

const isEvent = (component: unknown): component is ProbeEvent =>
  typeof component === "object" &&
  component !== null &&
  "type" in component &&
  component.type === "VEVENT";

const parseCalendar = (name: string): ReturnType<typeof ical.sync.parseICS> => {
  const source = fixture(name);
  if (!source.startsWith("BEGIN:VCALENDAR") || !source.trimEnd().endsWith("END:VCALENDAR")) {
    throw new Error("Invalid VCALENDAR envelope");
  }

  return ical.sync.parseICS(source);
};

const eventsFrom = (name: string): ProbeEvent[] =>
  Object.values(parseCalendar(name)).filter(isEvent);

const dateOnlyValue = (date: Date): string =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => part.toString().padStart(index === 0 ? 4 : 2, "0"))
    .join("-");

describe("node-ical 0.27.2 dependency boundary", () => {
  it("expands RRULE across DST and exposes RDATE, EXDATE, moved RECURRENCE-ID, and cancellation", () => {
    const parsed = parseCalendar("recurrence-matrix.ics");
    const components = Object.values(parsed);
    const timezone = components.find(
      (component) =>
        typeof component === "object" &&
        component !== null &&
        "type" in component &&
        component.type === "VTIMEZONE"
    );
    const master = components.find(
      (component): component is ProbeEvent => isEvent(component) && component.rrule !== undefined
    );

    expect(timezone).toMatchObject({ type: "VTIMEZONE", tzid: "Europe/Madrid" });
    expect(master).toBeDefined();
 expect(master?.rdate).toEqual({ params: { TZID: "Europe/Madrid" }, val: "20260427T090000" });

    const expanded = ical.expandRecurringEvent(master!, {
      from: new Date("2026-03-20T00:00:00.000Z"),
      to: new Date("2026-05-01T00:00:00.000Z"),
    });
    const active = expanded.filter((occurrence) => occurrence.event.status !== "CANCELLED");

    expect(
      active.map((occurrence) => ({
        start: occurrence.start.toISOString(),
        summary: occurrence.summary,
        override: occurrence.isOverride,
      }))
    ).toEqual([
      { start: "2026-03-23T08:00:00.000Z", summary: "Weekly probe", override: false },
      { start: "2026-03-30T09:30:00.000Z", summary: "Moved probe", override: true },
    ]);
    expect(expanded.map((occurrence) => occurrence.start.toISOString())).not.toContain(
      "2026-04-06T07:00:00.000Z"
    );
    expect(active.map((occurrence) => occurrence.start.toISOString())).not.toContain(
      "2026-04-13T07:00:00.000Z"
    );
    expect(
      expanded
        .filter((occurrence) => occurrence.event.status === "CANCELLED")
        .map((occurrence) => ({
          recurrenceId: occurrence.event.recurrenceid?.toISOString(),
          start: occurrence.start.toISOString(),
        }))
    ).toEqual([{ recurrenceId: "2026-04-13T07:00:00.000Z", start: "2026-04-13T07:00:00.000Z" }]);
  });

  it("preserves a date-only all-day range independently of the host timezone", () => {
    const [event] = eventsFrom("all-day-range.ics");

    expect(event).toBeDefined();
    expect(event.datetype).toBe("date");
    expect(event.start.dateOnly).toBe(true);
    expect(event.end).toBeInstanceOf(Date);
    if (!(event.end instanceof Date)) {
      throw new Error("Expected the all-day fixture to retain DTEND");
    }
    expect(event.end.dateOnly).toBe(true);
    expect(dateOnlyValue(event.start)).toBe("2026-03-28");
    expect(dateOnlyValue(event.end)).toBe("2026-03-31");
  });

  it("keeps valid VEVENTs available when an individual VEVENT is semantically malformed", () => {
    const events = eventsFrom("malformed-individual.ics");
    const validEvents = events.filter(
      (event) => event.start instanceof Date && !Number.isNaN(event.start.valueOf())
    );
    const invalidEvents = events.filter(
      (event) => !(event.start instanceof Date) || Number.isNaN(event.start.valueOf())
    );

    expect(validEvents.map((event) => event.uid)).toEqual(["valid-neighbour@example.test"]);
    expect(invalidEvents.map((event) => event.uid)).toEqual(["malformed-neighbour@example.test"]);
  });

  it("fails an invalid whole-calendar envelope", () => {
    expect(() => parseCalendar("invalid-whole-calendar.ics")).toThrow("Invalid VCALENDAR envelope");
  });
});
