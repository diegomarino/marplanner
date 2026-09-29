import type { CalendarEvent } from "@schedule-x/calendar";
import { Temporal } from "temporal-polyfill";

import type { FeedItem } from "../../shared";

export type CalendarMode = "month" | "week";
export type WeekStartDay = 0 | 1;

type InstantInput = string | number | Date;

function toInstant(value: InstantInput): Temporal.Instant {
  if (typeof value === "string") return Temporal.Instant.from(value);
  return Temporal.Instant.fromEpochMilliseconds(
    typeof value === "number" ? value : value.getTime()
  );
}

function temporalWeekStartDay(weekStartDay: WeekStartDay): number {
  return weekStartDay === 1 ? 1 : 7;
}

export function getHouseholdCalendarDate(instant: InstantInput, timezone: string): string {
  return toInstant(instant).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

export function getHouseholdMinuteOfDay(instant: InstantInput, timezone: string): number {
  const zoned = toInstant(instant).toZonedDateTimeISO(timezone);
  return zoned.hour * 60 + zoned.minute;
}

export function formatInstantAsDateTimeLocal(instant: string, timezone: string): string {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  return `${zoned.toPlainDate()}T${String(zoned.hour).padStart(2, "0")}:${String(
    zoned.minute
  ).padStart(2, "0")}`;
}

export function dateTimeLocalToUtcInstant(value: string, timezone: string): string {
  const instant = Temporal.PlainDateTime.from(value).toZonedDateTime(timezone).toInstant();
  return new Date(instant.epochMilliseconds).toISOString();
}

export function addCalendarDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function shiftCalendarPeriod(date: string, mode: CalendarMode, direction: -1 | 1): string {
  const selected = Temporal.PlainDate.from(date);
  return (
    mode === "month"
      ? selected.add({ months: direction }).with({ day: 1 })
      : selected.add({ days: direction * 7 })
  ).toString();
}

export function getCalendarRowCount(
  year: number,
  month: number,
  weekStartDay: WeekStartDay = 0
): number {
  const firstDay = Temporal.PlainDate.from({ year, month: month + 1, day: 1 });
  const offset = (firstDay.dayOfWeek - temporalWeekStartDay(weekStartDay) + 7) % 7;
  return Math.ceil((offset + firstDay.daysInMonth) / 7);
}

export function buildCalendarDays(
  year: number,
  month: number,
  weekStartDay: WeekStartDay = 0
): string[] {
  const firstDay = Temporal.PlainDate.from({ year, month: month + 1, day: 1 });
  const offset = (firstDay.dayOfWeek - temporalWeekStartDay(weekStartDay) + 7) % 7;
  const start = firstDay.subtract({ days: offset });
  const count = getCalendarRowCount(year, month, weekStartDay) * 7;
  return Array.from({ length: count }, (_, index) => start.add({ days: index }).toString());
}

export function getWeekStartDate(date: string, weekStartDay: WeekStartDay = 0): string {
  const selected = Temporal.PlainDate.from(date);
  const offset = (selected.dayOfWeek - temporalWeekStartDay(weekStartDay) + 7) % 7;
  return selected.subtract({ days: offset }).toString();
}

export function buildWeekDays(date: string, weekStartDay: WeekStartDay = 0): string[] {
  const start = Temporal.PlainDate.from(getWeekStartDate(date, weekStartDay));
  return Array.from({ length: 7 }, (_, index) => start.add({ days: index }).toString());
}

export function presentationEventId(event: FeedItem): string {
  return `${event.id}@${event.occurrenceStart}`;
}

function sanitizeScheduleXId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toZonedDateTime(value: string, timezone: string): Temporal.ZonedDateTime {
  const normalized = value.replace(/\[.+\]$/, "");
  if (/([zZ]|[+-]\d{2}:\d{2})$/.test(normalized)) {
    return Temporal.Instant.from(normalized).toZonedDateTimeISO(timezone);
  }
  return Temporal.PlainDateTime.from(normalized).toZonedDateTime(timezone);
}

export function toScheduleXEvent(event: FeedItem, timezone: string): CalendarEvent {
  const id = sanitizeScheduleXId(presentationEventId(event));
  if (event.allDay) {
    const start = Temporal.PlainDate.from(event.occurrenceStart.slice(0, 10));
    const exclusiveEnd = Temporal.PlainDate.from(
      (event.occurrenceEnd ?? event.occurrenceStart).slice(0, 10)
    );
    const end =
      Temporal.PlainDate.compare(exclusiveEnd, start) > 0
        ? exclusiveEnd.subtract({ days: 1 })
        : start;
    return { id, title: event.title, start, end };
  }

  const start = toZonedDateTime(event.occurrenceStart, timezone);
  const end = event.occurrenceEnd
    ? toZonedDateTime(event.occurrenceEnd, timezone)
    : start.add({ hours: 1 });
  return { id, title: event.title, start, end };
}

export function filterCalendarEvents(
  events: readonly FeedItem[],
  showAllDay: boolean,
  selectedMemberIds: ReadonlySet<string>,
  activeMemberIds: readonly string[]
): FeedItem[] {
  const activeSet = new Set(activeMemberIds);
  const selectedActiveIds = new Set(
    [...selectedMemberIds].filter((memberId) => activeSet.has(memberId))
  );
  const restrictMembers = selectedActiveIds.size > 0 && selectedActiveIds.size < activeSet.size;

  return events.filter((event) => {
    if (!showAllDay && event.allDay) return false;
    if (!restrictMembers || event.assignedTo.length === 0) return true;
    return event.assignedTo.some((memberId) => selectedActiveIds.has(memberId));
  });
}

export function getEventsForCalendarDay(
  events: readonly FeedItem[],
  date: string,
  timezone: string
): FeedItem[] {
  const day = Temporal.PlainDate.from(date);
  const dayStart = day.toZonedDateTime(timezone).toInstant();
  const dayEnd = day.add({ days: 1 }).toZonedDateTime(timezone).toInstant();

  return events
    .filter((event) => {
      if (event.allDay) {
        const start = event.occurrenceStart.slice(0, 10);
        const end = event.occurrenceEnd
          ? event.occurrenceEnd.slice(0, 10)
          : Temporal.PlainDate.from(start).add({ days: 1 }).toString();
        return date >= start && date < end;
      }

      const start = Temporal.Instant.from(event.occurrenceStart);
      const end = event.occurrenceEnd
        ? Temporal.Instant.from(event.occurrenceEnd)
        : start.add({ hours: 1 });
      return (
        Temporal.Instant.compare(start, dayEnd) < 0 && Temporal.Instant.compare(end, dayStart) > 0
      );
    })
    .sort((left, right) => {
      if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
      const startOrder = left.occurrenceStart.localeCompare(right.occurrenceStart);
      if (startOrder !== 0) return startOrder;
      const titleOrder = left.title.localeCompare(right.title);
      if (titleOrder !== 0) return titleOrder;
      return presentationEventId(left).localeCompare(presentationEventId(right));
    });
}
