import { createHash } from "node:crypto";
import ical, {
  type DateWithTimeZone,
  type EventInstance,
  type ParameterValue,
  type VEvent,
} from "node-ical";
import { MAX_RESPONSE_BYTES } from "./fetch-ics";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hard bounds on what one external feed may cost the shared event loop. Expansion is
 * synchronous, so every limit here caps CPU or memory for a hostile or broken feed; ordinary
 * Google, iCloud and Outlook feeds stay far below all of them (docs/features/calendar.md). */
export const ICS_FEED_LIMITS = Object.freeze({
  /** Downloaded (and parsed) feed size, in UTF-8 bytes. */
  maxFeedBytes: MAX_RESPONSE_BYTES,
  /** One unfolded content line, in UTF-16 code units; a longer property line is dropped. */
  maxLineChars: 64 * 1024,
  /** Expansion window behind `now`; matches the read window callers query. */
  pastWindowDays: 30,
  /** Expansion window ahead of `now`; matches the read window callers query. */
  futureWindowDays: 365,
  /** BYHOUR x BYMINUTE x BYSECOND combinations a daily-or-coarser RRULE may produce per day. */
  maxTimesPerDay: 24,
  /** RDATE values on one VEVENT; a longer list skips the event. */
  maxRdatesPerEvent: 1_000,
  /** EXDATE values on one VEVENT; a longer list skips the event. */
  maxExdatesPerEvent: 2_000,
  /** Occurrences kept per VEVENT (the earliest ones in the window). */
  maxOccurrencesPerEvent: 1_000,
  /** Occurrences per feed; a feed over it fails the sync instead of publishing a partial set. */
  maxOccurrencesPerFeed: 10_000,
  /** Stored text per occurrence, in code points; longer values are truncated. */
  maxTitleChars: 500,
  maxDescriptionChars: 8_000,
  maxLocationChars: 1_000,
  /** Wall-clock budget for expanding one feed; a feed over it fails the sync. */
  parseBudgetMs: 5_000,
});

/** Why part of a feed was dropped or truncated; counted per code in `ParsedCalendar.limits`. */
export type IcsFeedLimitCode =
  | "line_too_long"
  | "unsupported_rrule"
  | "too_many_dates"
  | "event_occurrences_truncated"
  | "feed_occurrences_truncated"
  | "time_budget_exhausted";

/** RRULE frequencies finer than a day; the household feed never needs them. */
const SUB_DAILY_FREQUENCIES: ReadonlySet<string> = new Set(["SECONDLY", "MINUTELY", "HOURLY"]);

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
  /** UIDs of VEVENTs a per-event limit dropped or truncated. Their outcome is unknown rather than
   * removed, so reconciliation keeps their previously imported rows instead of cancelling them. */
  retainedUids?: string[];
  /** Present only when a feed limit dropped or truncated something. */
  limits?: Partial<Record<IcsFeedLimitCode, number>>;
}

export interface ParseIcsOptions {
  now?: Date;
  /** Monotonic milliseconds for the expansion budget; injectable for tests. */
  clock?: () => number;
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

/** Truncate to `max` code points (never splitting a surrogate pair). */
function clipped(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length <= max) return value;
  return Array.from(value.slice(0, max * 2))
    .slice(0, max)
    .join("");
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

function isCalendarEnvelope(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith("BEGIN:VCALENDAR") && trimmed.endsWith("END:VCALENDAR");
}

function parseCalendar(source: string): ReturnType<typeof ical.sync.parseICS> {
  if (!isCalendarEnvelope(source)) throw new Error("invalid_calendar");
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

/** Exclusion identities computed once per event, so RDATE matching stays linear. */
function exclusionIdentities(event: VEvent): Set<string> {
  const identities = new Set<string>();
  for (const excluded of Object.values(event.exdate ?? {})) {
    if (excluded instanceof Date) {
      identities.add(recurrenceIdentity(excluded, excluded.dateOnly === true));
    }
  }
  return identities;
}

function expandRdates(event: EventWithRdate): { instances: NormalizedInstance[]; skipped: number } {
  const { params, values } = rdateParts(event.rdate);
  const instances: NormalizedInstance[] = [];
  let skipped = 0;
  const baseAllDay = event.datetype === "date" || event.start?.dateOnly === true;
  const baseDuration = durationMs(event, baseAllDay);
  const excluded = exclusionIdentities(event);

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
    if (excluded.has(recurrenceIdentity(recurrenceDate, recurrenceDate.dateOnly === true))) {
      continue;
    }

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
  const title = clipped(
    parameterText(instance.event.summary) ?? parameterText(master.summary),
    ICS_FEED_LIMITS.maxTitleChars
  );
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
  const description = clipped(
    parameterText(instance.event.description) ?? parameterText(master.description),
    ICS_FEED_LIMITS.maxDescriptionChars
  );
  const location = clipped(
    parameterText(instance.event.location) ?? parameterText(master.location),
    ICS_FEED_LIMITS.maxLocationChars
  );
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

type LimitCounter = (code: IcsFeedLimitCode, count?: number) => void;

/** Codes that make a feed incomplete as a whole: publishing what was expanded so far would
 * cancel every later event, so the sync fails and the previous snapshot stays authoritative. */
type IcsFeedFailureCode = "feed_occurrences_truncated" | "time_budget_exhausted";

/** Thrown when a feed-wide limit is reached; carries the per-reason counts for logging. */
export class IcsFeedLimitError extends Error {
  readonly code: IcsFeedFailureCode;
  readonly limits: Partial<Record<IcsFeedLimitCode, number>>;

  constructor(code: IcsFeedFailureCode, limits: Partial<Record<IcsFeedLimitCode, number>>) {
    super(code);
    this.name = "IcsFeedLimitError";
    this.code = code;
    this.limits = { ...limits, [code]: (limits[code] ?? 0) + 1 };
  }
}

/** Property name of an unfolded content line (up to the first `;` or `:`), as written. */
function propertyName(line: string): string {
  let end = 0;
  while (end < line.length && line[end] !== ";" && line[end] !== ":") end += 1;
  return line.slice(0, end);
}

/** Property value: everything after the first `:` outside a quoted parameter. Linear scan. */
function propertyValue(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) return line.slice(index + 1);
  }
  return "";
}

/** Whether an RRULE value exceeds the feed limits. Parts are read case-insensitively and every
 * repetition counts, so no spelling or duplicate slips past the check. */
function rruleExceedsLimits(value: string): boolean {
  const lists: Record<string, number> = { BYHOUR: 1, BYMINUTE: 1, BYSECOND: 1 };
  for (const part of value.toUpperCase().split(";")) {
    const separator = part.indexOf("=");
    const key = (separator === -1 ? part : part.slice(0, separator)).trim();
    const partValue = separator === -1 ? "" : part.slice(separator + 1).trim();
    if (key === "FREQ" && SUB_DAILY_FREQUENCIES.has(partValue)) return true;
    if (key in lists) lists[key] = Math.max(lists[key], partValue.split(",").length);
  }
  return lists.BYHOUR * lists.BYMINUTE * lists.BYSECOND > ICS_FEED_LIMITS.maxTimesPerDay;
}

const RECURRENCE_PROPERTIES: ReadonlySet<string> = new Set(["RRULE", "RDATE", "EXDATE"]);

const countValues = (value: string): number => (value ? value.split(",").length : 0);

/** Unfold content lines (RFC 5545 3.1) in one linear pass, dropping any line longer than the
 * line limit, so no per-line work downstream (node-ical's property matching, title and text
 * handling) is ever handed an unbounded string. */
function unfoldedLines(source: string, count: LimitCounter): string[] {
  const lines: string[] = [];
  let parts: string[] = [];
  let length = 0;
  let open = false;
  const flush = () => {
    if (!open) return;
    if (length > ICS_FEED_LIMITS.maxLineChars) count("line_too_long");
    else lines.push(parts.join(""));
    parts = [];
    open = false;
  };
  for (const physical of source.split(/\r?\n/u)) {
    if (open && (physical.startsWith(" ") || physical.startsWith("\t"))) {
      length += physical.length - 1;
      if (length <= ICS_FEED_LIMITS.maxLineChars) parts.push(physical.slice(1));
      continue;
    }
    flush();
    parts = [physical];
    length = physical.length;
    open = true;
  }
  flush();
  return lines;
}

/** Why one recurrence property exceeds the feed limits, given the event's running totals. */
function recurrenceProblem(
  name: string,
  value: string,
  totals: { rdates: number; exdates: number }
): IcsFeedLimitCode | undefined {
  if (name === "RRULE") return rruleExceedsLimits(value) ? "unsupported_rrule" : undefined;
  if (name === "RDATE") totals.rdates += countValues(value);
  else if (name === "EXDATE") totals.exdates += countValues(value);
  else return undefined;
  return totals.rdates > ICS_FEED_LIMITS.maxRdatesPerEvent ||
    totals.exdates > ICS_FEED_LIMITS.maxExdatesPerEvent
    ? "too_many_dates"
    : undefined;
}

/** Linear pre-screen of the whole feed: a VEVENT whose recurrence exceeds the limits is removed
 * before node-ical builds or expands its rule. Component boundaries are matched exactly as
 * node-ical matches them (case-sensitive, nested), while recurrence property names are matched
 * case-insensitively as node-ical stores them; a recurrence property outside any VEVENT that
 * exceeds the limits is dropped on its own. */
function screenFeed(source: string, count: LimitCounter, retain: (uid: string) => void): string {
  const out: string[] = [];
  const dropped = (lines: string[]) => {
    for (const line of lines) {
      if (propertyName(line).toUpperCase() === "UID") retain(propertyValue(line).trim());
    }
  };
  let event: string[] | undefined;
  let depth = 0;
  let problem: IcsFeedLimitCode | undefined;
  let totals = { rdates: 0, exdates: 0 };
  for (const line of unfoldedLines(source, count)) {
    const name = propertyName(line);
    const boundary = (name === "BEGIN" || name === "END") && propertyValue(line) === "VEVENT";
    if (!event) {
      if (boundary && name === "BEGIN") {
        event = [line];
        depth = 1;
        problem = undefined;
        totals = { rdates: 0, exdates: 0 };
        continue;
      }
      const stray = recurrenceProblem(name.toUpperCase(), propertyValue(line), {
        rdates: 0,
        exdates: 0,
      });
      if (stray) count(stray);
      else out.push(line);
      continue;
    }
    event.push(line);
    if (boundary) {
      depth += name === "BEGIN" ? 1 : -1;
      if (depth > 0) continue;
      if (problem) {
        count(problem);
        dropped(event);
      } else {
        for (const kept of event) out.push(kept);
      }
      event = undefined;
      problem = undefined;
      continue;
    }
    problem ??= recurrenceProblem(name.toUpperCase(), propertyValue(line), totals);
  }
  // An unterminated VEVENT keeps node-ical's own structural handling (and the calendar's closing
  // line, which it swallowed); when it is over limit only its recurrence properties are dropped.
  if (problem) {
    count(problem);
    dropped(event ?? []);
  }
  for (const kept of event ?? []) {
    if (!problem || !RECURRENCE_PROPERTIES.has(propertyName(kept).toUpperCase())) out.push(kept);
  }
  return out.join("\r\n");
}

/** Normalize a bounded node-ical parse into Calendar-owned occurrence values. Every feed limit
 * in `ICS_FEED_LIMITS` is enforced here. A per-event limit skips or truncates that event (counted
 * in `skippedCount` and `limits`, its UID in `retainedUids`), so one hostile event never fails the
 * rest of the feed; a feed-wide limit throws `IcsFeedLimitError` instead of returning a partial
 * feed that reconciliation would read as authoritative. */
export function parseIcs(source: string, options: ParseIcsOptions = {}): ParsedCalendar {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw new TypeError("now must be a valid Date");
  if (Buffer.byteLength(source, "utf8") > ICS_FEED_LIMITS.maxFeedBytes) {
    throw new Error("too_large");
  }
  const clock = options.clock ?? (() => performance.now());
  const startedAt = clock();

  const limits: Partial<Record<IcsFeedLimitCode, number>> = {};
  const retainedUids = new Set<string>();
  const retain = (uid: string) => {
    if (uid) retainedUids.add(uid);
  };
  let skippedCount = 0;
  const count: LimitCounter = (code, amount = 1) => {
    limits[code] = (limits[code] ?? 0) + amount;
  };
  const skip: LimitCounter = (code, amount = 1) => {
    count(code, amount);
    skippedCount += amount;
  };

  const from = new Date(now.valueOf() - ICS_FEED_LIMITS.pastWindowDays * DAY_MS);
  const to = new Date(now.valueOf() + ICS_FEED_LIMITS.futureWindowDays * DAY_MS);
  const allDayFrom = allDayWindowBoundary(from, false);
  const allDayTo = allDayWindowBoundary(to, true);
  if (!isCalendarEnvelope(source)) throw new Error("invalid_calendar");
  const parsed = parseCalendar(
    screenFeed(source, (code) => (code === "line_too_long" ? count(code) : skip(code)), retain)
  );
  const byIdentity = new Map<string, ParsedExternalOccurrence>();

  const events = Object.values(parsed).filter(isEvent);
  for (const component of events) {
    if (clock() - startedAt > ICS_FEED_LIMITS.parseBudgetMs) {
      throw new IcsFeedLimitError("time_budget_exhausted", limits);
    }
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
    const occurrences: ParsedExternalOccurrence[] = [];
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
      if (inWindow) occurrences.push(occurrence);
    }
    if (occurrences.length > ICS_FEED_LIMITS.maxOccurrencesPerEvent) {
      // Keep the earliest occurrences: the ones the household sees first.
      count("event_occurrences_truncated");
      retain(component.uid.trim());
      occurrences.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
      occurrences.length = ICS_FEED_LIMITS.maxOccurrencesPerEvent;
    }

    for (const occurrence of occurrences) {
      const identity = `${occurrence.externalUid}\0${occurrence.recurrenceId}`;
      if (byIdentity.has(identity)) {
        skippedCount += 1;
      } else if (byIdentity.size >= ICS_FEED_LIMITS.maxOccurrencesPerFeed) {
        throw new IcsFeedLimitError("feed_occurrences_truncated", limits);
      }
      byIdentity.set(identity, occurrence);
    }
  }

  return {
    occurrences: [...byIdentity.values()].sort((left, right) =>
      sortKey(left).localeCompare(sortKey(right))
    ),
    skippedCount,
    ...(retainedUids.size > 0 ? { retainedUids: [...retainedUids].sort() } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}
