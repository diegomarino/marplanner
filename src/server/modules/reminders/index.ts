import { randomUUID } from "node:crypto";
import type {
  DryRunResult,
  Reminder,
  ReminderAssignment,
  ReminderEmission,
  ReminderQueryField,
  Weekday,
} from "../../../shared";
import {
  isActiveMember,
  getEvents,
  WindowError,
  isStrictCalendarDate,
  readHouseholdTimezone,
  weekdayOf,
  getDb,
} from "../../host-api";

import type { CalendarReadContext } from "../../host-api";

// ── Error types ────────────────────────────────────────────────────────────

export class ReminderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderValidationError";
  }
}

export class ReminderNotFoundError extends Error {
  constructor(id: string) {
    super(`Reminder not found: ${id}`);
    this.name = "ReminderNotFoundError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_WEEKDAYS = new Set<string>(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

function validateWeekdays(weekdays: unknown): Weekday[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new ReminderValidationError("weekdays is required and must be a non-empty array");
  }
  for (const day of weekdays) {
    if (typeof day !== "string" || !VALID_WEEKDAYS.has(day)) {
      throw new ReminderValidationError(
        `Invalid weekday "${String(day)}": must be one of mon, tue, wed, thu, fri, sat, sun`
      );
    }
  }
  return weekdays as Weekday[];
}

function rowToReminder(
  row: {
    id: string;
    kind: string;
    targeting_mode: string;
    text: string;
    weekdays: string | null;
    query?: string | null;
    query_fields?: string | null;
    active: number;
  },
  assignments: ReminderAssignment[] = []
): Reminder {
  return {
    id: row.id,
    kind: row.kind as Reminder["kind"],
    targetingMode: row.targeting_mode as Reminder["targetingMode"],
    text: row.text,
    weekdays: row.weekdays ? (JSON.parse(row.weekdays) as Weekday[]) : null,
    query: row.query ?? null,
    queryFields: row.query_fields ? (JSON.parse(row.query_fields) as ReminderQueryField[]) : null,
    active: row.active === 1,
    assignments,
  };
}

const VALID_QUERY_FIELDS = new Set<string>(["title", "description", "location"]);

function validateQueryFields(queryFields: unknown): ReminderQueryField[] {
  if (!Array.isArray(queryFields) || queryFields.length === 0) {
    throw new ReminderValidationError("queryFields must be a non-empty array");
  }
  for (const field of queryFields) {
    if (typeof field !== "string" || !VALID_QUERY_FIELDS.has(field)) {
      throw new ReminderValidationError(
        `Invalid queryFields entry "${String(field)}": must be one of title, description, location`
      );
    }
  }
  return queryFields as ReminderQueryField[];
}

// Create-body allow-lists (pattern, mirrors daily-messages' ALLOWED_UPSERT_KEYS): reject an
// unknown top-level key (e.g. a misspelled `weekdyas`) with 400 instead of silently discarding it.
const SCHEDULED_CREATE_KEYS = new Set(["kind", "targetingMode", "text", "weekdays", "assignments"]);
const CALENDAR_GATED_CREATE_KEYS = new Set([
  "kind",
  "targetingMode",
  "text",
  "query",
  "queryFields",
  "assignments",
]);

type AssignmentRow = {
  id: string;
  member_id: string;
  weekdays: string;
  active: number;
};

function rowToAssignment(row: AssignmentRow): ReminderAssignment {
  return {
    id: row.id,
    memberId: row.member_id,
    weekdays: JSON.parse(row.weekdays) as Weekday[],
    active: row.active === 1,
  };
}

/** Active assignments for one reminder rule, oldest first (the GET-embed source). */
function listActiveAssignments(reminderId: string): ReminderAssignment[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, member_id, weekdays, active FROM reminder_assignment WHERE reminder_id = ? AND active = 1 ORDER BY created_at ASC"
    )
    .all(reminderId) as AssignmentRow[];
  return rows.map(rowToAssignment);
}

/** Validate one `{ memberId, weekdays }` assignment input's shape, without the active-member check. */
function validateAssignmentInputShape(entry: unknown): { memberId: string; weekdays: Weekday[] } {
  if (!entry || typeof entry !== "object") {
    throw new ReminderValidationError(
      "Each assignment must be an object with memberId and weekdays"
    );
  }
  const { memberId, weekdays } = entry as { memberId?: unknown; weekdays?: unknown };
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new ReminderValidationError("Each assignment requires a non-blank memberId");
  }
  const parsedWeekdays = validateWeekdays(weekdays);
  return { memberId, weekdays: parsedWeekdays };
}

/** Validate one `{ memberId, weekdays }` assignment input entry. Does not touch the DB write. */
function validateAssignmentInput(entry: unknown): { memberId: string; weekdays: Weekday[] } {
  const parsed = validateAssignmentInputShape(entry);
  if (!isActiveMember(parsed.memberId)) {
    throw new ReminderValidationError(`Member "${parsed.memberId}" is not active`);
  }
  return parsed;
}

/** Validate the full desired assignment set (non-empty, each entry valid, no duplicate memberId). */
function validateAssignmentSet(assignments: unknown): { memberId: string; weekdays: Weekday[] }[] {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new ReminderValidationError(
      "assignments is required and must be a non-empty array for targetingMode: specific"
    );
  }
  const parsed = assignments.map(validateAssignmentInput);
  const seen = new Set<string>();
  for (const { memberId } of parsed) {
    if (seen.has(memberId)) {
      throw new ReminderValidationError(`Duplicate memberId "${memberId}" in assignments`);
    }
    seen.add(memberId);
  }
  return parsed;
}

/** Validate one calendar_gated assignment input's shape, without the active-member check:
 * membership-only targeting (AC-05) — a `memberId`, and NO per-assignment `weekdays`
 * (INV-01/INV-09; a `calendar_gated` assignment carries no weekday restriction, so any present
 * value must be an empty array, and a non-empty one is rejected 400).
 */
function validateCalendarGatedAssignmentInputShape(entry: unknown): { memberId: string } {
  if (!entry || typeof entry !== "object") {
    throw new ReminderValidationError("Each assignment must be an object with memberId");
  }
  const { memberId, weekdays } = entry as { memberId?: unknown; weekdays?: unknown };
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new ReminderValidationError("Each assignment requires a non-blank memberId");
  }
  if (weekdays !== undefined && (!Array.isArray(weekdays) || weekdays.length > 0)) {
    throw new ReminderValidationError(
      "weekdays is not accepted for calendar_gated assignments (membership-only targeting, INV-01/INV-09)"
    );
  }
  return { memberId };
}

/** Validate one calendar_gated assignment input entry (create path — active-member required). */
function validateCalendarGatedAssignmentInput(entry: unknown): { memberId: string } {
  const parsed = validateCalendarGatedAssignmentInputShape(entry);
  if (!isActiveMember(parsed.memberId)) {
    throw new ReminderValidationError(`Member "${parsed.memberId}" is not active`);
  }
  return parsed;
}

/** Validate the full calendar_gated `specific` assignment set (non-empty, membership-only, no duplicate memberId). */
function validateCalendarGatedAssignmentSet(assignments: unknown): { memberId: string }[] {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new ReminderValidationError(
      "assignments is required and must be a non-empty array for targetingMode: specific"
    );
  }
  const parsed = assignments.map(validateCalendarGatedAssignmentInput);
  const seen = new Set<string>();
  for (const { memberId } of parsed) {
    if (seen.has(memberId)) {
      throw new ReminderValidationError(`Duplicate memberId "${memberId}" in assignments`);
    }
    seen.add(memberId);
  }
  return parsed;
}

/** Validate the full calendar_gated `specific` assignment set for a set-REPLACE: mirrors `validateAssignmentSetForReplace`'s * exception — active-member status is required only for members newly added to this rule;
 * a member who already holds an ACTIVE assignment here may remain even if now archived.
 */
function validateCalendarGatedAssignmentSetForReplace(
  assignments: unknown,
  existingActiveMemberIds: ReadonlySet<string>
): { memberId: string }[] {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new ReminderValidationError(
      "assignments is required and must be a non-empty array for targetingMode: specific"
    );
  }
  const parsed = assignments.map(validateCalendarGatedAssignmentInputShape);
  const seen = new Set<string>();
  for (const { memberId } of parsed) {
    if (seen.has(memberId)) {
      throw new ReminderValidationError(`Duplicate memberId "${memberId}" in assignments`);
    }
    seen.add(memberId);
  }
  for (const { memberId } of parsed) {
    if (!existingActiveMemberIds.has(memberId) && !isActiveMember(memberId)) {
      throw new ReminderValidationError(`Member "${memberId}" is not active`);
    }
  }
  return parsed;
}

/** Validate the full desired assignment set for a set-REPLACE: active
 * status is required only for members being newly added to this rule —
 * `existingActiveMemberIds` names members who already have an ACTIVE
 * `reminder_assignment` row here, so an already-assigned member who is now
 * archived may remain in the set (their row is preserved/updated, never
 * rejected for archival). A member whose only prior row was deactivated
 * (omitted in an earlier replace) does NOT count as "already assigned" —
 * re-adding them is a fresh addition, so the active check still applies
 * .
 */
function validateAssignmentSetForReplace(
  assignments: unknown,
  existingActiveMemberIds: ReadonlySet<string>
): { memberId: string; weekdays: Weekday[] }[] {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new ReminderValidationError(
      "assignments is required and must be a non-empty array for targetingMode: specific"
    );
  }
  const parsed = assignments.map(validateAssignmentInputShape);
  const seen = new Set<string>();
  for (const { memberId } of parsed) {
    if (seen.has(memberId)) {
      throw new ReminderValidationError(`Duplicate memberId "${memberId}" in assignments`);
    }
    seen.add(memberId);
  }
  for (const { memberId } of parsed) {
    if (!existingActiveMemberIds.has(memberId) && !isActiveMember(memberId)) {
      throw new ReminderValidationError(`Member "${memberId}" is not active`);
    }
  }
  return parsed;
}

// ── Create (apply_to_all + specific — /) ─────────────────────────────

/** Create a reminder rule — `kind: calendar_gated` delegates to
 * `createCalendarGatedReminder` (009, minimal apply_to_all vertical); everything below is the
 * 006 `scheduled` path: `apply_to_all` (rule-level weekdays, no assignments) or `specific`
 * (no rule-level weekdays, ≥1 per-member assignment). Any other `targetingMode` is rejected 400.
 * `specific`: the ENTIRE assignment set is validated (each memberId active,
 * each weekday set canonical + non-empty) before any write; the rule row and
 * all assignment rows are then inserted in ONE `db.transaction` — atomic,
 * no partial state observable on a validation failure (FR-009/FR-010,
 * REMINDERS-INV-08/AC-07).
 */
export function createReminder(input: unknown): Reminder {
  if (!input || typeof input !== "object") {
    throw new ReminderValidationError("Request body must be an object");
  }

  const { kind, targetingMode, text, weekdays, query, queryFields, assignments } = input as {
    kind?: unknown;
    targetingMode?: unknown;
    text?: unknown;
    weekdays?: unknown;
    query?: unknown;
    queryFields?: unknown;
    assignments?: unknown;
  };

  const allowedKeys =
    kind === "calendar_gated" ? CALENDAR_GATED_CREATE_KEYS : SCHEDULED_CREATE_KEYS;
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ReminderValidationError(
      `Unsupported field(s) in reminder body: ${unknownKeys.join(", ")}`
    );
  }

  if (kind === "calendar_gated") {
    return createCalendarGatedReminder({
      targetingMode,
      text,
      weekdays,
      query,
      queryFields,
      assignments,
    });
  }

  if (kind !== "scheduled") {
    throw new ReminderValidationError('kind must be "scheduled" or "calendar_gated"');
  }

  if (query !== undefined || queryFields !== undefined) {
    throw new ReminderValidationError(
      "query/queryFields are only accepted for kind: calendar_gated"
    );
  }

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ReminderValidationError("text is required and must not be blank");
  }
  const trimmedText = text.trim();

  if (targetingMode === "apply_to_all") {
    if (assignments !== undefined) {
      throw new ReminderValidationError(
        "assignments is not accepted for targetingMode: apply_to_all (per-assignment weekdays are specific-only, INV-09)"
      );
    }
    const parsedWeekdays = validateWeekdays(weekdays);

    const id = randomUUID();
    const now = Date.now();

    const db = getDb();
    db.prepare(
      "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at) VALUES (?, 'scheduled', 'apply_to_all', ?, ?, 1, ?, ?)"
    ).run(id, trimmedText, JSON.stringify(parsedWeekdays), now, now);

    return rowToReminder({
      id,
      kind: "scheduled",
      targeting_mode: "apply_to_all",
      text: trimmedText,
      weekdays: JSON.stringify(parsedWeekdays),
      active: 1,
    });
  }

  if (targetingMode === "specific") {
    if (weekdays !== undefined) {
      throw new ReminderValidationError(
        "weekdays is not accepted for targetingMode: specific (rule-level weekdays are apply_to_all-only, INV-09)"
      );
    }
    const parsedAssignments = validateAssignmentSet(assignments);

    const id = randomUUID();
    const now = Date.now();
    const db = getDb();

    db.transaction(() => {
      db.prepare(
        "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at) VALUES (?, 'scheduled', 'specific', ?, NULL, 1, ?, ?)"
      ).run(id, trimmedText, now, now);

      for (const { memberId, weekdays: memberWeekdays } of parsedAssignments) {
        db.prepare(
          "INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
        ).run(randomUUID(), id, memberId, JSON.stringify(memberWeekdays), now, now);
      }
    })();

    return rowToReminder(
      {
        id,
        kind: "scheduled",
        targeting_mode: "specific",
        text: trimmedText,
        weekdays: null,
        active: 1,
      },
      listActiveAssignments(id)
    );
  }

  throw new ReminderValidationError('targetingMode must be "apply_to_all" or "specific"');
}

/** Create a calendar_gated reminder rule — `apply_to_all` (every active member) or `specific`
 * (membership-only targeting, AC-05: assignments carry no weekdays —). Rejects weekdays
 * anywhere, rule-level or per-assignment (INV-01/INV-09 discriminant). `queryFields` defaults to
 * `["title","description"]` when omitted so it is stored non-null.
 */
function createCalendarGatedReminder(input: {
  targetingMode: unknown;
  text: unknown;
  weekdays: unknown;
  query: unknown;
  queryFields: unknown;
  assignments: unknown;
}): Reminder {
  const { targetingMode, text, weekdays, query, queryFields, assignments } = input;

  if (weekdays !== undefined) {
    throw new ReminderValidationError(
      "weekdays is not accepted for kind: calendar_gated (INV-01/INV-09)"
    );
  }

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ReminderValidationError("text is required and must not be blank");
  }
  const trimmedText = text.trim();

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ReminderValidationError(
      "query is required and must not be blank for kind: calendar_gated"
    );
  }
  const trimmedQuery = query.trim();

  const resolvedQueryFields: ReminderQueryField[] =
    queryFields === undefined ? ["title", "description"] : validateQueryFields(queryFields);

  if (targetingMode === "apply_to_all") {
    if (assignments !== undefined) {
      throw new ReminderValidationError(
        "assignments is not accepted for targetingMode: apply_to_all (INV-09)"
      );
    }

    const id = randomUUID();
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, query, query_fields, active, created_at, updated_at) VALUES (?, 'calendar_gated', 'apply_to_all', ?, NULL, ?, ?, 1, ?, ?)"
    ).run(id, trimmedText, trimmedQuery, JSON.stringify(resolvedQueryFields), now, now);

    return rowToReminder({
      id,
      kind: "calendar_gated",
      targeting_mode: "apply_to_all",
      text: trimmedText,
      weekdays: null,
      query: trimmedQuery,
      query_fields: JSON.stringify(resolvedQueryFields),
      active: 1,
    });
  }

  if (targetingMode === "specific") {
    const parsedAssignments = validateCalendarGatedAssignmentSet(assignments);

    const id = randomUUID();
    const now = Date.now();
    const db = getDb();

    db.transaction(() => {
      db.prepare(
        "INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, query, query_fields, active, created_at, updated_at) VALUES (?, 'calendar_gated', 'specific', ?, NULL, ?, ?, 1, ?, ?)"
      ).run(id, trimmedText, trimmedQuery, JSON.stringify(resolvedQueryFields), now, now);

      for (const { memberId } of parsedAssignments) {
        db.prepare(
          "INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, '[]', 1, ?, ?)"
        ).run(randomUUID(), id, memberId, now, now);
      }
    })();

    return rowToReminder(
      {
        id,
        kind: "calendar_gated",
        targeting_mode: "specific",
        text: trimmedText,
        weekdays: null,
        query: trimmedQuery,
        query_fields: JSON.stringify(resolvedQueryFields),
        active: 1,
      },
      listActiveAssignments(id)
    );
  }

  throw new ReminderValidationError('targetingMode must be "apply_to_all" or "specific"');
}

// ── Read / edit / delete ──────────────────────────────────────────

type ReminderRow = {
  id: string;
  kind: string;
  targeting_mode: string;
  text: string;
  weekdays: string | null;
  query: string | null;
  query_fields: string | null;
  active: number;
};

/** List all reminder rules, oldest first. Each rule EMBEDS its active
 * assignments (empty array for `apply_to_all`, which carries none).
 */
export function listReminders(): Reminder[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, kind, targeting_mode, text, weekdays, query, query_fields, active FROM reminder ORDER BY created_at ASC"
    )
    .all() as ReminderRow[];

  return rows.map((row) => rowToReminder(row, listActiveAssignments(row.id)));
}

/** Fetch one reminder rule by id, embedding its active assignments. Throws `ReminderNotFoundError` if it never existed. */
export function getReminder(id: string): Reminder {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, kind, targeting_mode, text, weekdays, query, query_fields, active FROM reminder WHERE id = ?"
    )
    .get(id) as ReminderRow | undefined;

  if (!row) {
    throw new ReminderNotFoundError(id);
  }

  return rowToReminder(row, listActiveAssignments(id));
}

const EDITABLE_REMINDER_KEYS = new Set(["text", "weekdays", "active", "query", "queryFields"]);

/** Edit a reminder's text / active / (apply_to_all) weekdays / (calendar_gated) query+queryFields.
 * `kind` and `targetingMode` are immutable after creation (FR-013, Clarifications) —
 * their presence in the patch body, even unchanged, is rejected 400. Mirrors
 * `ReminderEditInput`'s `additionalProperties: false`: any other unrecognized
 * key, an empty object (nothing to edit), or a non-object/array body is
 * likewise rejected 400 — never silently accepted as a no-op 200.
 * `weekdays` and `query`/`queryFields` are kind-aware (009, finding + the carry-in):
 * `weekdays` is rejected 400 on a `calendar_gated` row (was a 500 CHECK-constraint violation
 * before this fix — the discriminant must reject at the boundary, never let a bad UPDATE reach
 * the DB); `query`/`queryFields` are rejected 400 on a `scheduled` row. Omitting `queryFields`
 * while editing `query` PRESERVES the stored value — a partial edit MUST NOT reset it to the
 * create-time default (finding ′).
 */
export function editReminder(id: string, patch: unknown): Reminder {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ReminderValidationError("Patch body must be a JSON object");
  }

  if ("kind" in patch || "targetingMode" in patch) {
    throw new ReminderValidationError(
      "kind and targetingMode are immutable after creation (FR-013)"
    );
  }

  const patchKeys = Object.keys(patch);
  const unknownKeys = patchKeys.filter((key) => !EDITABLE_REMINDER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ReminderValidationError(
      `Unsupported field(s) in patch body: ${unknownKeys.join(", ")}`
    );
  }
  if (patchKeys.length === 0) {
    throw new ReminderValidationError(
      "Patch body must include at least one of: text, weekdays, active"
    );
  }

  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, kind, targeting_mode, text, weekdays, query, query_fields, active FROM reminder WHERE id = ?"
    )
    .get(id) as ReminderRow | undefined;

  if (!row) {
    throw new ReminderNotFoundError(id);
  }

  const { text, weekdays, active, query, queryFields } = patch as {
    text?: unknown;
    weekdays?: unknown;
    active?: unknown;
    query?: unknown;
    queryFields?: unknown;
  };

  if (weekdays !== undefined && row.kind === "calendar_gated") {
    throw new ReminderValidationError(
      "weekdays cannot be edited on a calendar_gated rule (membership-only targeting, INV-01/INV-09)"
    );
  }

  if (weekdays !== undefined && row.targeting_mode !== "apply_to_all") {
    throw new ReminderValidationError(
      "weekdays can only be edited on an apply_to_all rule (per-member weekdays live on assignments for specific)"
    );
  }

  if ((query !== undefined || queryFields !== undefined) && row.kind !== "calendar_gated") {
    throw new ReminderValidationError(
      "query/queryFields can only be edited on a calendar_gated rule"
    );
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (text !== undefined) {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new ReminderValidationError("text must not be blank");
    }
    updates.push("text = ?");
    params.push(text.trim());
  }

  if (weekdays !== undefined) {
    const parsedWeekdays = validateWeekdays(weekdays);
    updates.push("weekdays = ?");
    params.push(JSON.stringify(parsedWeekdays));
  }

  if (query !== undefined) {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new ReminderValidationError("query must not be blank");
    }
    updates.push("query = ?");
    params.push(query.trim());
  }

  if (queryFields !== undefined) {
    const parsedQueryFields = validateQueryFields(queryFields);
    updates.push("query_fields = ?");
    params.push(JSON.stringify(parsedQueryFields));
  }

  if (active !== undefined) {
    if (typeof active !== "boolean") {
      throw new ReminderValidationError("active must be a boolean");
    }
    updates.push("active = ?");
    params.push(active ? 1 : 0);
  }

  if (updates.length === 0) {
    return rowToReminder(row, listActiveAssignments(id));
  }

  updates.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  db.prepare(`UPDATE reminder SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  return getReminder(id);
}

/** Hard-delete a reminder rule; its `reminder_assignment` rows cascade via the FK. */
export function deleteReminder(id: string): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM reminder WHERE id = ?").run(id);

  if (result.changes === 0) {
    throw new ReminderNotFoundError(id);
  }
}

// ── Assignment set-replace ────────────────────────────────────────────

/** Atomic full-set replace of a `specific` rule's active assignments — the
 * ONLY assignment-write operation: the caller sends the
 * complete desired set, last-write-wins (no If-Match/409 — deferred).
 * The ENTIRE incoming set is validated first (rule exists + is `specific`,
 * every weekday set canonical + non-empty, the set itself non-empty — INV-02,
 * a `specific` rule may never drop to zero active assignments while active).
 * Active-member status is required only for members being NEWLY added to
 * this rule: a member who already has an ACTIVE `reminder_assignment`
 * row here may remain in the desired set even if now archived — their row is
 * preserved/updated rather than rejected, so self-heal on reactivation stays
 * possible. A member whose only prior row was deactivated
 * (previously omitted) does NOT count as already-assigned — re-adding them
 * is a fresh addition and still requires active status . Only
 * once validation passes does ONE
 * `db.transaction` upsert the members present and deactivate (`active=0`,
 * never hard-delete) the members omitted — commits or rolls back as a whole,
 * no partial per-row state observable (FR-009/FR-010).
 * Kind-aware: a `calendar_gated` rule validates against the
 * membership-only assignment set (no weekdays, AC-05/INV-01/INV-09) instead of the `scheduled`
 * weekday-bearing one — before this fix the route always applied the `scheduled` validator, so a
 * `calendar_gated` rule rejected the valid `{memberId}` shape and accepted the forbidden
 * `{memberId, weekdays}` one.
 */
export function replaceAssignments(reminderId: string, input: unknown): ReminderAssignment[] {
  const db = getDb();
  const reminderRow = db
    .prepare("SELECT id, kind, targeting_mode FROM reminder WHERE id = ?")
    .get(reminderId) as { id: string; kind: string; targeting_mode: string } | undefined;

  if (!reminderRow) {
    throw new ReminderNotFoundError(reminderId);
  }

  if (reminderRow.targeting_mode !== "specific") {
    throw new ReminderValidationError(
      "Assignments can only be replaced for targetingMode: specific"
    );
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ReminderValidationError("Request body must be an object with an assignments array");
  }

  const unknownKeys = Object.keys(input).filter((key) => key !== "assignments");
  if (unknownKeys.length > 0) {
    throw new ReminderValidationError(
      `Unsupported field(s) in assignments body: ${unknownKeys.join(", ")}`
    );
  }

  const { assignments } = input as { assignments?: unknown };

  const existingRows = db
    .prepare("SELECT id, member_id, active FROM reminder_assignment WHERE reminder_id = ?")
    .all(reminderId) as Array<{ id: string; member_id: string; active: number }>;
  const existingActiveMemberIds = new Set(
    existingRows.filter((row) => row.active === 1).map((row) => row.member_id)
  );

  const parsedAssignments: { memberId: string; weekdays: Weekday[] }[] =
    reminderRow.kind === "calendar_gated"
      ? validateCalendarGatedAssignmentSetForReplace(assignments, existingActiveMemberIds).map(
          ({ memberId }) => ({ memberId, weekdays: [] as Weekday[] })
        )
      : validateAssignmentSetForReplace(assignments, existingActiveMemberIds);

  const now = Date.now();
  const desiredMemberIds = new Set(parsedAssignments.map((a) => a.memberId));

  db.transaction(() => {
    const existingByMember = new Map(existingRows.map((row) => [row.member_id, row]));

    for (const { memberId, weekdays } of parsedAssignments) {
      const existing = existingByMember.get(memberId);
      if (existing) {
        db.prepare(
          "UPDATE reminder_assignment SET weekdays = ?, active = 1, updated_at = ? WHERE id = ?"
        ).run(JSON.stringify(weekdays), now, existing.id);
      } else {
        db.prepare(
          "INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
        ).run(randomUUID(), reminderId, memberId, JSON.stringify(weekdays), now, now);
      }
    }

    for (const row of existingRows) {
      if (row.active === 1 && !desiredMemberIds.has(row.member_id)) {
        db.prepare("UPDATE reminder_assignment SET active = 0, updated_at = ? WHERE id = ?").run(
          now,
          row.id
        );
      }
    }
  })();

  return listActiveAssignments(reminderId);
}

// ── Emission read (live, no snapshot — D4) ───────────────────────────────────

/** Live emission read for one (member, date): active `apply_to_all` rules whose
 * weekday set contains `date`'s weekday, plus active `specific` rules with an
 * active assignment for this member whose weekday set contains it. Tolerant
 * of an inactive/unknown member — returns `[]` rather than throwing (D4).
 */
export function getReminders(
  memberId: unknown,
  date: unknown,
  txCtx?: CalendarReadContext
): ReminderEmission[] {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new ReminderValidationError("memberId is required and must be a non-blank string");
  }
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new ReminderValidationError(`Invalid date "${String(date)}"`);
  }

  if (!isActiveMember(memberId)) {
    return [];
  }

  const weekday = weekdayOf(date, readHouseholdTimezone());

  const db = getDb();

  const applyToAllRows = db
    .prepare(
      "SELECT id, text, weekdays FROM reminder WHERE kind = 'scheduled' AND targeting_mode = 'apply_to_all' AND active = 1"
    )
    .all() as Array<{ id: string; text: string; weekdays: string | null }>;

  const applyToAllEmissions = applyToAllRows
    .filter(
      (row) => row.weekdays !== null && (JSON.parse(row.weekdays) as string[]).includes(weekday)
    )
    .map((row) => ({ id: row.id, text: row.text }));

  const specificRows = db
    .prepare(
      `SELECT r.id AS id, r.text AS text, ra.weekdays AS weekdays
       FROM reminder r
       JOIN reminder_assignment ra ON ra.reminder_id = r.id
       WHERE r.kind = 'scheduled' AND r.targeting_mode = 'specific' AND r.active = 1
         AND ra.member_id = ? AND ra.active = 1`
    )
    .all(memberId) as Array<{ id: string; text: string; weekdays: string }>;

  const specificEmissions = specificRows
    .filter((row) => (JSON.parse(row.weekdays) as string[]).includes(weekday))
    .map((row) => ({ id: row.id, text: row.text }));

  // calendar_gated apply_to_all — every active member is targeted; membership is implicit.
  // Emit iff a query-matching event is assigned to this member on `date` (AC-02/AC-05/INV-05) —
  // the gate reads ONLY via getEvents, never a direct calendar table read.
  const calendarGatedApplyToAllRows = db
    .prepare(
      "SELECT id, text, query, query_fields FROM reminder WHERE kind = 'calendar_gated' AND targeting_mode = 'apply_to_all' AND active = 1"
    )
    .all() as Array<{ id: string; text: string; query: string; query_fields: string }>;

  const calendarGatedApplyToAllEmissions = calendarGatedApplyToAllRows
    .filter((row) => calendarGateMatches(memberId, date, row.query, row.query_fields, txCtx))
    .map((row) => ({ id: row.id, text: row.text }));

  // calendar_gated specific — membership-only targeting (AC-05): a member is targeted iff
  // they hold an active assignment on the rule (assignments carry no weekdays, INV-09); the gate
  // still reads ONLY via getEvents, so member identification never touches member attributes.
  const calendarGatedSpecificRows = db
    .prepare(
      `SELECT r.id AS id, r.text AS text, r.query AS query, r.query_fields AS query_fields
       FROM reminder r
       JOIN reminder_assignment ra ON ra.reminder_id = r.id
       WHERE r.kind = 'calendar_gated' AND r.targeting_mode = 'specific' AND r.active = 1
         AND ra.member_id = ? AND ra.active = 1`
    )
    .all(memberId) as Array<{ id: string; text: string; query: string; query_fields: string }>;

  const calendarGatedSpecificEmissions = calendarGatedSpecificRows
    .filter((row) => calendarGateMatches(memberId, date, row.query, row.query_fields, txCtx))
    .map((row) => ({ id: row.id, text: row.text }));

  return [
    ...applyToAllEmissions,
    ...specificEmissions,
    ...calendarGatedApplyToAllEmissions,
    ...calendarGatedSpecificEmissions,
  ];
}

/** The calendar_gated gate for one rule: does a query-matching event exist, assigned to `memberId`,
 * on `date`? `getEvents` enforces a fixed -30d/+365d window (`WindowError` outside it) — a `date`
 * outside that window must NOT abort the whole emissions read (which also serves 006 scheduled
 * rules, unbounded by any window); it just means this calendar_gated rule cannot match, so treat it
 * as "no match" and let evaluation continue.
 */
function calendarGateMatches(
  memberId: string,
  date: string,
  query: string,
  queryFieldsJson: string,
  txCtx?: CalendarReadContext
): boolean {
  try {
    return (
      getEvents({
        source: "all",
        txCtx,
        assignedTo: memberId,
        query,
        queryFields: JSON.parse(queryFieldsJson) as string[],
        range: { from: date, to: date },
      }).length > 0
    );
  } catch (err) {
    if (err instanceof WindowError) {
      return false;
    }
    throw err;
  }
}

// ── Dry-run / explain (live diagnostic —, spec FR-008) ─────────────────

const DRY_RUN_KEYS = new Set(["memberId", "date"]);

/** Dry-run / explain for one `(ruleId, memberId, date)`: would this `calendar_gated` rule emit,
 * and if not, why — computed with up to three `getEvents` probes over the
 * SAME single-day window as the live gate, `range:{from:date,to:date}` (— the docs'
 * `to:nextDay` is a 2-day-window bug):
 * A = `{assignedTo:member,range}` — the member's assigned events, no query.
 * B = `{assignedTo:member,query,queryFields,range}` — the gate itself.
 * C = `{query,queryFields,range}` — any query-matching event that day, any assignee.
 * B non-empty -> would emit. Else the reason, in the CORRECTED precedence (finding —
 * matched_but_unassigned MUST be checked before query_miss, else it is unreachable): A empty ->
 * no_assigned_events; else C non-empty -> matched_but_unassigned; else -> query_miss.
 * Only defined for `calendar_gated` rules (a `scheduled` rule's emission isn't opaque — it's a
 * deterministic weekday match) — rejected 400 on any other kind.
 */
export function dryRun(ruleId: unknown, input: unknown): DryRunResult {
  if (typeof ruleId !== "string" || ruleId.trim().length === 0) {
    throw new ReminderValidationError("ruleId is required and must be a non-blank string");
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ReminderValidationError("Request body must be an object with memberId and date");
  }
  const unknownKeys = Object.keys(input).filter((key) => !DRY_RUN_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ReminderValidationError(
      `Unsupported field(s) in dry-run body: ${unknownKeys.join(", ")}`
    );
  }

  const { memberId, date } = input as { memberId?: unknown; date?: unknown };
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new ReminderValidationError("memberId is required and must be a non-blank string");
  }
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new ReminderValidationError(`Invalid date "${String(date)}"`);
  }

  const db = getDb();
  const row = db
    .prepare("SELECT id, kind, query, query_fields FROM reminder WHERE id = ?")
    .get(ruleId) as
    { id: string; kind: string; query: string | null; query_fields: string | null } | undefined;

  if (!row) {
    throw new ReminderNotFoundError(ruleId);
  }
  if (row.kind !== "calendar_gated") {
    throw new ReminderValidationError(
      "Dry-run is only supported for kind: calendar_gated rules (a scheduled rule's emission is not opaque)"
    );
  }

  const query = row.query as string;
  const queryFields = JSON.parse(row.query_fields as string) as string[];
  const range = { from: date, to: date };

  const probeA = getEvents({ source: "all", assignedTo: memberId, range });
  const probeB = getEvents({ source: "all", assignedTo: memberId, query, queryFields, range });
  const probeC = getEvents({ source: "all", query, queryFields, range });

  if (probeB.length > 0) {
    return { wouldEmit: true };
  }
  if (probeA.length === 0) {
    return { wouldEmit: false, reason: "no_assigned_events" };
  }
  if (probeC.length > 0) {
    return { wouldEmit: false, reason: "matched_but_unassigned" };
  }
  return { wouldEmit: false, reason: "query_miss" };
}
