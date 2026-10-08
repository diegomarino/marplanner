import { randomUUID } from "node:crypto";
import { getDb } from "../db/client";
import { boundData, redactEntry, DEFAULT_LIMITS } from "./redact";
import { dispatchToActiveSinks } from "./sink";
import type {
  ClientLogLevel,
  ClientLogIngestResult,
  ClientLogPage,
  ClientLogRow,
} from "../../shared";

/** `writeClientLog` — the SINGLE choke point every telemetry producer writes through
 * validate -> bound -> flood-check -> redact -> insert (the * contractual pipeline order, AC-02). The HTTP ingest route (`routes/telemetry.ts`) is a thin
 * batch loop over this; server-side producers (FR-010, future weather briefing block) call it
 * via the host-API barrel export (`../host-api`).
 * `pruneClientLog`/`agedClientLogRowsExist` (FR-014/INV-09/AC-04) are the
 * retention half of this module; `job.ts` registers them on the process-wide scheduler through
 * the host-API barrel, mirroring `modules/daily-briefing/job.ts`'s shape.
 */

const VALID_LEVELS: ReadonlySet<ClientLogLevel> = new Set(["debug", "info", "warn", "error"]);
const MAX_COMPONENT_LEN = 64;
const MAX_MESSAGE_LEN = 256;
const MAX_BATCH_ENTRIES = 100;
const ALLOWED_ENTRY_KEYS = new Set(["level", "component", "message", "data", "eventTime"]);

const FLOOD_WINDOW_MS = 5 * 60 * 1000;
const FLOOD_LIMIT_PER_WINDOW = 600;

interface FloodState {
  windowStart: number;
  count: number;
}

/** In-memory only (Key Entities: health counters are never persisted, no endpoint this module). */
const floodStateByKey = new Map<string, FloodState>();
let floodDroppedCount = 0;

/** Test/diagnostic accessor — in-memory counter, not exposed by any route this module. */
export function getFloodDroppedCount(): number {
  return floodDroppedCount;
}

/** Test-only reset — avoids cross-test flood-state leakage (module-level singleton state). */
export function __resetTelemetryStateForTests(): void {
  floodStateByKey.clear();
  floodDroppedCount = 0;
}

interface ValidatedEntry {
  level: ClientLogLevel;
  component: string;
  message: string;
  data: unknown;
  eventTime: number | null;
}

/** Per-entry validation ("Write rules") — invalid shape -> per-entry DROP, never a throw. */
function validateEntry(raw: unknown): ValidatedEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter((key) => !ALLOWED_ENTRY_KEYS.has(key));
  if (unknownKeys.length > 0) return null;

  const { level, component, message, data, eventTime } = obj;

  if (typeof level !== "string" || !VALID_LEVELS.has(level as ClientLogLevel)) return null;

  if (typeof component !== "string") return null;
  if (component.trim().length === 0 || component.length > MAX_COMPONENT_LEN) return null;

  if (typeof message !== "string") return null;
  if (message.trim().length === 0 || message.length > MAX_MESSAGE_LEN) return null;

  let eventTimeValue: number | null = null;
  if (eventTime !== undefined) {
    // `event_time` is an INTEGER column (epoch ms); a real value like 1.5 would
    // pass Number.isFinite but violate the STRICT-table column type at insert time
    // (SQLITE_CONSTRAINT_DATATYPE) — reject it here instead (B3).
    if (typeof eventTime !== "number" || !Number.isInteger(eventTime)) return null;
    eventTimeValue = eventTime;
  }

  return {
    level: level as ClientLogLevel,
    component,
    message,
    data,
    eventTime: eventTimeValue,
  };
}

/** Fixed-window per-key flood bound: silent drop + in-memory counter, never a 429. */
function admitUnderFloodBound(apiKeyId: string): boolean {
  const now = Date.now();
  let state = floodStateByKey.get(apiKeyId);
  if (!state || now - state.windowStart >= FLOOD_WINDOW_MS) {
    state = { windowStart: now, count: 0 };
    floodStateByKey.set(apiKeyId, state);
  }
  if (state.count >= FLOOD_LIMIT_PER_WINDOW) {
    floodDroppedCount += 1;
    return false;
  }
  state.count += 1;
  return true;
}

interface ClientLogRowRecord {
  id: string;
  event_id: string;
  event_time: number | null;
  received_at: number;
  level: string;
  component: string;
  message: string;
  data: string | null;
}

function rowToClientLogRow(row: ClientLogRowRecord): ClientLogRow {
  return {
    id: row.id,
    eventId: row.event_id,
    eventTime: row.event_time,
    receivedAt: row.received_at,
    level: row.level as ClientLogLevel,
    component: row.component,
    message: row.message,
    data: row.data,
  };
}

/** Ingest a raw batch (already-JSON-parsed array of unknown shapes). Pipeline per entry:
 * validate -> bound(`data`) -> flood-check -> redact(`message`/`component`/`data`) -> insert.
 * Batch cap: entries beyond `MAX_BATCH_ENTRIES` are dropped+counted, never a 400 (best-effort,
 * FR-002/FR-003 — the caller never needs retry logic, always 200 for a parseable body).
 */
export function writeClientLog(apiKeyId: string, rawEntries: unknown[]): ClientLogIngestResult {
  return writeLogs(apiKeyId, rawEntries);
}

/** Trusted server failures share redaction, retention and admin reads without client flood admission. */
export function writeServerLog(entry: unknown): ClientLogIngestResult {
  return writeLogs(null, [entry]);
}

function writeLogs(apiKeyId: string | null, rawEntries: unknown[]): ClientLogIngestResult {
  const db = getDb();
  let accepted = 0;
  let dropped = 0;

  const overCap = Math.max(0, rawEntries.length - MAX_BATCH_ENTRIES);
  dropped += overCap;
  const candidates = rawEntries.slice(0, MAX_BATCH_ENTRIES);

  for (const raw of candidates) {
    const validated = validateEntry(raw);
    if (!validated || (apiKeyId !== null && validated.component === "event-bus")) {
      dropped += 1;
      continue;
    }

    // The ENTIRE per-entry pipeline (bound -> flood -> redact -> insert) is wrapped in
    // one try/catch. A single poisoned entry (e.g. a non-serializable `data` value that throws
    // inside `boundData`'s internal JSON.stringify, or a STRICT-table constraint violation at
    // insert) must never abort the whole batch or leak a raw error to the HTTP caller — it is
    // counted as `dropped` and the loop CONTINUES to the next entry (per-entry drop semantics,
    // always-200 for a parseable body). A prior version guarded only the insert-time
    // JSON.stringify call, which was unreachable in practice: if that call was ever going to
    // throw, `boundData`'s own internal stringify (used to measure the byte budget) would
    // already have thrown first, propagating out uncaught.
    try {
      const bounded = boundData(validated.data, DEFAULT_LIMITS);

      if (apiKeyId !== null && !admitUnderFloodBound(apiKeyId)) {
        dropped += 1;
        continue;
      }

      const redacted = redactEntry({
        message: validated.message,
        component: validated.component,
        data: bounded,
      });

      // Redaction can EXPAND `component` past its DB-length policy (several short matches
      // each replaced by the 10-char "[redacted]" marker) — re-apply the cap post-redaction.
      // Safe to slice: every secret-shaped substring has already been value-pattern-redacted by
      // this point, so a length cut can only ever land inside already-sanitized text.
      const component =
        redacted.component.length > MAX_COMPONENT_LEN
          ? redacted.component.slice(0, MAX_COMPONENT_LEN)
          : redacted.component;

      const id = randomUUID();
      const eventId = randomUUID();
      const receivedAt = Date.now();
      const dataText = redacted.data === undefined ? null : JSON.stringify(redacted.data);

      db.prepare(
        `INSERT INTO client_log (id, event_id, event_time, received_at, level, component, message, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        eventId,
        validated.eventTime,
        receivedAt,
        validated.level, // level is a closed enum, never redacted
        component,
        redacted.message,
        dataText
      );
      accepted += 1;

      // Pipeline order ( AC-02):...redact -> insert -> sink fan-out — LAST,
      // after the row is durably written: any sink can only ever observe a row that already
      // exists. `dispatchToActiveSinks` defers each sink's `send` onto `setImmediate` —
      // NOT a microtask, which still runs before the event loop reaches I/O and so does not
      // isolate the caller from a slow synchronous `send`, so a slow SYNCHRONOUS sink
      // implementation no longer delays this loop or the caller's response; a failing sink (sync
      // throw or async rejection) is swallowed and counted inside `sink.ts`, never here. `data`
      // is never handed to the sink module at all — only the five fields `TelemetrySinkEnvelope`
      // can hold.
      //
      // Wrapped in its OWN try/catch, separate from the outer per-entry catch below: this
      // entry has ALREADY been counted `accepted` by the line above. If a sink-dispatch failure
      // were instead caught by the outer catch, it would ALSO get counted `dropped`, corrupting
      // the accepted+dropped accounting for an entry that was, in fact, durably inserted.
      // `dispatchToActiveSinks` is total by construction (getActiveSinks cannot throw;
      // fanOutToSinks only schedules `setImmediate` callbacks) — this catch is defense-in-depth
      // only.
      try {
        dispatchToActiveSinks({
          level: validated.level,
          component,
          message: redacted.message,
          receivedAt,
          eventId,
        });
      } catch {
        /* defense-in-depth only — dispatchToActiveSinks is total; see comment above */
      }
    } catch {
      dropped += 1;
    }
  }

  return { accepted, dropped };
}

export interface ClientLogFilters {
  level?: string;
  component?: string;
  from?: number;
  to?: number;
  cursor?: string;
}

const PAGE_LIMIT = 50;

function encodeCursor(receivedAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ receivedAt, id }), "utf8").toString("base64");
}

function decodeCursor(cursor: string): { receivedAt: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { receivedAt?: unknown }).receivedAt === "number" &&
      Number.isFinite((parsed as { receivedAt: number }).receivedAt) &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return parsed as { receivedAt: number; id: string };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read route query (data-model "API surface"): filters + cursor pagination,
 * `received_at DESC, id DESC` stable newest-first order, hard cap 50 (any caller-supplied limit
 * is ignored entirely — this function accepts no `limit` field at all). Returns `null` when a
 * filter or cursor is structurally invalid — the route maps that to 400.
 */
export function getClientLogPage(filters: ClientLogFilters): ClientLogPage | null {
  if (filters.level !== undefined && !VALID_LEVELS.has(filters.level as ClientLogLevel)) {
    return null;
  }
  if (filters.from !== undefined && !Number.isFinite(filters.from)) return null;
  if (filters.to !== undefined && !Number.isFinite(filters.to)) return null;

  let cursor: { receivedAt: number; id: string } | null = null;
  if (filters.cursor !== undefined) {
    cursor = decodeCursor(filters.cursor);
    if (!cursor) return null;
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.level !== undefined) {
    clauses.push("level = ?");
    params.push(filters.level);
  }
  if (filters.component !== undefined) {
    clauses.push("component = ?");
    params.push(filters.component);
  }
  if (filters.from !== undefined) {
    clauses.push("received_at >= ?");
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    clauses.push("received_at <= ?");
    params.push(filters.to);
  }
  if (cursor) {
    clauses.push("(received_at < ? OR (received_at = ? AND id < ?))");
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, event_id, event_time, received_at, level, component, message, data
       FROM client_log
       ${where}
       ORDER BY received_at DESC, id DESC
       LIMIT ${PAGE_LIMIT}`
    )
    .all(...params) as ClientLogRowRecord[];

  const mapped = rows.map(rowToClientLogRow);
  const last = mapped[mapped.length - 1];
  const nextCursor =
    mapped.length === PAGE_LIMIT && last ? encodeCursor(last.receivedAt, last.id) : null;

  return { rows: mapped, nextCursor };
}

/** Retention window (FR-014): 30 days by the receipt clock. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Scheduled retention prune (FR-014) deletes every `client_log` row
 * STRICTLY older than `nowMs - 30d` in a single DELETE statement, returning the deleted count.
 * Boundary semantics matter (CLIENT-LOGGING-TELEMETRY-INV-09/AC-04): a row exactly AT the cutoff
 * instant (`received_at === cutoff`) survives — `<`, never `<=`. `nowMs` defaults to `Date.now`
 * for the real registered job (`job.ts`'s `registerTelemetryPruneJob`); tests inject a frozen
 * value instead so the boundary assertions never depend on wall-clock timing.
 */
export function pruneClientLog(nowMs: number = Date.now()): number {
  const cutoff = nowMs - RETENTION_MS;
  const db = getDb();
  const result = db.prepare("DELETE FROM client_log WHERE received_at < ?").run(cutoff);
  return result.changes;
}

/** Domain-state catch-up predicate for the `telemetry.prune` wall-clock job:
 * ADR-014 — no scheduler-owned bookkeeping): TRUE when at least one row is currently older than
 * the retention cutoff, i.e. a prune is overdue. Unlike daily-briefing's per-member `isMissed`,
 * this predicate is `Date.now`-relative rather than tied to the calendar `date` string the
 * scheduler's `isMissed(date)` signature passes — the retention window has no daily boundary, so
 * the argument is ignored by the caller in `job.ts`.
 */
export function agedClientLogRowsExist(nowMs: number = Date.now()): boolean {
  const cutoff = nowMs - RETENTION_MS;
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM client_log WHERE received_at < ? LIMIT 1").get(cutoff);
  return row !== undefined;
}
