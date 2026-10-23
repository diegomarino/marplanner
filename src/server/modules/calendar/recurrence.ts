// rrule is a CJS package with no top-level named ESM exports; under Node's native
// ESM loader (the externalized app/test path) `import { RRule }` throws. Import the
// default (the CJS module.exports) and destructure — interop-safe under esbuild
// bundling, Node native ESM, and the vitest transform alike.
import rrulePkg from "rrule";

const { RRule, RRuleSet } = rrulePkg;

/** A single expanded occurrence of a calendar-event master.
 * PURE by design: the expander emits only the occurrence anchor. `id`, `title`,
 * `assignedTo`, `source`, and span / `occurrenceEnd` belong to `getEvents` — the FeedItem
 * DTO builder (docs/features/calendar.md / read model) — the expander
 * never fabricates them.
 * - timed: `occurrenceStart` is a true UTC instant (ISO string, always with ms).
 * - all-day: `occurrenceStart` is a `YYYY-MM-DD` calendar date.
 */
export interface Occurrence {
  occurrenceStart: string;
  allDay: boolean;
}

export interface ExpandParams {
  allDay: boolean;
  /** timed only — the master's stored UTC instant (ADR-062). */
  startUtc?: string;
  /** all-day only — `YYYY-MM-DD`. */
  startDate?: string;
  /** timed only — IANA id the series expands in (ADR-062). */
  tzid?: string | null;
  /** RFC-5545 `RRULE` (no `DTSTART`); null/undefined = single occurrence. */
  rrule: string | null | undefined;
  /** timed: true-UTC instant strings; all-day: `YYYY-MM-DD` strings. */
  exdates: string[];
}

export interface ExpandRange {
  /** inclusive lower bound (true instant). */
  start: Date;
  /** exclusive upper bound (true instant). */
  end: Date;
  /** inclusive lower calendar date (`YYYY-MM-DD`) for all-day occurrences. All-day events
   * are date-only (CALENDAR-INV-04), so a household range is compared by date, never by the
   * instant of its local midnight. Omitted: all-day anchors compare as UTC midnights. */
  startDay?: string;
  /** exclusive upper calendar date for all-day occurrences; set together with `startDay`. */
  endDay?: string;
}

/** Whether an all-day occurrence on `date` (anchored at UTC midnight `anchor`) is in range. */
function allDayInRange(date: string, anchor: Date, range: ExpandRange): boolean {
  if (range.startDay !== undefined && range.endDay !== undefined) {
    return date >= range.startDay && date < range.endDay;
  }
  return anchor >= range.start && anchor < range.end;
}

// No IANA zone applies an offset near 15h; pad the pseudo-UTC expansion window
// generously so no boundary occurrence is dropped before the true-instant
// reconstruction + precise filter below. Never `.all` (an unbounded rule would
// materialize its entire series — the per-read hang/OOM hazard).
const RANGE_PAD_MS = 48 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The local-event RRULE subset. Anything finer than a day (SECONDLY…HOURLY, BYHOUR,
 * BYMINUTE, BYSECOND) or set-position / year-day / week-number filtering is refused: rrule.js
 * expands synchronously, so such rules — or a BYMONTH/BYMONTHDAY pair that never occurs,
 * which rrule.js scans for until year 9999 — would block the shared event loop on every read. */
const SUPPORTED_FREQS: ReadonlySet<number> = new Set([
  RRule.YEARLY,
  RRule.MONTHLY,
  RRule.WEEKLY,
  RRule.DAILY,
]);
const SUPPORTED_PARTS: ReadonlySet<string> = new Set([
  "freq",
  "interval",
  "count",
  "until",
  "byweekday",
  "bymonthday",
  "bymonth",
  "wkst",
]);
/** Longest length of each month across all years (February counts its leap day). */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const asList = (value: number | number[] | null | undefined): number[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Why `rrule` is outside the supported local-event subset, or null when it is supported.
 * Throws when the string is not parseable RRULE syntax at all. */
export function supportedRruleProblem(rrule: string): string | null {
  const options = RRule.parseString(rrule);
  if (options.freq === undefined || options.freq === null) return "FREQ is required";
  if (!SUPPORTED_FREQS.has(options.freq)) {
    return "FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY";
  }
  for (const [part, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && !SUPPORTED_PARTS.has(part)) {
      return `${part.toUpperCase()} is not supported`;
    }
  }
  const months = asList(options.bymonth);
  const monthDays = asList(options.bymonthday);
  if (months.length > 0 && monthDays.length > 0) {
    const occurs = months.some((month) =>
      monthDays.some((day) => Math.abs(day) <= MONTH_MAX_DAYS[month - 1])
    );
    if (!occurs) return "BYMONTH and BYMONTHDAY never coincide";
  }
  return null;
}

function isSupportedRrule(rrule: string): boolean {
  try {
    return supportedRruleProblem(rrule) === null;
  } catch {
    return false;
  }
}

function readParts(tzid: string, at: Date): Record<string, number> {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== "literal") f[p.type] = Number(p.value);
  }
  // Some engines emit hour "24" for midnight; normalize to 0.
  if (f.hour === 24) f.hour = 0;
  return f;
}

/** Offset (localWallClock − UTC), in ms, that `tzid` applies AT the true instant `at`.
 * Uses the platform Intl tz database — no bundled tz data.
 */
function zoneOffsetMs(tzid: string, at: Date): number {
  const f = readParts(tzid, at);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - at.getTime();
}

/** The wall-clock fields of a true instant `at` in `tzid`. */
function instantToWallClock(tzid: string, at: Date): WallClock {
  const f = readParts(tzid, at);
  return {
    year: f.year,
    month: f.month,
    day: f.day,
    hour: f.hour,
    minute: f.minute,
    second: f.second,
  };
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Interpret wall-clock components (in `tzid`) as a true UTC instant.
 * Sample the zone offset a day BEFORE and a day AFTER the naive-UTC guess. If they
 * agree there is no transition nearby — one offset resolves it. If they differ a DST
 * transition sits within a day of the wall time, so resolve the wall against BOTH
 * regimes and keep whichever candidate genuinely re-derives to that offset.
 * DST edge policy (deterministic, SIGN-INDEPENDENT — holds east AND west of UTC):
 * - spring-forward GAP (wall time does not exist): forward-shift past the skipped
 * interval (the later instant).
 * - fall-back AMBIGUOUS (wall time occurs twice): the post-transition / standard-time
 * instant (the later instant).
 * Both edge cases take the later of the two candidate instants; a naive "correct toward
 * the landed regime" is wrong for negative-offset zones (e.g. America/New_York).
 */
export function wallClockToInstant(tzid: string, w: WallClock): Date {
  const utc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offBefore = zoneOffsetMs(tzid, new Date(utc - DAY_MS));
  const offAfter = zoneOffsetMs(tzid, new Date(utc + DAY_MS));
  if (offBefore === offAfter) {
    return new Date(utc - offBefore);
  }
  const tBefore = utc - offBefore;
  const tAfter = utc - offAfter;
  const beforeValid = zoneOffsetMs(tzid, new Date(tBefore)) === offBefore;
  const afterValid = zoneOffsetMs(tzid, new Date(tAfter)) === offAfter;
  if (beforeValid && !afterValid) return new Date(tBefore);
  if (afterValid && !beforeValid) return new Date(tAfter);
  // Ambiguous (both valid) or gap (neither valid): take the later instant.
  return new Date(Math.max(tBefore, tAfter));
}

/** A "floating" (pseudo-UTC) Date whose UTC fields ARE the given wall-clock — the shape
 * timezone-naive rrule.js expands over (its Dates carry wall-clock in UTC fields).
 */
function floatingDate(w: WallClock): Date {
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
}

function formatDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Build an RRuleSet from a bare `RRULE` string anchored on `dtstart` (a floating date),
 * with `exdates` (also floating) subtracted.
 * `RRule.parseString` yields ONLY the clauses actually present — critical so a bare
 * `FREQ=WEEKLY` does not inherit BYDAY/BYHOUR materialized off a server-clock default
 * dtstart (`new Date`). The weekday/time-of-day then derive from `dtstart` alone.
 */
function buildSet(rrule: string, dtstart: Date, exdates: Date[]): InstanceType<typeof RRuleSet> {
  const options = RRule.parseString(rrule);
  options.dtstart = dtstart;
  const set = new RRuleSet();
  set.rrule(new RRule(options));
  for (const ex of exdates) {
    set.exdate(ex);
  }
  return set;
}

/** Expand within a padded pseudo-UTC window (never the infinite series). */
function expandInWindow(set: InstanceType<typeof RRuleSet>, range: ExpandRange): Date[] {
  return set.between(
    new Date(range.start.getTime() - RANGE_PAD_MS),
    new Date(range.end.getTime() + RANGE_PAD_MS),
    true
  );
}

function expandTimed(
  startUtc: string,
  tzid: string,
  rrule: string,
  exdates: string[],
  range: ExpandRange
): Occurrence[] {
  const startInstant = new Date(startUtc);
  const dtstart = floatingDate(instantToWallClock(tzid, startInstant));

  // rrule works at whole-second granularity, so the reconstruction below loses any
  // sub-second component; carry the master's milliseconds through (DST shifts are
  // whole-minute, so the ms are invariant across the series).
  const subSecondMs = startInstant.getUTCMilliseconds();

  // exdates are true-UTC instants — express each in the same pseudo-UTC wall-clock
  // space rrule matches occurrences in (EXDATE match is wall-clock-relative),
  // so a cross-DST exclusion still lands on its occurrence.
  const exFloating = exdates.map((ex) => floatingDate(instantToWallClock(tzid, new Date(ex))));

  const set = buildSet(rrule, dtstart, exFloating);

  const out: Occurrence[] = [];
  for (const occ of expandInWindow(set, range)) {
    // Reconstruct the true instant FIRST, then filter on it (never on the pseudo Date).
    const reconstructed = wallClockToInstant(tzid, {
      year: occ.getUTCFullYear(),
      month: occ.getUTCMonth() + 1,
      day: occ.getUTCDate(),
      hour: occ.getUTCHours(),
      minute: occ.getUTCMinutes(),
      second: occ.getUTCSeconds(),
    });
    const instant = new Date(reconstructed.getTime() + subSecondMs);
    if (instant >= range.start && instant < range.end) {
      out.push({ occurrenceStart: instant.toISOString(), allDay: false });
    }
  }
  return out;
}

function expandAllDay(
  startDate: string,
  rrule: string,
  exdates: string[],
  range: ExpandRange
): Occurrence[] {
  const [y, m, d] = startDate.split("-").map(Number);
  const dtstart = new Date(Date.UTC(y, m - 1, d));

  const exFloating = exdates.map((ex) => {
    const [ey, em, ed] = ex.split("-").map(Number);
    return new Date(Date.UTC(ey, em - 1, ed));
  });

  const set = buildSet(rrule, dtstart, exFloating);

  const out: Occurrence[] = [];
  for (const occ of expandInWindow(set, range)) {
    // All-day occurrences anchor at UTC midnight of their calendar date.
    const date = formatDateOnly(occ);
    if (allDayInRange(date, occ, range)) {
      out.push({ occurrenceStart: date, allDay: true });
    }
  }
  return out;
}

/** Expand a calendar-event master into its occurrences within `range`.
 * Pure: range in, occurrences out; no I/O; English diagnostics. Recurring timed masters
 * expand in wall-clock via `tzid` with each true UTC instant reconstructed from rrule.js's
 * wall-clock-in-UTC-fields return (R2); `exdates` subtracted; results bounded
 * by the passed `range` (the caller enforces the fixed −30d/+365d window).
 * (docs/features/calendar.md FR-013; ADR-062.)
 */
export function expand(params: ExpandParams, range: ExpandRange): Occurrence[] {
  const { allDay, startUtc, startDate, tzid, rrule, exdates } = params;

  // A row stored before the supported subset was enforced expands to nothing rather than
  // stalling every read that touches it.
  if (rrule && !isSupportedRrule(rrule)) return [];

  if (allDay) {
    if (!startDate) {
      throw new Error("All-day events require startDate");
    }
    if (!rrule) {
      const single = new Date(`${startDate}T00:00:00.000Z`);
      return allDayInRange(startDate, single, range)
        ? [{ occurrenceStart: startDate, allDay: true }]
        : [];
    }
    return expandAllDay(startDate, rrule, exdates, range);
  }

  if (!startUtc || !tzid) {
    throw new Error("Timed events require startUtc and tzid");
  }

  if (!rrule) {
    // Non-recurring timed event: the stored instant IS the occurrence — never routed
    // through wall-clock reconstruction (which would double-shift it). Canonicalized so a
    // ms-less startUtc still emits an exact ISO instant.
    const instant = new Date(startUtc);
    return instant >= range.start && instant < range.end
      ? [{ occurrenceStart: instant.toISOString(), allDay: false }]
      : [];
  }

  return expandTimed(startUtc, tzid, rrule, exdates, range);
}
