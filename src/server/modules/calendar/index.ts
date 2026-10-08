import { randomUUID } from "node:crypto";
import { z } from "zod";
// rrule is CJS with no top-level named ESM export — default-import + destructure is
// interop-safe under Node native ESM (the externalized app/test load path), esbuild
// bundling, and the vitest transform. `import { RRule }` throws under Node ESM.
import rrulePkg from "rrule";
import { getDb } from "../../db/client";
import type { FeedItem, EventInput } from "../../../shared";
import { expand, wallClockToInstant } from "./recurrence";
import { listActiveMembers } from "../members/referential";
import { readHouseholdTimezone, isStrictCalendarDate, isDateOnly } from "../../lib/household-date";
import { decorateHighlightTitle, listHighlightRules } from "./highlights";

export {
  ExternalSourceValidationError,
  listExternalSources,
  upsertExternalSource,
  validateExternalSourceUrl,
  type ExternalSourceDependencies,
  type ExternalSourceInput,
} from "./external-sources";

const { RRule } = rrulePkg;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// Public create/edit fields share one strict type boundary; merged-state validation follows.
const eventFieldsSchema = z
  .object({
    title: z.string().min(1),
    allDay: z.boolean(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    startUtc: z.string().datetime({ offset: true }).optional(),
    endUtc: z.string().datetime({ offset: true }).optional(),
    tzid: z.string().optional(),
    rrule: z.string().nullable().optional(),
    exdates: z.array(z.string()).max(1000).optional(),
  })
  .strict();

function validateEventShape(input: Partial<EventInput>): void {
  if (!input.title) {
    throw new ValidationError("Event title is required");
  }
  if (input.allDay === undefined) {
    throw new ValidationError("allDay field is required");
  }

  if (input.allDay) {
    if (!input.startDate || !input.endDate) {
      throw new ValidationError("All-day events require startDate and endDate");
    }

    if (!isStrictCalendarDate(input.startDate)) {
      throw new ValidationError(
        `Invalid startDate "${input.startDate}": must be a valid YYYY-MM-DD`
      );
    }
    if (!isStrictCalendarDate(input.endDate)) {
      throw new ValidationError(`Invalid endDate "${input.endDate}": must be a valid YYYY-MM-DD`);
    }

    if (input.startDate >= input.endDate) {
      throw new ValidationError("All-day event end_date must be after start_date");
    }

    if (input.startUtc !== undefined || input.endUtc !== undefined || input.tzid !== undefined) {
      throw new ValidationError("All-day events cannot have start_utc, end_utc, or tzid");
    }
  } else {
    if (!input.startUtc || !input.endUtc || !input.tzid) {
      throw new ValidationError("Timed events require start_utc, end_utc, and tzid");
    }

    const startMs = Date.parse(input.startUtc);
    const endMs = Date.parse(input.endUtc);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      throw new ValidationError(
        "Timed events require valid ISO instants for start_utc and end_utc"
      );
    }
    if (endMs < startMs) {
      throw new ValidationError("Timed event end_utc must be at or after start_utc");
    }

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.tzid });
    } catch {
      throw new ValidationError(`Invalid IANA timezone: ${input.tzid}`);
    }

    if (input.startDate !== undefined || input.endDate !== undefined) {
      throw new ValidationError("Timed events cannot have start_date or end_date");
    }
  }

  if (input.rrule !== undefined && input.rrule !== null) {
    try {
      const parsed = RRule.parseString(input.rrule);
      if (!parsed || !parsed.freq) {
        throw new Error("Invalid RRule syntax");
      }
    } catch (e: any) {
      throw new ValidationError(`Invalid RRule: ${e.message}`);
    }
  }

  if (input.exdates !== undefined && input.exdates !== null) {
    if (!Array.isArray(input.exdates)) {
      throw new ValidationError("exdates must be an array of strings");
    }
    if (input.exdates.length > 1000) {
      throw new ValidationError("exdates array exceeds maximum of 1000 entries");
    }
    for (const ex of input.exdates) {
      if (typeof ex !== "string") {
        throw new ValidationError("exdates entries must be strings");
      }
      if (input.allDay) {
        if (!isStrictCalendarDate(ex)) {
          throw new ValidationError(
            `Invalid exdate for all-day event "${ex}": must be a valid YYYY-MM-DD calendar date`
          );
        }
      } else {
        if (isDateOnly(ex)) {
          throw new ValidationError(
            `Invalid exdate for timed event "${ex}": must be an ISO instant (not a date-only string)`
          );
        }
        const ts = Date.parse(ex);
        if (isNaN(ts)) {
          throw new ValidationError(`Invalid exdate for timed event: "${ex}"`);
        }
      }
    }
  }
}

type CalendarReadEntry = { item: FeedItem; description: string; location: string };

/** Request-scoped event reuse; only valid during the caller's synchronous DB transaction. */
export type CalendarReadContext = Map<string, CalendarReadEntry[]>;

export interface GetEventsParams {
  source: string;
  assignedTo?: string;
  query?: string;
  queryFields?: string[];
  range?: { from: string; to: string };
  txCtx?: CalendarReadContext;
}

export interface CreateEventInput {
  title: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  startUtc?: string;
  endUtc?: string;
  tzid?: string;
  rrule?: string | null;
  exdates?: string[];
}

export interface SeedEventInput extends CreateEventInput {
  id: string;
  nowMs: number;
}

const SEED_EVENT_ID = /^demo:calendar:event:[a-z0-9][a-z0-9-]*$/;

const expandRangeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

function buildExpandRange(from: string, to: string, tzid: string) {
  let fromDt: Date;
  let toDt: Date;

  if (isDateOnly(from)) {
    const [y, m, d] = from.split("-").map(Number);
    fromDt = wallClockToInstant(tzid, { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 });
  } else {
    fromDt = new Date(from);
  }

  if (isDateOnly(to)) {
    const [y, m, d] = to.split("-").map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d));
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    toDt = wallClockToInstant(tzid, {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    });
  } else {
    toDt = new Date(to);
  }

  if (isNaN(fromDt.getTime()) || isNaN(toDt.getTime())) {
    throw new ValidationError("Invalid date format for range");
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  if (fromDt < windowStart || toDt > windowEnd) {
    throw new WindowError("Requested range exceeds the fixed window (-30d / +365d)");
  }

  return { start: fromDt, end: toDt };
}

/** The occurrence's end anchor, derived from the master's span:
 * - timed: `occurrenceStart` + the master's fixed instant-duration (ISO instant).
 * - all-day: `occurrenceStart` + the master's day-count (`YYYY-MM-DD`, exclusive end).
 * Returns undefined when the master carries no span (e.g. a degenerate row).
 */
function occurrenceEndFor(
  occ: { occurrenceStart: string; allDay: boolean },
  durationMs: number,
  allDaySpanDays: number
): string | undefined {
  if (occ.allDay) {
    if (allDaySpanDays <= 0) return undefined;
    const d = new Date(`${occ.occurrenceStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + allDaySpanDays);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  if (durationMs <= 0) return undefined;
  return new Date(new Date(occ.occurrenceStart).getTime() + durationMs).toISOString();
}

const QUERY_MATCH_FIELDS = new Set(["title", "description", "location"]);

/** Case- and diacritic-insensitive normalization for query substring matching. */
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Query metadata stays inside Calendar; FeedItem remains the public frozen shape. */
function eventFieldValue(
  entry: { item: FeedItem; description: string; location: string },
  field: string
): string {
  if (field === "description") return entry.description;
  if (field === "location") return entry.location;
  return entry.item.title;
}

export function getEvents(params: GetEventsParams): FeedItem[] {
  const { source, query, queryFields, range, txCtx, assignedTo } = params;

  let matchFields: string[] = ["title", "description"];
  if (queryFields !== undefined) {
    if (!Array.isArray(queryFields) || queryFields.length === 0) {
      throw new ValidationError("queryFields must be a non-empty array");
    }
    for (const field of queryFields) {
      if (typeof field !== "string" || !QUERY_MATCH_FIELDS.has(field)) {
        throw new ValidationError(
          `Invalid queryFields entry "${String(field)}": must be one of title, description, location`
        );
      }
    }
    matchFields = queryFields;
  }

  if (txCtx !== undefined && !getDb().inTransaction) {
    throw new ValidationError("Calendar read context requires an active DB transaction");
  }

  if (source !== "all" && source !== "local" && source !== "external") {
    throw new ValidationError(
      `Source "${source}" is not supported (expected 'all', 'local', or 'external').`
    );
  }

  if (!range) {
    throw new ValidationError("Range parameters 'from' and 'to' are required");
  }

  const rangeParsed = expandRangeSchema.safeParse(range);
  if (!rangeParsed.success) {
    throw new ValidationError("Invalid range format");
  }

  const tzid = readHouseholdTimezone();
  const expandRange = buildExpandRange(range.from, range.to, tzid);

  const key = JSON.stringify([source, assignedTo ?? "", range.from, range.to]);
  const entries = txCtx?.get(key) ?? readEventEntries(source, assignedTo, expandRange, tzid);
  txCtx?.set(key, entries);

  if (query !== undefined) {
    const normalizedQuery = normalizeForMatch(query);
    return entries
      .filter((entry) =>
        matchFields.some((field) =>
          normalizeForMatch(eventFieldValue(entry, field)).includes(normalizedQuery)
        )
      )
      .map(({ item }) => item);
  }

  return entries.map(({ item }) => item);
}

function readEventEntries(
  source: string,
  assignedTo: string | undefined,
  expandRange: ReturnType<typeof buildExpandRange>,
  tzid: string
): CalendarReadEntry[] {
  const db = getDb();
  const highlightRules = listHighlightRules();

  const hasAssignedTo = assignedTo !== undefined && assignedTo !== "";

  let sqlQuery;
  if (hasAssignedTo) {
    // Strict on-write: only events with an explicit assignment row matching assignedTo.
    // Tolerant-read for archived members: historical rows stay readable, but active
    // assignedTo=<archived> reads drop the event (the WHERE clause below filters by the
    // member_id column directly, not by lifecycle).
    sqlQuery = `
      SELECT 
        calendar_events.id,
        calendar_events.source,
        calendar_events.title,
        calendar_events.all_day,
        calendar_events.start_date,
        calendar_events.end_date,
        calendar_events.start_utc,
        calendar_events.end_utc,
        calendar_events.tzid,
        calendar_events.rrule,
        calendar_events.exdates,
        external_meta.description,
        external_meta.location,
        external_source.provider,
        external_source.feed_url,
        GROUP_CONCAT(CASE WHEN members.lifecycle = 'active' THEN calendar_assignments.member_id END) AS assigned_members
      FROM calendar_events
      LEFT JOIN calendar_external_event_meta external_meta ON external_meta.event_id = calendar_events.id
      LEFT JOIN calendar_external_sources external_source ON external_source.id = external_meta.source_id
      INNER JOIN calendar_assignments ON calendar_events.id = calendar_assignments.event_id
      LEFT JOIN members ON calendar_assignments.member_id = members.id
      WHERE (calendar_events.source = 'local' OR
        (external_meta.status = 'active' AND external_source.enabled = 1))
        AND calendar_events.id IN (
        SELECT event_id FROM calendar_assignments ca 
        INNER JOIN members m ON ca.member_id = m.id 
        WHERE ca.member_id = ? AND m.lifecycle = 'active'
      )
      GROUP BY calendar_events.id
    `;
  } else {
    // When assignedTo is omitted, include unassigned events (LEFT JOIN).
    sqlQuery = `
      SELECT 
        calendar_events.id,
        calendar_events.source,
        calendar_events.title,
        calendar_events.all_day,
        calendar_events.start_date,
        calendar_events.end_date,
        calendar_events.start_utc,
        calendar_events.end_utc,
        calendar_events.tzid,
        calendar_events.rrule,
        calendar_events.exdates,
        external_meta.description,
        external_meta.location,
        external_source.provider,
        external_source.feed_url,
        GROUP_CONCAT(CASE WHEN members.lifecycle = 'active' THEN calendar_assignments.member_id END) AS assigned_members
      FROM calendar_events
      LEFT JOIN calendar_external_event_meta external_meta ON external_meta.event_id = calendar_events.id
      LEFT JOIN calendar_external_sources external_source ON external_source.id = external_meta.source_id
      LEFT JOIN calendar_assignments ON calendar_events.id = calendar_assignments.event_id
      LEFT JOIN members ON calendar_assignments.member_id = members.id
      WHERE calendar_events.source = 'local' OR
        (external_meta.status = 'active' AND external_source.enabled = 1)
      GROUP BY calendar_events.id
    `;
  }

  const rows = (
    hasAssignedTo
      ? db.prepare(sqlQuery).all(assignedTo)
      : (db.prepare(sqlQuery).all() as Array<{
          id: string;
          source: string;
          title: string;
          all_day: number;
          start_date: string | null;
          end_date: string | null;
          start_utc: string | null;
          end_utc: string | null;
          tzid: string | null;
          rrule: string | null;
          exdates: string;
          description: string | null;
          location: string | null;
          provider: string | null;
          feed_url: string | null;
          assigned_members: string | null;
        }>)
  ) as Array<{
    id: string;
    source: string;
    title: string;
    all_day: number;
    start_date: string | null;
    end_date: string | null;
    start_utc: string | null;
    end_utc: string | null;
    tzid: string | null;
    rrule: string | null;
    exdates: string;
    description: string | null;
    location: string | null;
    provider: string | null;
    feed_url: string | null;
    assigned_members: string | null;
  }>;

  const entries: Array<{ item: FeedItem; description: string; location: string }> = [];

  for (const row of rows) {
    if (source !== "all" && row.source !== source) continue;
    try {
      const exdates = JSON.parse(row.exdates || "[]") as string[];
      const assignedToIds =
        row.assigned_members
          ?.split(",")
          .filter((id) => id && listActiveMembers().some((m) => m.id === id))
          .map((id) => id.trim()) || [];

      const occurrenceParams = {
        allDay: row.all_day === 1,
        startUtc: row.start_utc || undefined,
        startDate: row.start_date || undefined,
        tzid: row.tzid || undefined,
        rrule: row.rrule || null,
        exdates,
      };

      const occurrences = expand(occurrenceParams, expandRange);

      // Per-occurrence span (the expander emits only starts): timed carries the master's
      // fixed instant-duration; all-day carries the master's day-count. Each is applied to
      // the occurrence's own start.
      const durationMs =
        row.all_day === 0 && row.start_utc && row.end_utc
          ? Date.parse(row.end_utc) - Date.parse(row.start_utc)
          : 0;
      const allDaySpanDays =
        row.all_day === 1 && row.start_date && row.end_date
          ? Math.round(
              (Date.parse(`${row.end_date}T00:00:00Z`) -
                Date.parse(`${row.start_date}T00:00:00Z`)) /
                86_400_000
            )
          : 0;
      const sourceUrl = row.source === "external" && row.feed_url ? new URL(row.feed_url) : null;
      const sourceRef = sourceUrl ? `${sourceUrl.protocol}//${sourceUrl.host}/***` : null;

      for (const occ of occurrences) {
        const item: FeedItem = {
          id: row.id,
          occurrenceStart: occ.occurrenceStart,
          occurrenceEnd: occurrenceEndFor(occ, durationMs, allDaySpanDays),
          source: row.source as "local" | "external",
          title: row.title,
          allDay: occ.allDay,
          assignedTo: assignedToIds,
          decoratedTitle: decorateHighlightTitle(row.title, row.description ?? "", highlightRules),
          provider: row.source === "external" ? row.provider : null,
          sourceRef,
        };

        if (!occ.allDay && row.tzid) {
          item.tzid = row.tzid;
        }

        entries.push({ item, description: row.description ?? "", location: row.location ?? "" });
      }
    } catch (err) {
      console.warn(
        `Skipping event ${row.id} due to processing error: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
  }

  return entries;
}

export function createEvent(input: EventInput): { id: string } {
  if (!eventFieldsSchema.safeParse(input).success)
    throw new ValidationError("Invalid event fields");
  const db = getDb();

  validateEventShape(input);

  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `
      INSERT INTO calendar_events 
        (id, source, title, all_day, start_date, end_date, start_utc, end_utc, tzid, rrule, exdates, created_at, updated_at)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    id,
    input.title,
    input.allDay ? 1 : 0,
    input.startDate || null,
    input.endDate || null,
    input.startUtc || null,
    input.endUtc || null,
    input.tzid || null,
    input.rrule || null,
    JSON.stringify(input.exdates || []),
    now,
    now
  );

  return { id };
}

/** Canonicalizes a seed-owned local event through Calendar validation without allowing a seed to
 * target an ordinary event identity. The injected clock keeps a seed run deterministic.
 */
export function upsertSeedEvent(input: SeedEventInput): { id: string } {
  if (!SEED_EVENT_ID.test(input.id)) {
    throw new ValidationError("Seed-owned Calendar event ID is required");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new ValidationError("Seed-owned Calendar event timestamp must be a non-negative integer");
  }
  validateEventShape(input);

  const db = getDb();
  const existing = db.prepare("SELECT source FROM calendar_events WHERE id = ?").get(input.id) as
    { source: string } | undefined;
  if (existing && existing.source !== "local") {
    throw new ValidationError("Seed-owned Calendar event ID cannot replace a non-local event");
  }

  db.prepare(
    `INSERT INTO calendar_events
       (id, source, title, all_day, start_date, end_date, start_utc, end_utc, tzid, rrule, exdates, created_at, updated_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source,
       title = excluded.title,
       all_day = excluded.all_day,
       start_date = excluded.start_date,
       end_date = excluded.end_date,
       start_utc = excluded.start_utc,
       end_utc = excluded.end_utc,
       tzid = excluded.tzid,
       rrule = excluded.rrule,
       exdates = excluded.exdates,
       updated_at = excluded.updated_at`
  ).run(
    input.id,
    input.title,
    input.allDay ? 1 : 0,
    input.startDate || null,
    input.endDate || null,
    input.startUtc || null,
    input.endUtc || null,
    input.tzid || null,
    input.rrule || null,
    JSON.stringify(input.exdates || []),
    input.nowMs,
    input.nowMs
  );

  return { id: input.id };
}

export interface ReplaceAssignmentsInput {
  memberIds: string[];
}

/** Replace an event's assignment set atomically: delete old + insert new in ONE transaction.
 * Each memberId MUST be an active member (strict-on-write, FR-006).
 * Throws MemberReferenceError for any inactive member (400 at the boundary).
 * Throws NotFoundError if the event does not exist.
 */
export function replaceAssignments(eventId: string, memberIds: string[]): FeedItem {
  const db = getDb();

  // Validate the event exists first.
  const eventRow = db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(eventId);
  if (!eventRow) {
    throw new NotFoundError(`Event not found: ${eventId}`);
  }

  // Strict-on-write: every target member MUST be active.
  const activeMembers = listActiveMembers();
  for (const memberId of memberIds) {
    const isActive = activeMembers.some((m) => m.id === memberId);
    if (!isActive) {
      throw new (class MemberReferenceError extends Error {
        constructor(id: string) {
          super(`Member "${id}" is not active`);
          this.name = "MemberReferenceError";
        }
      })(memberId);
    }
  }

  // Dedup memberIds after active validation (Fix 4)
  const uniqueMemberIds = [...new Set(memberIds)];

  const now = Date.now();

  // Atomic: delete old assignments, insert new ones in one transaction.
  db.transaction(() => {
    db.prepare("DELETE FROM calendar_assignments WHERE event_id = ?").run(eventId);

    for (const memberId of uniqueMemberIds) {
      const assignId = randomUUID();
      db.prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
      ).run(assignId, eventId, memberId, now);
    }
  })();

  // Re-read the event with full data to build a FeedItem
  const row = db
    .prepare(
      `SELECT 
        calendar_events.id,
        calendar_events.source,
        calendar_events.title,
        calendar_events.all_day,
        calendar_events.start_date,
        calendar_events.end_date,
        calendar_events.start_utc,
        calendar_events.end_utc,
        calendar_events.tzid,
        calendar_events.rrule,
        calendar_events.exdates
      FROM calendar_events WHERE calendar_events.id = ?`
    )
    .get(eventId) as {
    id: string;
    source: string;
    title: string;
    all_day: number;
    start_date: string | null;
    end_date: string | null;
    start_utc: string | null;
    end_utc: string | null;
    tzid: string | null;
    rrule: string | null;
    exdates: string;
  };

  // Build a real FeedItem for the first occurrence in the fixed expandRange
  const expandRange = {
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  };

  const exdates = JSON.parse(row.exdates || "[]") as string[];

  const occurrenceParams = {
    allDay: row.all_day === 1,
    startUtc: row.start_utc || undefined,
    startDate: row.start_date || undefined,
    tzid: row.tzid || undefined,
    rrule: row.rrule || null,
    exdates,
  };

  const occurrences = expand(occurrenceParams, expandRange);
  if (occurrences.length === 0) {
    // Fallback: use master start as occurrence
    const occStart =
      row.all_day === 1 && row.start_date
        ? row.start_date
        : row.start_utc || new Date().toISOString();
    occurrences.push({ occurrenceStart: occStart, allDay: row.all_day === 1 });
  }

  const occ = occurrences[0];

  const durationMs =
    row.all_day === 0 && row.start_utc && row.end_utc
      ? Date.parse(row.end_utc) - Date.parse(row.start_utc)
      : 0;
  const allDaySpanDays =
    row.all_day === 1 && row.start_date && row.end_date
      ? Math.round(
          (Date.parse(`${row.end_date}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) /
            86_400_000
        )
      : 0;

  const feedItem: FeedItem = {
    id: row.id,
    occurrenceStart: occ.occurrenceStart,
    occurrenceEnd: occurrenceEndFor(occ, durationMs, allDaySpanDays),
    source: row.source as "local" | "external",
    title: row.title,
    allDay: occ.allDay,
    assignedTo: uniqueMemberIds,
    decoratedTitle: row.title,
    provider: null,
    sourceRef: null,
  };

  if (!occ.allDay && row.tzid) {
    feedItem.tzid = row.tzid;
  }

  return feedItem;
}

/** Delete an event atomically: delete its assignment rows AND the event in ONE transaction.
 * Unknown id → NotFoundError (404).
 */
export function deleteEvent(id: string): void {
  const db = getDb();

  // First verify the event exists
  const existing = db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(id);
  if (!existing) {
    throw new NotFoundError(`Event not found: ${id}`);
  }

  // Atomic: delete assignments + event in one transaction to prevent orphans
  db.transaction(() => {
    db.prepare("DELETE FROM calendar_assignments WHERE event_id = ?").run(id);
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
  })();

  return;
}

/** Edit an event's fields single-row: UPDATE only the provided fields.
 * When editing rrule, keep exdates UNTOUCHED (preserved).
 * Unknown id → NotFoundError (404).
 * Returns the updated event as a real FeedItem for the PATCH 200 response.
 */
export function editEvent(id: string, fields: Partial<EventInput>): FeedItem {
  if (!eventFieldsSchema.partial().safeParse(fields).success)
    throw new ValidationError("Invalid event edit fields");
  const db = getDb();

  const existing = db
    .prepare(
      `SELECT id, source, title, all_day, start_date, end_date, 
      start_utc, end_utc, tzid, rrule, exdates
     FROM calendar_events WHERE id = ?`
    )
    .get(id) as {
    id: string;
    source: string;
    title: string;
    all_day: number;
    start_date: string | null;
    end_date: string | null;
    start_utc: string | null;
    end_utc: string | null;
    tzid: string | null;
    rrule: string | null;
    exdates: string;
  } | null;

  if (!existing) {
    throw new NotFoundError(`Event not found: ${id}`);
  }

  // Validate explicit-null rejection for non-nullable fields BEFORE merging/UPDATE
  const nonNullableFields: (keyof EventInput)[] = [
    "title",
    "allDay",
    "startDate",
    "endDate",
    "startUtc",
    "endUtc",
    "tzid",
  ];
  for (const field of nonNullableFields) {
    if (fields[field] === null) {
      throw new ValidationError(`Field "${field}" cannot be null`);
    }
  }

  // exdates is string[] (optional), NOT nullable. Reject null or non-array.
  if (fields.exdates === null) {
    throw new ValidationError(`Field "exdates" cannot be null`);
  }
  if (fields.exdates !== undefined && !Array.isArray(fields.exdates)) {
    throw new ValidationError(`Field "exdates" must be an array`);
  }

  const existingExdates = JSON.parse(existing.exdates || "[]") as string[];

  const mergedEvent: EventInput = {
    title: fields.title ?? existing.title,
    allDay: fields.allDay ?? existing.all_day === 1,
    startDate: fields.startDate ?? existing.start_date ?? undefined,
    endDate: fields.endDate ?? existing.end_date ?? undefined,
    startUtc: fields.startUtc ?? existing.start_utc ?? undefined,
    endUtc: fields.endUtc ?? existing.end_utc ?? undefined,
    tzid: fields.tzid ?? existing.tzid ?? undefined,
    rrule: fields.rrule !== undefined ? fields.rrule : existing.rrule,
    exdates: fields.exdates !== undefined ? fields.exdates : existingExdates,
  };

  validateEventShape(mergedEvent);

  const updates: string[] = [];
  const params: unknown[] = [];

  if (fields.title !== undefined) {
    updates.push("title = ?");
    params.push(fields.title);
  }

  if (fields.allDay !== undefined) {
    updates.push("all_day = ?");
    params.push(fields.allDay ? 1 : 0);
  }

  if (fields.startDate !== undefined) {
    updates.push("start_date = ?");
    params.push(fields.startDate);
  }

  if (fields.endDate !== undefined) {
    updates.push("end_date = ?");
    params.push(fields.endDate);
  }

  if (fields.startUtc !== undefined) {
    updates.push("start_utc = ?");
    params.push(fields.startUtc);
  }

  if (fields.endUtc !== undefined) {
    updates.push("end_utc = ?");
    params.push(fields.endUtc);
  }

  if (fields.tzid !== undefined) {
    updates.push("tzid = ?");
    params.push(fields.tzid);
  }

  if (fields.rrule !== undefined) {
    updates.push("rrule = ?");
    params.push(fields.rrule === null ? null : fields.rrule);
  }

  if (fields.exdates !== undefined) {
    updates.push("exdates = ?");
    params.push(JSON.stringify(fields.exdates));
  }

  const now = Date.now();
  updates.push("updated_at = ?");
  params.push(now);

  params.push(id);
  db.prepare(`UPDATE calendar_events SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const row = db
    .prepare(
      `SELECT 
        calendar_events.id,
        calendar_events.source,
        calendar_events.title,
        calendar_events.all_day,
        calendar_events.start_date,
        calendar_events.end_date,
        calendar_events.start_utc,
        calendar_events.end_utc,
        calendar_events.tzid,
        calendar_events.rrule,
        calendar_events.exdates
      FROM calendar_events WHERE calendar_events.id = ?`
    )
    .get(id) as {
    id: string;
    source: string;
    title: string;
    all_day: number;
    start_date: string | null;
    end_date: string | null;
    start_utc: string | null;
    end_utc: string | null;
    tzid: string | null;
    rrule: string | null;
    exdates: string;
  };

  const expandRange = {
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  };

  const exdates = JSON.parse(row.exdates || "[]") as string[];

  const occurrenceParams = {
    allDay: row.all_day === 1,
    startUtc: row.start_utc || undefined,
    startDate: row.start_date || undefined,
    tzid: row.tzid || undefined,
    rrule: row.rrule || null,
    exdates,
  };

  const occurrences = expand(occurrenceParams, expandRange);
  if (occurrences.length === 0) {
    const occStart =
      row.all_day === 1 && row.start_date
        ? row.start_date
        : row.start_utc || new Date().toISOString();
    occurrences.push({ occurrenceStart: occStart, allDay: row.all_day === 1 });
  }

  const occ = occurrences[0];

  const durationMs =
    row.all_day === 0 && row.start_utc && row.end_utc
      ? Date.parse(row.end_utc) - Date.parse(row.start_utc)
      : 0;
  const allDaySpanDays =
    row.all_day === 1 && row.start_date && row.end_date
      ? Math.round(
          (Date.parse(`${row.end_date}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) /
            86_400_000
        )
      : 0;

  const assignedToIds =
    (
      db
        .prepare(
          `SELECT GROUP_CONCAT(CASE WHEN m.lifecycle = 'active' THEN ca.member_id END) AS assigned_members
         FROM calendar_assignments ca
         LEFT JOIN members m ON ca.member_id = m.id
         WHERE ca.event_id = ?`
        )
        .get(id) as { assigned_members: string | null }
    )?.assigned_members
      ?.split(",")
      .filter((memberId) => memberId && listActiveMembers().some((m) => m.id === memberId))
      .map((memberId) => memberId.trim()) || [];

  const feedItem: FeedItem = {
    id: row.id,
    occurrenceStart: occ.occurrenceStart,
    occurrenceEnd: occurrenceEndFor(occ, durationMs, allDaySpanDays),
    source: row.source as "local" | "external",
    title: row.title,
    allDay: occ.allDay,
    assignedTo: assignedToIds,
    decoratedTitle: row.title,
    provider: null,
    sourceRef: null,
  };

  if (!occ.allDay && row.tzid) {
    feedItem.tzid = row.tzid;
  }

  return feedItem;
}
