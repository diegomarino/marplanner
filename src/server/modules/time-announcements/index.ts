import {
  CANONICAL_WEEKDAY_ORDER,
  validateWeekdays as validateWeekdayTokens,
} from "../../../shared/weekdays";
import { randomUUID } from "node:crypto";
import type { TimeAnnouncementRule, WeekdayCode } from "../../../shared";
import { getDb } from "../../host-api";

// ── Error types ────────────────────────────────────────────────────────────

export class TimeAnnouncementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeAnnouncementValidationError";
  }
}

export class TimeAnnouncementNotFoundError extends Error {
  constructor(id: string) {
    super(`Time announcement rule not found: ${id}`);
    this.name = "TimeAnnouncementNotFoundError";
  }
}

/** Active-overlap rejection (INV-04): two ACTIVE rules may not share the same
 * `time` plus any common weekday. `conflictingRuleId` NAMES the conflicting rule (the contract's
 * `OverlapError.message` requirement) — a plain rejection, no resolution UI (deferred).
 */
export class TimeAnnouncementOverlapError extends Error {
  constructor(
    public readonly conflictingRuleId: string,
    time: string
  ) {
    super(
      `Active rule "${conflictingRuleId}" already announces at ${time} on an overlapping weekday`
    );
    this.name = "TimeAnnouncementOverlapError";
  }
}

// ── Validation (hand-rolled, reminders/telemetry precedent — no zod) ────────

// Strict 24h HH:MM, `00:00`-`23:59`. Reject, never normalize (INV-02) — no leading/trailing
// trim, no zero-padding a short form, no clamping an out-of-range value.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateTime(time: unknown): string {
  if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
    throw new TimeAnnouncementValidationError(
      `Invalid time "${String(time)}": expected strict 24h HH:MM in 00:00-23:59`
    );
  }
  return time;
}

/** Non-empty, canonical `mon..sun` set, duplicates rejected; returns it re-sorted canonical-order. */
function validateWeekDays(weekDays: unknown): WeekdayCode[] {
  if (!Array.isArray(weekDays) || weekDays.length === 0) {
    throw new TimeAnnouncementValidationError("weekDays is required and must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const day of validateWeekdayTokens(weekDays, TimeAnnouncementValidationError)) {
    if (seen.has(day)) {
      throw new TimeAnnouncementValidationError(`Duplicate weekday "${day}" in weekDays`);
    }
    seen.add(day);
  }
  return CANONICAL_WEEKDAY_ORDER.filter((day) => seen.has(day));
}

function validateIsActive(isActive: unknown): boolean | undefined {
  if (isActive === undefined) return undefined;
  if (typeof isActive !== "boolean") {
    throw new TimeAnnouncementValidationError("isActive must be a boolean");
  }
  return isActive;
}

// ── Row <-> DTO ───────────────────────────────────────────────────────────

type TimeAnnouncementRow = {
  id: string;
  time: string;
  week_days: string;
  is_active: number;
  created_at: number;
  updated_at: number;
};

function rowToRule(row: TimeAnnouncementRow): TimeAnnouncementRule {
  return {
    id: row.id,
    time: row.time,
    weekDays: JSON.parse(row.week_days) as WeekdayCode[],
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CREATE_KEYS = new Set(["time", "weekDays", "isActive"]);
const PATCH_KEYS = new Set(["time", "weekDays", "isActive"]);

/** The active-overlap lookup (INV-04): does an ACTIVE row (excluding `excludeId`, for a PATCH
 * checking a rule against every OTHER row) already share this exact `time` and at least one
 * weekday with `weekDays`? Callers run this INSIDE the same `db.transaction` that performs the
 * write, against the latest persisted rows — never a pre-transaction snapshot — so a concurrent
 * double-save cannot admit two active twins (better-sqlite3 transactions are synchronous, so this
 * proves the in-transaction re-check, not parallelism theatre).
 */
function findActiveOverlap(
  db: ReturnType<typeof getDb>,
  time: string,
  weekDays: readonly WeekdayCode[],
  excludeId?: string
): TimeAnnouncementRow | undefined {
  const rows = (
    excludeId
      ? db
          .prepare(
            "SELECT id, time, week_days, is_active, created_at, updated_at FROM time_announcements WHERE is_active = 1 AND time = ? AND id != ?"
          )
          .all(time, excludeId)
      : db
          .prepare(
            "SELECT id, time, week_days, is_active, created_at, updated_at FROM time_announcements WHERE is_active = 1 AND time = ?"
          )
          .all(time)
  ) as TimeAnnouncementRow[];

  for (const row of rows) {
    const rowWeekDays = JSON.parse(row.week_days) as WeekdayCode[];
    if (rowWeekDays.some((day) => weekDays.includes(day))) {
      return row;
    }
  }
  return undefined;
}

// ── CRUD ──────────────────────────────────────────────────────────

/** List all rules (inactive included), ordered by time, ties by id (kiosk-visible GET). */
export function listTimeAnnouncementRules(): TimeAnnouncementRule[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, time, week_days, is_active, created_at, updated_at FROM time_announcements ORDER BY time ASC, id ASC"
    )
    .all() as TimeAnnouncementRow[];
  return rows.map(rowToRule);
}

/** Create a rule. Strict validation (time shape, non-empty canonical weekday set, unknown-key
 * rejection) runs before the transaction; the active-overlap check (INV-04) runs INSIDE it
 * against the latest persisted rows, so it is a real re-check at commit time, not a stale
 * pre-check.
 */
export function createTimeAnnouncementRule(input: unknown): TimeAnnouncementRule {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TimeAnnouncementValidationError("Request body must be an object");
  }

  const unknownKeys = Object.keys(input).filter((key) => !CREATE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new TimeAnnouncementValidationError(
      `Unsupported field(s) in rule body: ${unknownKeys.join(", ")}`
    );
  }

  const {
    time: timeRaw,
    weekDays: weekDaysRaw,
    isActive: isActiveRaw,
  } = input as {
    time?: unknown;
    weekDays?: unknown;
    isActive?: unknown;
  };

  const time = validateTime(timeRaw);
  const weekDays = validateWeekDays(weekDaysRaw);
  const isActive = validateIsActive(isActiveRaw) ?? true;

  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  const row = db.transaction(() => {
    if (isActive) {
      const conflict = findActiveOverlap(db, time, weekDays);
      if (conflict) {
        throw new TimeAnnouncementOverlapError(conflict.id, time);
      }
    }
    db.prepare(
      "INSERT INTO time_announcements (id, time, week_days, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, time, JSON.stringify(weekDays), isActive ? 1 : 0, now, now);

    const inserted: TimeAnnouncementRow = {
      id,
      time,
      week_days: JSON.stringify(weekDays),
      is_active: isActive ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    return inserted;
  })();

  return rowToRule(row);
}

/** Partial edit / toggle active. `id` MUST exist (404 otherwise). The result's `isActive` — either
 * the patched value or, when omitted, the row's current value — governs whether the overlap
 * re-check runs: an edit that leaves (or makes) the row active is re-checked against every OTHER
 * active row's latest persisted state (LWW by id); an edit that deactivates never overlaps.
 * The whole read-check-write sequence is ONE `db.transaction` (INV-04, concurrent-save safe).
 */
export function editTimeAnnouncementRule(id: string, patch: unknown): TimeAnnouncementRule {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TimeAnnouncementValidationError("Patch body must be a JSON object");
  }

  const patchKeys = Object.keys(patch);
  const unknownKeys = patchKeys.filter((key) => !PATCH_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new TimeAnnouncementValidationError(
      `Unsupported field(s) in patch body: ${unknownKeys.join(", ")}`
    );
  }
  if (patchKeys.length === 0) {
    throw new TimeAnnouncementValidationError(
      "Patch body must include at least one of: time, weekDays, isActive"
    );
  }

  const {
    time: timeRaw,
    weekDays: weekDaysRaw,
    isActive: isActiveRaw,
  } = patch as {
    time?: unknown;
    weekDays?: unknown;
    isActive?: unknown;
  };

  // Validate the patched fields' SHAPE up front (fail fast on a malformed patch before touching
  // the DB) — `time`/`weekDays` are only re-validated here when present; the not-found/overlap
  // checks below still need the transaction, since they depend on the row's existing values.
  const nextTime = timeRaw !== undefined ? validateTime(timeRaw) : undefined;
  const nextWeekDays = weekDaysRaw !== undefined ? validateWeekDays(weekDaysRaw) : undefined;
  const nextIsActive = validateIsActive(isActiveRaw);

  const db = getDb();

  const row = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT id, time, week_days, is_active, created_at, updated_at FROM time_announcements WHERE id = ?"
      )
      .get(id) as TimeAnnouncementRow | undefined;

    if (!existing) {
      throw new TimeAnnouncementNotFoundError(id);
    }

    const resolvedTime = nextTime ?? existing.time;
    const resolvedWeekDays = nextWeekDays ?? (JSON.parse(existing.week_days) as WeekdayCode[]);
    const resolvedIsActive = nextIsActive ?? existing.is_active === 1;

    if (resolvedIsActive) {
      const conflict = findActiveOverlap(db, resolvedTime, resolvedWeekDays, id);
      if (conflict) {
        throw new TimeAnnouncementOverlapError(conflict.id, resolvedTime);
      }
    }

    const now = Date.now();
    db.prepare(
      "UPDATE time_announcements SET time = ?, week_days = ?, is_active = ?, updated_at = ? WHERE id = ?"
    ).run(resolvedTime, JSON.stringify(resolvedWeekDays), resolvedIsActive ? 1 : 0, now, id);

    const updated: TimeAnnouncementRow = {
      id,
      time: resolvedTime,
      week_days: JSON.stringify(resolvedWeekDays),
      is_active: resolvedIsActive ? 1 : 0,
      created_at: existing.created_at,
      updated_at: now,
    };
    return updated;
  })();

  return rowToRule(row);
}

/** Hard-delete a rule — permanent, no archive tier (INV-05). 404 when `id` is unknown. */
export function deleteTimeAnnouncementRule(id: string): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM time_announcements WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new TimeAnnouncementNotFoundError(id);
  }
}
