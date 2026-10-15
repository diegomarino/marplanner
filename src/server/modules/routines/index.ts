import { validateWeekdays as validateWeekdayTokens } from "../../../shared/weekdays";
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client";
import type { Routine, Chore } from "../../../shared";
import { listActiveChildren } from "../members/referential";
import type { BoardChore, BoardColumn, BoardDayPeriod } from "../../../shared";
import { isStrictCalendarDate, readHouseholdTimezone, weekdayOf } from "../../lib/household-date";
import { listDayPeriods } from "../day-periods";
import { emit } from "../../lib/event-bus";

// ── Error types ────────────────────────────────────────────────────────────

export class RoutineNotFoundError extends Error {
  constructor(id: string) {
    super(`Routine not found: ${id}`);
    this.name = "RoutineNotFoundError";
  }
}

export class ChoreNotFoundError extends Error {
  constructor(id: string) {
    super(`Chore not found: ${id}`);
    this.name = "ChoreNotFoundError";
  }
}

export class RoutineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineValidationError";
  }
}

export class ChoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChoreValidationError";
  }
}

export class DayPeriodNotFoundError extends Error {
  constructor(id: string) {
    super(`Day period not found: ${id}`);
    this.name = "DayPeriodNotFoundError";
  }
}

export class AssignmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentNotFoundError";
  }
}

export class AssignmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentValidationError";
  }
}

export class CompletionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionValidationError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rowToRoutine(row: {
  id: string;
  name: string;
  day_period_id: string;
  active: number;
}): Routine {
  return {
    id: row.id,
    name: row.name,
    dayPeriodId: row.day_period_id,
    active: row.active === 1,
  };
}

function rowToChore(row: {
  id: string;
  routine_id: string;
  name: string;
  icon: string | null;
  sort_order: number;
  active: number;
}): Chore {
  return {
    id: row.id,
    routineId: row.routine_id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
    active: row.active === 1,
  };
}

function validateDayPeriodId(dayPeriodId: string): void {
  const db = getDb();
  const period = db.prepare("SELECT id FROM day_periods WHERE id = ?").get(dayPeriodId);
  if (!period) {
    throw new DayPeriodNotFoundError(`Day period "${dayPeriodId}" does not exist`);
  }
}

// ── Routine CRUD ───────────────────────────────────────────────────────────

/** Create a routine attached to one day period.
 * Validates dayPeriodId exists (400 if not).
 * Returns the created Routine.
 */
export function createRoutine(input: unknown): Routine {
  // Validate input shape
  if (!input || typeof input !== "object" || !("name" in input) || !("dayPeriodId" in input)) {
    throw new RoutineValidationError("Request body must include name and dayPeriodId");
  }

  const { name, dayPeriodId } = input as { name?: unknown; dayPeriodId?: unknown };

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RoutineValidationError("Routine name is required and must not be blank");
  }

  if (typeof dayPeriodId !== "string" || dayPeriodId.trim().length === 0) {
    throw new RoutineValidationError("dayPeriodId is required and must not be blank");
  }

  // Validate dayPeriodId references an existing period
  validateDayPeriodId(dayPeriodId.trim());

  const id = randomUUID();
  const now = Date.now();
  const trimmedName = name.trim();

  const db = getDb();
  db.prepare(
    "INSERT INTO routines (id, name, day_period_id, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
  ).run(id, trimmedName, dayPeriodId.trim(), now, now);

  return rowToRoutine({ id, name: trimmedName, day_period_id: dayPeriodId.trim(), active: 1 });
}

/** Fetch one routine by id — tolerant of soft-deleted rows.
 * Returns the row whether active or soft-deleted (404 only if the id never existed).
 * This is what makes history-reads possible (FR-007).
 */
export function getRoutineById(id: string): Routine {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, day_period_id, active FROM routines WHERE id = ?")
    .get(id) as { id: string; name: string; day_period_id: string; active: number } | undefined;

  if (!row) {
    throw new RoutineNotFoundError(id);
  }

  return rowToRoutine(row);
}

/** Edit a routine's name, active flag and/or day period.
 * A dayPeriodId must be a non-blank string naming an existing day period (FR-015);
 * every field is validated before anything is written.
 */
export function editRoutine(id: string, patch: unknown): Routine {
  if (!patch || typeof patch !== "object") {
    throw new RoutineValidationError("Patch body must be an object");
  }

  const db = getDb();

  // Fetch current routine (tolerant of soft-delete, same as getRoutineById)
  const row = db
    .prepare("SELECT id, name, day_period_id, active FROM routines WHERE id = ?")
    .get(id) as { id: string; name: string; day_period_id: string; active: number } | undefined;

  if (!row) {
    throw new RoutineNotFoundError(id);
  }

  const typed = patch as Record<string, unknown>;
  const now = Date.now();

  // Validate every supplied field first; the UPDATE runs only after all pass.
  const updates: string[] = [];
  const params: unknown[] = [];

  if ("name" in typed && typed.name !== undefined) {
    if (typeof typed.name !== "string" || typed.name.trim().length === 0) {
      throw new RoutineValidationError("Routine name must not be blank");
    }
    updates.push("name = ?");
    params.push(typed.name.trim());
  }

  if ("active" in typed && typed.active !== undefined) {
    if (typeof typed.active !== "boolean") {
      throw new RoutineValidationError("active must be a boolean");
    }
    updates.push("active = ?");
    params.push(typed.active ? 1 : 0);
  }

  if ("dayPeriodId" in typed && typed.dayPeriodId !== undefined) {
    if (typeof typed.dayPeriodId !== "string" || typed.dayPeriodId.trim().length === 0) {
      throw new RoutineValidationError("dayPeriodId must be a non-blank string");
    }
    const dayPeriodId = typed.dayPeriodId.trim();
    validateDayPeriodId(dayPeriodId);
    updates.push("day_period_id = ?");
    params.push(dayPeriodId);
  }

  // If nothing to update, return current state
  if (updates.length === 0) {
    return rowToRoutine(row);
  }

  updates.push("updated_at = ?");
  params.push(now);
  params.push(id);

  db.prepare(`UPDATE routines SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  // Re-read and return
  const updated = db
    .prepare("SELECT id, name, day_period_id, active FROM routines WHERE id = ?")
    .get(id) as { id: string; name: string; day_period_id: string; active: number };

  return rowToRoutine(updated);
}

/** Soft-delete a routine: set active = 0, bump updated_at.
 * Row disappears from active-only list but stays readable via getRoutineById.
 */
export function softDeleteRoutine(id: string): void {
  const db = getDb();

  const existing = db.prepare("SELECT id FROM routines WHERE id = ?").get(id);

  if (!existing) {
    throw new RoutineNotFoundError(id);
  }

  const now = Date.now();
  db.prepare("UPDATE routines SET active = 0, updated_at = ? WHERE id = ?").run(now, id);
}

// ── Chore CRUD ─────────────────────────────────────────────────────────────

/** Create a chore under a routine. Appends sortOrder after existing chores.
 * Returns 404 if the routine does not exist.
 */
export function createChore(routineId: string, input: unknown): Chore {
  // Validate input
  if (!input || typeof input !== "object" || !("name" in input)) {
    throw new ChoreValidationError("Request body must include name");
  }

  const { name, icon } = input as { name?: unknown; icon?: unknown };

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ChoreValidationError("Chore name is required and must not be blank");
  }
  if (icon !== undefined && icon !== null && typeof icon !== "string") {
    throw new ChoreValidationError("Chore icon must be a string or null");
  }

  const db = getDb();

  // Verify routine exists (active or not)
  const routineRow = db.prepare("SELECT id FROM routines WHERE id = ?").get(routineId);

  if (!routineRow) {
    throw new RoutineNotFoundError(routineId);
  }

  // Compute sortOrder as max(sortOrder) + 1 (or 0 if no chores exist)
  const maxSort = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM chores WHERE routine_id = ? AND active = 1"
    )
    .get(routineId) as { maxSort: number };

  const id = randomUUID();
  const sortOrder = maxSort.maxSort + 1;
  const now = Date.now();
  const trimmedName = name.trim();

  db.prepare(
    "INSERT INTO chores (id, routine_id, name, icon, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
  ).run(id, routineId, trimmedName, icon ?? null, sortOrder, now, now);

  return rowToChore({
    id,
    routine_id: routineId,
    name: trimmedName,
    icon: typeof icon === "string" ? icon : null,
    sort_order: sortOrder,
    active: 1,
  });
}

/** Fetch one chore by id — tolerant of soft-deleted rows (same Rule 1 as routines).
 */
export function getChoreById(id: string): Chore {
  const db = getDb();
  const row = db
    .prepare("SELECT id, routine_id, name, icon, sort_order, active FROM chores WHERE id = ?")
    .get(id) as
    | {
        id: string;
        routine_id: string;
        name: string;
        icon: string | null;
        sort_order: number;
        active: number;
      }
    | undefined;

  if (!row) {
    throw new ChoreNotFoundError(id);
  }

  return rowToChore(row);
}

/** Edit a chore's name, routineId (move to different routine), and/or active.
 * Only fields present in the patch are updated.
 */
export function editChore(id: string, patch: unknown): Chore {
  if (!patch || typeof patch !== "object") {
    throw new ChoreValidationError("Patch body must be an object");
  }

  const db = getDb();

  const row = db
    .prepare("SELECT id, routine_id, name, icon, sort_order, active FROM chores WHERE id = ?")
    .get(id) as
    | {
        id: string;
        routine_id: string;
        name: string;
        icon: string | null;
        sort_order: number;
        active: number;
      }
    | undefined;

  if (!row) {
    throw new ChoreNotFoundError(id);
  }

  const typed = patch as Record<string, unknown>;
  const now = Date.now();

  const updates: string[] = [];
  const params: unknown[] = [];

  if ("name" in typed && typed.name !== undefined) {
    if (typeof typed.name !== "string" || typed.name.trim().length === 0) {
      throw new ChoreValidationError("Chore name must not be blank");
    }
    updates.push("name = ?");
    params.push(typed.name.trim());
  }

  if ("icon" in typed && typed.icon !== undefined) {
    if (typed.icon !== null && typeof typed.icon !== "string") {
      throw new ChoreValidationError("Chore icon must be a string or null");
    }
    updates.push("icon = ?");
    params.push(typed.icon);
  }

  if ("routineId" in typed && typed.routineId !== undefined) {
    if (typeof typed.routineId !== "string" || typed.routineId.trim().length === 0) {
      throw new ChoreValidationError("routineId must not be blank");
    }
    // Verify target routine exists
    const targetRoutine = db
      .prepare("SELECT id FROM routines WHERE id = ?")
      .get(typed.routineId.trim());
    if (!targetRoutine) {
      throw new RoutineNotFoundError(typed.routineId);
    }
    updates.push("routine_id = ?");
    params.push(typed.routineId.trim());
  }

  if ("active" in typed && typed.active !== undefined) {
    if (typeof typed.active !== "boolean") {
      throw new ChoreValidationError("active must be a boolean");
    }
    updates.push("active = ?");
    params.push(typed.active ? 1 : 0);
  }

  if (updates.length === 0) {
    return rowToChore(row);
  }

  // When routineId changes, compute an available sort_order in the TARGET routine
  // (P1: prevent sort_order collision on move)
  let newRoutineId: string | undefined;
  const hasRoutineIdUpdate = updates.includes("routine_id = ?");
  if (hasRoutineIdUpdate) {
    const targetRoutine = db
      .prepare("SELECT id FROM routines WHERE id = ?")
      .get((typed.routineId as string).trim());
    if (!targetRoutine) {
      throw new RoutineNotFoundError(typed.routineId as string);
    }
    newRoutineId = (typed.routineId as string).trim();
    const maxSort = db
      .prepare(
        "SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM chores WHERE routine_id = ? AND active = 1"
      )
      .get(newRoutineId) as { maxSort: number };
    const newSortOrder = maxSort.maxSort + 1;
    // Replace the old routine_id param with the new one (it was pushed above)
    // Find and update the routine_id assignment
    const routineIdIdx = updates.indexOf("routine_id = ?");
    if (routineIdIdx !== -1) {
      params[routineIdIdx] = newRoutineId;
    }
    // Append sort_order update
    updates.push("sort_order = ?");
    params.push(newSortOrder);
  }

  // When reactivating a chore (active 0 → 1), assign a fresh collision-free order
  // (P2: prevent sort_order collision on reactivate)
  const wasInactive = row.active === 0;
  const isNowActive = "active" in typed && typed.active === true;
  if (wasInactive && isNowActive && !hasRoutineIdUpdate) {
    // Reactivating without changing routine — recompute order in current routine
    const maxSort = db
      .prepare(
        "SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM chores WHERE routine_id = ? AND active = 1"
      )
      .get(row.routine_id) as { maxSort: number };
    updates.push("sort_order = ?");
    params.push(maxSort.maxSort + 1);
  } else if (wasInactive && isNowActive && hasRoutineIdUpdate) {
    // Reactivating AND moving — order was already computed above for the new routine
  }

  updates.push("updated_at = ?");
  params.push(now);
  params.push(id);

  db.prepare(`UPDATE chores SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const updated = db
    .prepare("SELECT id, routine_id, name, icon, sort_order, active FROM chores WHERE id = ?")
    .get(id) as {
    id: string;
    routine_id: string;
    name: string;
    icon: string | null;
    sort_order: number;
    active: number;
  };

  return rowToChore(updated);
}

/** Soft-delete a chore: set active = 0, bump updated_at.
 */
export function softDeleteChore(id: string): void {
  const db = getDb();

  const existing = db.prepare("SELECT id FROM chores WHERE id = ?").get(id);
  if (!existing) {
    throw new ChoreNotFoundError(id);
  }

  const now = Date.now();
  db.prepare("UPDATE chores SET active = 0, updated_at = ? WHERE id = ?").run(now, id);
}

// ── Atomic reorder (Rule 3) ────────────────────────────────────────────────

/** Atomically reorder a routine's chores.
 * Full-set validation: the incoming choreIds must EXACTLY match the routine's
 * current active chore set (same count, same ids, no missing/extra/foreign/inactive).
 * If validation fails → 400 with prior order fully intact (no partial writes).
 * The actual reorder is wrapped in a DB transaction.
 */
export function reorderChores(routineId: string, input: unknown): Chore[] {
  if (!input || typeof input !== "object" || !("choreIds" in input)) {
    throw new ChoreValidationError("Request body must include choreIds array");
  }

  const { choreIds } = input as { choreIds?: unknown };

  if (!Array.isArray(choreIds)) {
    throw new ChoreValidationError("choreIds must be an array");
  }

  const db = getDb();

  // Verify routine exists
  const routineRow = db.prepare("SELECT id FROM routines WHERE id = ?").get(routineId);
  if (!routineRow) {
    throw new RoutineNotFoundError(routineId);
  }

  // Get current active chores for this routine (by sortOrder)
  const activeChores = db
    .prepare(
      "SELECT id, sort_order FROM chores WHERE routine_id = ? AND active = 1 ORDER BY sort_order ASC"
    )
    .all(routineId) as Array<{ id: string; sort_order: number }>;

  const activeChoreIdSet = new Set(activeChores.map((c) => c.id));

  // Validate: choreIds must exactly match the active chore set
  // (same length, same ids, no missing, no extra, no inactive/foreign)
  if (choreIds.length !== activeChores.length) {
    throw new ChoreValidationError(
      `Chore ID count mismatch: expected ${activeChores.length}, got ${choreIds.length}`
    );
  }

  const choreIdSet = new Set(choreIds as string[]);
  // P1 fix: detect duplicates by comparing set size vs array length
  // (the old self-reference check choreIdSet.has(cid) was always true)
  if (choreIdSet.size !== choreIds.length) {
    throw new ChoreValidationError("Duplicate chore ID in request");
  }
  for (const cid of choreIds as string[]) {
    if (!activeChoreIdSet.has(cid)) {
      throw new ChoreValidationError(
        `Chore ID "${cid}" is not an active chore of this routine (may be inactive or foreign)`
      );
    }
  }

  // Validation passed — apply reorder atomically in a transaction
  const now = Date.now();

  db.transaction(() => {
    // Update sort_order for each chore based on the new order
    for (let i = 0; i < (choreIds as string[]).length; i++) {
      db.prepare(
        "UPDATE chores SET sort_order = ?, updated_at = ? WHERE id = ? AND routine_id = ?"
      ).run(i, now, (choreIds as string[])[i], routineId);
    }
  })();

  // Re-read and return updated chores
  const result = db
    .prepare(
      "SELECT id, routine_id, name, icon, sort_order, active FROM chores WHERE routine_id = ? AND active = 1 ORDER BY sort_order ASC"
    )
    .all(routineId) as Array<{
    id: string;
    routine_id: string;
    name: string;
    icon: string | null;
    sort_order: number;
    active: number;
  }>;

  return result.map(rowToChore);
}

// ── List active chores for a routine ───────────────────────────────────────

/** List a routine's active chores, ordered by sortOrder.
 */
export function listChores(routineId: string): Chore[] {
  const db = getDb();

  // Verify routine exists (even soft-deleted)
  const routineRow = db.prepare("SELECT id FROM routines WHERE id = ?").get(routineId);
  if (!routineRow) {
    throw new RoutineNotFoundError(routineId);
  }

  const rows = db
    .prepare(
      "SELECT id, routine_id, name, icon, sort_order, active FROM chores WHERE routine_id = ? AND active = 1 ORDER BY sort_order ASC"
    )
    .all(routineId) as Array<{
    id: string;
    routine_id: string;
    name: string;
    icon: string | null;
    sort_order: number;
    active: number;
  }>;

  return rows.map(rowToChore);
}

// ── List active routines ───────────────────────────────────────────────────

/** List active routines, ordered by their day period's start time, then name (FR-016).
 * LEFT JOIN so the ordering join can never drop a routine.
 */
export function listRoutines(): Routine[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.day_period_id, r.active
         FROM routines r
         LEFT JOIN day_periods dp ON dp.id = r.day_period_id
        WHERE r.active = 1
        ORDER BY dp.start_minutes IS NULL, dp.start_minutes ASC,
                 r.name COLLATE NOCASE ASC, r.created_at ASC`
    )
    .all() as Array<{ id: string; name: string; day_period_id: string; active: number }>;

  return rows.map(rowToRoutine);
}

// ── Assignment helpers ─────────────────────────────────────────────────────

function rowToAssignment(row: {
  id: string;
  routine_id: string;
  member_id: string;
  weekdays: string;
  active: number;
}): { id: string; memberId: string; weekdays: string[]; active: boolean } {
  return {
    id: row.id,
    memberId: row.member_id,
    weekdays: JSON.parse(row.weekdays) as string[],
    active: row.active === 1,
  };
}

function validateWeekdays(weekdays: unknown): string[] {
  if (!Array.isArray(weekdays)) {
    throw new AssignmentValidationError("weekdays must be an array");
  }
  return validateWeekdayTokens(weekdays, AssignmentValidationError);
}

// ── Assignment CRUD ────────────────────────────────────────────────────────

/** Upsert a routine assignment: links one routine to one active child on a set
 * of weekdays.
 * Validates:
 * - routineId exists (404 if not)
 * - memberId is an active child (400 if not — INV-01)
 * - weekdays entries are valid (400 if not — INV-02)
 * If an assignment for (routineId, memberId) already exists, updates it in place.
 * Otherwise inserts a new row. Returns the created/updated Assignment.
 */
export function upsertAssignment(
  routineId: string,
  memberId: string,
  weekdays: unknown,
  active: unknown
): { id: string; memberId: string; weekdays: string[]; active: boolean } {
  const db = getDb();

  // Validate routine exists FIRST (before member validation)
  const routineRow = db.prepare("SELECT id FROM routines WHERE id = ?").get(routineId);
  if (!routineRow) {
    throw new RoutineNotFoundError(`Routine "${routineId}" does not exist`);
  }

  // Validate memberId is an active child via listActiveChildren (reuse referential.ts)
  const activeChildren = listActiveChildren();
  if (!activeChildren.some((c) => c.id === memberId)) {
    throw new AssignmentValidationError(
      `Member "${memberId}" is not an active child — assignments require an active child`
    );
  }

  // Validate weekdays (INV-02)
  const parsedWeekdays = validateWeekdays(weekdays);

  // Validate active flag (null is explicit, not omitted — must be boolean or absent)
  let parsedActive = true;
  if (active !== undefined) {
    if (active === null || typeof active !== "boolean") {
      throw new AssignmentValidationError("active must be a boolean");
    }
    parsedActive = active;
  }

  const now = Date.now();

  // Check if an assignment already exists for this (routineId, memberId) pair.
  // We find ANY existing row (not just active=1) to support reactivation via upsert.
  const existing = db
    .prepare("SELECT id FROM routine_assignments WHERE routine_id = ? AND member_id = ?")
    .get(routineId, memberId) as { id: string } | undefined;

  if (existing) {
    // Update existing assignment in place (upsert semantics — never duplicate)
    db.prepare(
      "UPDATE routine_assignments SET weekdays = ?, active = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(parsedWeekdays), parsedActive ? 1 : 0, now, existing.id);

    const updated = db
      .prepare(
        "SELECT id, routine_id, member_id, weekdays, active FROM routine_assignments WHERE id = ?"
      )
      .get(existing.id) as {
      id: string;
      routine_id: string;
      member_id: string;
      weekdays: string;
      active: number;
    };

    return rowToAssignment(updated);
  }

  // Insert new assignment
  const id = randomUUID();
  db.prepare(
    "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, routineId, memberId, JSON.stringify(parsedWeekdays), parsedActive ? 1 : 0, now, now);

  return rowToAssignment({
    id,
    routine_id: routineId,
    member_id: memberId,
    weekdays: JSON.stringify(parsedWeekdays),
    active: parsedActive ? 1 : 0,
  });
}

/** Deactivate a routine assignment: sets active = 0, never deletes the row.
 * Idempotent: if the assignment exists (even if already active = 0), return success.
 * Only throws 404 if no row exists for the (routineId, memberId) pair.
 */
export function deactivateAssignment(
  routineId: string,
  memberId: string
): { id: string; memberId: string; weekdays: string[]; active: boolean } {
  const db = getDb();

  // Look up by (routineId, memberId) regardless of active state
  const existing = db
    .prepare(
      "SELECT id, routine_id, member_id, weekdays, active FROM routine_assignments WHERE routine_id = ? AND member_id = ?"
    )
    .get(routineId, memberId) as
    | {
        id: string;
        routine_id: string;
        member_id: string;
        weekdays: string;
        active: number;
      }
    | undefined;

  if (!existing) {
    throw new AssignmentNotFoundError(
      `No assignment found for routine "${routineId}" and member "${memberId}"`
    );
  }

  const now = Date.now();
  db.prepare("UPDATE routine_assignments SET active = 0, updated_at = ? WHERE id = ?").run(
    now,
    existing.id
  );

  return rowToAssignment({
    ...existing,
    active: 0,
  });
}

// ── List assignments for a routine (tolerant-read like GET routines/:id) ──

export function listRoutineAssignments(routineId: string): {
  id: string;
  memberId: string;
  weekdays: string[];
  active: boolean;
}[] {
  const db = getDb();

  // Verify routine exists
  const routineRow = db.prepare("SELECT id FROM routines WHERE id = ?").get(routineId);
  if (!routineRow) {
    throw new RoutineNotFoundError(`Routine "${routineId}" does not exist`);
  }

  const rows = db
    .prepare(
      "SELECT id, routine_id, member_id, weekdays, active FROM routine_assignments WHERE routine_id = ? ORDER BY created_at ASC"
    )
    .all(routineId) as Array<{
    id: string;
    routine_id: string;
    member_id: string;
    weekdays: string;
    active: number;
  }>;

  return rows.map(rowToAssignment);
}
// ── Daily board read ────────────────────────────────────────────────

export class BoardValidationError extends Error {}

interface ActiveAssignment {
  memberId: string;
  routineId: string;
  dayPeriodId: string;
  weekdays: string[];
}

/** All (routine_assignment × routine) pairs where BOTH are active — the exact
 * eligibility join the board composes from (an inactive routine or a
 * deactivated assignment contributes nothing, even if the other side is live).
 */
function listAllActiveAssignments(): ActiveAssignment[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ra.member_id, ra.routine_id, ra.weekdays, r.day_period_id
       FROM routine_assignments ra
       JOIN routines r ON r.id = ra.routine_id
       WHERE ra.active = 1 AND r.active = 1`
    )
    .all() as Array<{
    member_id: string;
    routine_id: string;
    weekdays: string;
    day_period_id: string;
  }>;

  return rows.map((row) => ({
    memberId: row.member_id,
    routineId: row.routine_id,
    dayPeriodId: row.day_period_id,
    weekdays: JSON.parse(row.weekdays) as string[],
  }));
}

/** Whether (choreId, memberId, date) has a completion row — the single-row-toggled model. */
function getChoreCompletion(
  choreId: string,
  memberId: string,
  date: string
): { id: string } | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
    .get(choreId, memberId, date) as { id: string } | undefined;
  return row ?? null;
}

/** Bulk-load completion rows for a member over a date range. */
function getChoreCompletionsByDate(
  memberId: string,
  startDate: string,
  endDate: string
): Map<string, Set<string>> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT chore_id, date FROM chore_completions 
       WHERE member_id = ? AND date >= ? AND date <= ?`
    )
    .all(memberId, startDate, endDate) as Array<{ chore_id: string; date: string }>;

  // Map: date -> Set of choreIds completed on that date
  const completionByDate = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!completionByDate.has(row.date)) {
      completionByDate.set(row.date, new Set());
    }
    completionByDate.get(row.date)?.add(row.chore_id);
  }
  return completionByDate;
}
/** Build the daily chore board for a given date.
 * Returns: array of BoardColumn, one per active child. Each column has all four day periods.
 */
export function getBoard(date: string): BoardColumn[] {
  if (!isStrictCalendarDate(date)) {
    throw new BoardValidationError();
  }

  const children = listActiveChildren();
  if (children.length === 0) {
    return [];
  }

  const dayPeriods = listDayPeriods();
  const tz = readHouseholdTimezone();
  const weekday = weekdayOf(date, tz);
  const assignments = listAllActiveAssignments();
  const isToday = date === toHouseholdDateString(Date.now(), tz);

  return children.map((child) => {
    const childAssignments = assignments.filter(
      (a) => a.memberId === child.id && a.weekdays.includes(weekday)
    );

    const dayPeriodsForChild: BoardDayPeriod[] = dayPeriods.map((dp) => {
      const chores: BoardChore[] = [];

      const assignmentsForPeriod = childAssignments.filter((a) => a.dayPeriodId === dp.id);

      for (const assignment of assignmentsForPeriod) {
        // listChores already filters active=1 and orders by sort_order ASC.
        for (const chore of listChores(assignment.routineId)) {
          const completion = getChoreCompletion(chore.id, child.id, date);
          chores.push({
            id: chore.id,
            name: chore.name,
            icon: chore.icon,
            completed: completion !== null,
          });
        }
      }

      return {
        id: dp.id,
        labelKey: dp.labelKey,
        chores,
      };
    });

    let streak: number | null = null;
    let todayProgress: { completed: number; total: number } | null = null;
    if (isToday) {
      streak = getStreak(child.id, date);
      const choresToday = dayPeriodsForChild.flatMap((dp) => dp.chores);
      todayProgress = {
        completed: choresToday.filter((c) => c.completed).length,
        total: choresToday.length,
      };
    }

    return {
      memberId: child.id,
      displayName: child.displayName,
      dayPeriods: dayPeriodsForChild,
      streak,
      todayProgress,
    };
  });
}

// ── Streak algorithm (— US3) ───────────────────────────────────────────

/** Format an epoch-ms instant as a household-local YYYY-MM-DD calendar date. */
function toHouseholdDateString(ms: number, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(ms));
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

/** The calendar date one day before `date` (UTC arithmetic — timezone-invariant, same as `weekdayOf`). */
function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

/** Preload each distinct routine's active chore ids once — keyed by routineId, same
 * active=1/sort_order-ASC set `listChores` returns — so the streak walk reads a map
 * instead of querying per assignment, per walked day. */
function loadChoreIdsByRoutine(assignments: ActiveAssignment[]): Map<string, string[]> {
  const choreIdsByRoutine = new Map<string, string[]>();
  for (const assignment of assignments) {
    if (choreIdsByRoutine.has(assignment.routineId)) continue;
    choreIdsByRoutine.set(
      assignment.routineId,
      listChores(assignment.routineId).map((chore) => chore.id)
    );
  }
  return choreIdsByRoutine;
}

/** All currently-scheduled chore ids for `memberId` on `date` — the same composition `getBoard` renders. */
function scheduledChoreIdsFor(
  memberId: string,
  date: string,
  tz: string,
  assignments: ActiveAssignment[],
  choreIdsByRoutine: Map<string, string[]>
): string[] {
  const weekday = weekdayOf(date, tz);
  const memberAssignments = assignments.filter(
    (a) => a.memberId === memberId && a.weekdays.includes(weekday)
  );
  const choreIds: string[] = [];
  for (const assignment of memberAssignments) {
    for (const choreId of choreIdsByRoutine.get(assignment.routineId)!) {
      choreIds.push(choreId);
    }
  }
  return choreIds;
}

type StreakDayState = "transparent" | "qualifying" | "incomplete";

/** Evaluate one day against the currently-scheduled composition using cached data:
 * transparent (nothing scheduled), qualifying (every scheduled chore has a completion row),
 * or incomplete. */
function evaluateStreakDayCached(
  memberId: string,
  date: string,
  tz: string,
  assignments: ActiveAssignment[],
  completionsByDate: Map<string, Set<string>>,
  choreIdsByRoutine: Map<string, string[]>
): StreakDayState {
  const choreIds = scheduledChoreIdsFor(memberId, date, tz, assignments, choreIdsByRoutine);
  if (choreIds.length === 0) return "transparent";
  const completedSet = completionsByDate.get(date);
  if (!completedSet) return "incomplete";
  const allComplete = choreIds.every((choreId) => completedSet.has(choreId));
  return allComplete ? "qualifying" : "incomplete";
}

/** Derived-on-read streak (FR-012/013; ROUTINES-CHORES-INV-06/09, AC-04): walk backward
 * from `asOfDate` using the SAME currently-scheduled composition `getBoard` renders. A
 * transparent day (nothing scheduled) is skipped without breaking or extending the
 * count; a fully-complete day increments and continues; the first non-transparent,
 * non-qualifying day stops the walk. `asOfDate` itself only increments the count if it
 * fully qualifies — otherwise the walk simply moves to the day before it without
 * stopping (today's incompleteness is "not yet decided", not a break).
 * Bounded at the member's `created_at` date (a member cannot have scheduled chores
 * before they existed), so a household where no routine was EVER configured for a
 * child — every day transparent, forever — still terminates and returns 0 instead of
 * scanning backward unboundedly.
 * Hoisted: tz, assignments, completionsByDate, and the chore ids for this member's
 * own active routines are loaded once per getStreak call, then passed into the
 * streak walk to avoid per-day (and per-assignment-per-day) database queries.
 */
export function getStreak(memberId: string, asOfDate: string): number {
  const db = getDb();
  const memberRow = db.prepare("SELECT created_at FROM members WHERE id = ?").get(memberId) as
    { created_at: number } | undefined;
  if (!memberRow) return 0;

  const tz = readHouseholdTimezone();
  const boundDate = toHouseholdDateString(memberRow.created_at, tz);

  if (asOfDate < boundDate) return 0;

  // Bulk load completions for the lookback window once
  const completionsByDate = getChoreCompletionsByDate(memberId, boundDate, asOfDate);
  const assignments = listAllActiveAssignments();
  // Scope the chore-id preload to this member's own routines — no need to load
  // every household member's routines to walk one member's streak.
  const memberAssignments = assignments.filter((a) => a.memberId === memberId);
  const choreIdsByRoutine = loadChoreIdsByRoutine(memberAssignments);

  let streak = 0;
  let cursor = asOfDate;

  // asOfDate is special-cased: it never stops the walk, only counts if it fully qualifies.
  if (
    evaluateStreakDayCached(
      memberId,
      cursor,
      tz,
      assignments,
      completionsByDate,
      choreIdsByRoutine
    ) === "qualifying"
  )
    streak++;
  cursor = dayBefore(cursor);

  while (cursor >= boundDate) {
    const state = evaluateStreakDayCached(
      memberId,
      cursor,
      tz,
      assignments,
      completionsByDate,
      choreIdsByRoutine
    );
    if (state === "incomplete") break;
    if (state === "qualifying") streak++;
    cursor = dayBefore(cursor);
  }

  return streak;
}
// ── Completions (— US2 complete/uncomplete) ────────────────────────────

/** True IFF (routineId, memberId, date) is currently markable — the SAME
 * eligibility join `getBoard` composes from `listAllActiveAssignments`: active
 * child, active routine, an active assignment covering date's weekday. The
 * caller separately checks the chore itself is active.
 */
function isCurrentlyScheduled(routineId: string, memberId: string, date: string): boolean {
  const activeChildren = listActiveChildren();
  if (!activeChildren.some((c) => c.id === memberId)) return false;

  const weekday = weekdayOf(date, readHouseholdTimezone());
  const assignments = listAllActiveAssignments();
  return assignments.some(
    (a) => a.memberId === memberId && a.routineId === routineId && a.weekdays.includes(weekday)
  );
}

/** Complete a chore for a member on a date — gated on current markability
 * (INV-04): active chore, active routine, an active assignment covering
 * date's weekday, and memberId an active child. `INSERT... ON CONFLICT DO
 * NOTHING` on the (member_id, chore_id, date) unique index makes repeated
 * calls idempotent — the DB constraint is the race guard,
 * not an app-level check-then-insert.
 * Emits `routines.completion_changed` ONLY after the write statement has run
 * without throwing (post-commit-only, ADR-040) — a failed write propagates
 * the error and never emits.
 */
export function completeChore(choreId: string, memberId: unknown, date: unknown): void {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new CompletionValidationError("memberId is required and must be a non-blank string");
  }
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new CompletionValidationError(`Invalid date "${String(date)}"`);
  }

  const db = getDb();
  const choreRow = db
    .prepare("SELECT id, routine_id, active FROM chores WHERE id = ?")
    .get(choreId) as { id: string; routine_id: string; active: number } | undefined;
  if (!choreRow) {
    throw new ChoreNotFoundError(choreId);
  }

  if (choreRow.active !== 1 || !isCurrentlyScheduled(choreRow.routine_id, memberId, date)) {
    throw new CompletionValidationError(
      `Chore "${choreId}" is not currently markable for member "${memberId}" on ${date}`
    );
  }

  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id, chore_id, date) DO NOTHING"
  ).run(id, choreId, memberId, date, now);

  emit("routines.completion_changed", {
    memberId,
    choreId,
    routineId: choreRow.routine_id,
    date,
    completed: true,
    timestamp: now,
  });
}

/** Uncomplete a chore for a member on a date — UNCONDITIONALLY allowed
 * (FR-009/AC-01), regardless of current markability: no *eligibility* check of
 * any kind, deliberately asymmetric with `completeChore`. A plain DELETE on
 * the (chore_id, member_id, date) key; no matching row is a no-op, not an
 * error (idempotent). Note the date is still validated symmetrically with
 * `completeChore`: a DELETE completion is a write, and the contract rejects a
 * calendar-impossible date at every write (never coerces it).
 * Emits `routines.completion_changed` post-commit (ADR-040) ONLY when the
 * DELETE actually removed a row — a no-op delete changes nothing, so it emits
 * nothing (the contract's "if a row existed" clause).
 */
export function uncompleteChore(choreId: string, memberId: unknown, date: unknown): void {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new CompletionValidationError("memberId is required and must be a non-blank string");
  }
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new CompletionValidationError(`Invalid date "${String(date)}"`);
  }

  const db = getDb();
  // Looked up ONLY for routineId (the emit payload needs it) — tolerant of a
  // soft-deleted routine/chore, since uncomplete has no eligibility gate.
  const choreRow = db.prepare("SELECT id, routine_id FROM chores WHERE id = ?").get(choreId) as
    { id: string; routine_id: string } | undefined;
  if (!choreRow) {
    throw new ChoreNotFoundError(choreId);
  }

  const result = db
    .prepare("DELETE FROM chore_completions WHERE chore_id = ? AND member_id = ? AND date = ?")
    .run(choreId, memberId, date);

  // A no-op delete (no completion existed) changes no state — emit nothing.
  if (result.changes === 0) return;

  emit("routines.completion_changed", {
    memberId,
    choreId,
    routineId: choreRow.routine_id,
    date,
    completed: false,
    timestamp: Date.now(),
  });
}
