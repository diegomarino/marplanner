import { createHash } from "node:crypto";
import ical, {
  type DateWithTimeZone,
  type EventInstance,
  type ParameterValue,
  type VEvent,
} from "node-ical";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_WINDOW_DAYS = 30;
const FUTURE_WINDOW_DAYS = 365;

export interface ParsedExternalOccurrence {
  externalUid: string;
  recurrenceId: string;
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  startUtc?: string;
  endUtc?: string;
  tzid?: string;
  status: "active" | "cancelled";
  sourceUpdatedAt?: string;
  rawHash: string;
}

export interface ParsedCalendar {
  occurrences: ParsedExternalOccurrence[];
  skippedCount: number;
}

export interface ParseIcsOptions {
  now?: Date;
}

type EventWithRdate = VEvent & { rdate?: unknown };

interface NormalizedInstance {
  start: DateWithTimeZone;
  end: DateWithTimeZone;
  isFullDay: boolean;
  isRecurring: boolean;
  isOverride: boolean;
  event: VEvent;
}

function isEvent(component: unknown): component is EventWithRdate {
  return (
    typeof component === "object" &&
    component !== null &&
    "type" in component &&
    component.type === "VEVENT"
  );
}

function parameterText(value: ParameterValue | undefined): string | undefined {
  const text = typeof value === "string" ? value : value?.val;
  const normalized = typeof text === "string" ? text.trim() : "";
  return normalized || undefined;
}

function dateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function utcDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function recurrenceIdentity(value: DateWithTimeZone, allDay: boolean): string {
  return allDay ? dateOnly(value) : value.toISOString();
}

function canonicalTzid(value: DateWithTimeZone, fallback?: DateWithTimeZone): string | undefined {
  const tzid = value.tz || fallback?.tz;
  if (!tzid) return undefined;
  return ["Etc/UTC", "Etc/GMT", "GMT"].includes(tzid) ? "UTC" : tzid;
}

function parseCalendar(source: string): ReturnType<typeof ical.sync.parseICS> {
  const trimmed = source.trim();
  if (!trimmed.startsWith("BEGIN:VCALENDAR") || !trimmed.endsWith("END:VCALENDAR")) {
    throw new Error("invalid_calendar");
  }
  try {
    return ical.sync.parseICS(source);
  } catch {
    throw new Error("invalid_calendar");
  }
}

function allDayWindowBoundary(value: Date, endOfDay: boolean): Date {
  return new Date(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  );
}

function eventIsStructurallyValid(event: VEvent): boolean {
  const uid = typeof event.uid === "string" ? event.uid.trim() : "";
  const title = parameterText(event.summary);
  if (!uid || !title || !(event.start instanceof Date) || Number.isNaN(event.start.valueOf())) {
    return false;
  }
  if (!(event.end instanceof Date)) return true;
  if (Number.isNaN(event.end.valueOf())) return false;
  const allDay = event.datetype === "date" || event.start.dateOnly === true;
  return allDay
    ? dateOnly(event.end) > dateOnly(event.start)
    : event.end.valueOf() >= event.start.valueOf();
}

function rdateParts(value: unknown): { params: Record<string, string>; values: string[] } {
  if (typeof value === "string") return { params: {}, values: value.split(",") };
  if (Array.isArray(value)) {
    return {
      params: {},
      values: value.filter((entry): entry is string => typeof entry === "string"),
    };
  }
  if (typeof value !== "object" || value === null) return { params: {}, values: [] };

  const candidate = value as { params?: unknown; val?: unknown };
  const params =
    typeof candidate.params === "object" && candidate.params !== null
      ? Object.fromEntries(
          Object.entries(candidate.params).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : {};
  const rawValues = Array.isArray(candidate.val) ? candidate.val : [candidate.val];
  return {
    params,
    values: rawValues
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => entry.split(",")),
  };
}

function parseRdate(token: string, params: Record<string, string>): DateWithTimeZone | undefined {
  const value = token.trim();
  if (!value || /[\r\n]/u.test(value)) return undefined;
  const serializedParams = Object.entries(params)
    .filter(([key, parameter]) => /^[A-Z0-9-]+$/iu.test(key) && !/[\r\n:;]/u.test(parameter))
    .map(([key, parameter]) => `;${key.toUpperCase()}=${parameter}`)
    .join("");
  const parsed = parseCalendar(
 `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:rdate-probe\nDTSTAMP:20000101T000000Z\nSUMMARY:RDATE probe\nDTSTART${serializedParams}:${value}\nEND:VEVENT\nEND:VCALENDAR`
  );
  const event = Object.values(parsed).find(isEvent);
  return event?.start instanceof Date && !Number.isNaN(event.start.valueOf())
    ? event.start
    : undefined;
}

function durationMs(event: VEvent, allDay: boolean): number {
  if (!(event.start instanceof Date) || !(event.end instanceof Date)) {
    return allDay ? DAY_MS : 0;
  }
  if (allDay) {
    const start = Date.UTC(
      event.start.getFullYear(),
      event.start.getMonth(),
      event.start.getDate()
    );
    const end = Date.UTC(event.end.getFullYear(), event.end.getMonth(), event.end.getDate());
    return Math.max(DAY_MS, end - start);
  }
  return event.end.valueOf() - event.start.valueOf();
}

function recurrenceOverride(event: VEvent, recurrenceDate: DateWithTimeZone): VEvent | undefined {
  const isoKey = recurrenceDate.toISOString();
  const dateKey =
    recurrenceDate.dateOnly === true ? dateOnly(recurrenceDate) : utcDateOnly(recurrenceDate);
  return (event.recurrences?.[isoKey] ?? event.recurrences?.[dateKey]) as VEvent | undefined;
}

function isExcluded(event: VEvent, recurrenceDate: DateWithTimeZone): boolean {
  if (!event.exdate) return false;
  const identity = recurrenceIdentity(recurrenceDate, recurrenceDate.dateOnly === true);
  return [...new Set(Object.values(event.exdate))].some(
    (excluded) =>
      excluded instanceof Date &&
      recurrenceIdentity(excluded, excluded.dateOnly === true) === identity
  );
}

function expandRdates(event: EventWithRdate): { instances: NormalizedInstance[]; skipped: number } {
  const { params, values } = rdateParts(event.rdate);
  const instances: NormalizedInstance[] = [];
  let skipped = 0;
  const baseAllDay = event.datetype === "date" || event.start?.dateOnly === true;
  const baseDuration = durationMs(event, baseAllDay);

  for (const token of values) {
    let recurrenceDate: DateWithTimeZone | undefined;
    try {
      recurrenceDate = parseRdate(token, params);
    } catch {
      recurrenceDate = undefined;
    }
    if (!recurrenceDate) {
      skipped += 1;
      continue;
    }
    if (isExcluded(event, recurrenceDate)) continue;

    const override = recurrenceOverride(event, recurrenceDate);
    const instanceEvent = override ?? event;
    const start = override?.start instanceof Date ? override.start : recurrenceDate;
    const allDay = baseAllDay || start.dateOnly === true;
    const ownDuration = override ? durationMs(override, allDay) : baseDuration;
    const effectiveDuration = override?.end instanceof Date ? ownDuration : baseDuration;
    const end = new Date(start.valueOf() + effectiveDuration) as DateWithTimeZone;
    if (allDay) end.dateOnly = true;
    if (start.tz) end.tz = start.tz;
    instances.push({
      start,
      end,
      isFullDay: allDay,
      isRecurring: true,
      isOverride: override !== undefined,
      event: instanceEvent as VEvent,
    });
  }

  return { instances, skipped };
}

function sourceUpdatedAt(event: VEvent): string | undefined {
  const value = event.lastmodified ?? event.created;
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value.toISOString() : undefined;
}

function normalizeOccurrence(
  master: EventWithRdate,
  instance: NormalizedInstance | EventInstance
): ParsedExternalOccurrence | undefined {
  const uid = typeof master.uid === "string" ? master.uid.trim() : "";
  const title = parameterText(instance.event.summary) ?? parameterText(master.summary);
  if (
    !uid ||
    !title ||
    Number.isNaN(instance.start.valueOf()) ||
    Number.isNaN(instance.end.valueOf())
  ) {
    return undefined;
  }

  const allDay = instance.isFullDay || instance.start.dateOnly === true;
  const recurring = Boolean(
    master.rrule || master.rdate || master.recurrenceid || instance.isRecurring
  );
  const recurrenceDate =
    instance.event.recurrenceid instanceof Date ? instance.event.recurrenceid : instance.start;
  const recurrenceId = recurring ? recurrenceIdentity(recurrenceDate, allDay) : "";
  const description =
    parameterText(instance.event.description) ?? parameterText(master.description);
  const location = parameterText(instance.event.location) ?? parameterText(master.location);
  const status: ParsedExternalOccurrence["status"] =
    instance.event.status === "CANCELLED" || master.status === "CANCELLED" ? "cancelled" : "active";
  const updatedAt = sourceUpdatedAt(instance.event) ?? sourceUpdatedAt(master);
  const normalized: Omit<ParsedExternalOccurrence, "rawHash"> = {
    externalUid: uid,
    recurrenceId,
    title,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    allDay,
    ...(allDay
      ? { startDate: dateOnly(instance.start), endDate: dateOnly(instance.end) }
      : {
          startUtc: instance.start.toISOString(),
          endUtc: instance.end.toISOString(),
          tzid: canonicalTzid(instance.start, master.start),
        }),
    status,
    ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {}),
  };
  if (allDay && normalized.endDate! <= normalized.startDate!) return undefined;
  if (!allDay && !normalized.tzid) return undefined;
  return {
    ...normalized,
    rawHash: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
}

function sortKey(occurrence: ParsedExternalOccurrence): string {
  return `${occurrence.startDate ?? occurrence.startUtc ?? ""}\0${occurrence.externalUid}\0${occurrence.recurrenceId}`;
}

/** Normalize a bounded node-ical parse into Calendar-owned occurrence values. */
export function parseIcs(source: string, options: ParseIcsOptions = {}): ParsedCalendar {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw new TypeError("now must be a valid Date");

  const from = new Date(now.valueOf() - PAST_WINDOW_DAYS * DAY_MS);
  const to = new Date(now.valueOf() + FUTURE_WINDOW_DAYS * DAY_MS);
  const allDayFrom = allDayWindowBoundary(from, false);
  const allDayTo = allDayWindowBoundary(to, true);
  const parsed = parseCalendar(source);
  const byIdentity = new Map<string, ParsedExternalOccurrence>();
  let skippedCount = 0;

  for (const component of Object.values(parsed)) {
    if (!isEvent(component)) continue;
    if (!eventIsStructurallyValid(component)) {
      skippedCount += 1;
      continue;
    }

    const allDay = component.datetype === "date" || component.start.dateOnly === true;
    let expanded: EventInstance[];
    try {
      expanded = ical.expandRecurringEvent(component, {
        from: allDay ? allDayFrom : from,
        to: allDay ? allDayTo : to,
      });
    } catch {
      skippedCount += 1;
      continue;
    }

    const rdates = expandRdates(component);
    skippedCount += rdates.skipped;
    for (const instance of [...expanded, ...rdates.instances]) {
      const occurrence = normalizeOccurrence(component, instance);
      if (!occurrence) {
        skippedCount += 1;
        continue;
      }
      const start = occurrence.startUtc ? new Date(occurrence.startUtc) : undefined;
      const inWindow = occurrence.allDay
        ? occurrence.startDate! >= utcDateOnly(from) && occurrence.startDate! <= utcDateOnly(to)
        : start! >= from && start! <= to;
      if (!inWindow) continue;

      const identity = `${occurrence.externalUid}\0${occurrence.recurrenceId}`;
      if (byIdentity.has(identity)) skippedCount += 1;
      byIdentity.set(identity, occurrence);
    }
  }

  return {
    occurrences: [...byIdentity.values()].sort((left, right) =>
      sortKey(left).localeCompare(sortKey(right))
    ),
    skippedCount,
  };
}
