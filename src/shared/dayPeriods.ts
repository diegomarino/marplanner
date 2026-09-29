import { DayPeriodDTO, PeriodId } from "./index";

// ─────────────────────────────────────────────────────────────────────
// Pure shared resolver module — no I/O, no clock, no deps
// FRs: FR-002, FR-003, FR-005, FR-006, FR-007, FR-008, FR-009
// Guarantees: DAY-PERIODS-INV-01..05, AC-01..04
// ─────────────────────────────────────────────────────────────────────

const MINUTES_IN_DAY = 1440;

export class PeriodOrderError extends Error {
  code: string;
  periodId: PeriodId;
  prevPeriodId: PeriodId;

  constructor(periodId: PeriodId, prevPeriodId: PeriodId) {
    super(
      `Period start reorder violation: "${periodId}" must be strictly less than "${prevPeriodId}".`
    );
    this.code = "period-order";
    this.periodId = periodId;
    this.prevPeriodId = prevPeriodId;
  }
}

export class PeriodUniquenessError extends Error {
  code: string;
  periodId1: PeriodId;
  periodId2: PeriodId;

  constructor(periodId1: PeriodId, periodId2: PeriodId) {
    super(
      `Period start uniqueness violation: "${periodId1}" and "${periodId2}" have the same start time.`
    );
    this.code = "period-uniqueness";
    this.periodId1 = periodId1;
    this.periodId2 = periodId2;
  }
}

/** Convert "HH:MM" string to minutes since midnight.
 * Validates 00:00..23:59 (0..1439).
 * @throws {Error} if format invalid or out of range
 */
export function hhmmToMinutes(hhmm: string): number {
  const match = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid time format: "${hhmm}". Expected "HH:MM".`);
  }

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23) {
    throw new Error(`Hour out of range: ${hour}. Must be 0..23.`);
  }
  if (minute < 0 || minute > 59) {
    throw new Error(`Minute out of range: ${minute}. Must be 0..59.`);
  }

  return hour * 60 + minute;
}

/** Convert minutes since midnight to "HH:MM" string.
 * Validates 0..1439 (midnight to 23:59).
 * @throws {Error} if minutes out of range
 */
export function minutesToHhmm(min: number): string {
  if (min < 0 || min >= MINUTES_IN_DAY) {
    throw new Error(`Minutes out of range: ${min}. Must be 0..1439.`);
  }

  const hour = Math.floor(min / 60);
  const minute = min % 60;

  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

/** Validate that a candidate period catalog has strictly increasing starts in canonical sortOrder.
 * Enforces INV-03 / AC-02: strict ordering and uniqueness.
 * night (sortOrder 3) is unbounded above — it owns the midnight wrap.
 * @throws {Error} if uniqueness or strict order violated
 */
export function validateStartOrdering(periods: DayPeriodDTO[]): void {
  const sorted = [...periods].sort((a, b) => a.sortOrder - b.sortOrder);
  const starts = sorted.map((p) => ({ id: p.id, start: hhmmToMinutes(p.start) }));

  for (let i = 0; i < starts.length - 1; i++) {
    if (starts[i].start === starts[i + 1].start) {
      throw new PeriodUniquenessError(starts[i].id, starts[i + 1].id);
    }
    if (starts[i].start > starts[i + 1].start) {
      throw new PeriodOrderError(starts[i + 1].id, starts[i].id);
    }
  }
}

/** Derive the end of a period as the next period's start in canonical cycle.
 * Enforces INV-02 / AC-04: circular tiling, no stored end times.
 * night (sortOrder 3) wraps to morning's start via mod-4.
 * @returns the derived end in minutes since midnight
 */
export function derivedEndMinutes(periods: DayPeriodDTO[], id: PeriodId): number {
  const period = periods.find((p) => p.id === id);
  if (!period) {
    throw new Error(`Unknown period ID: "${id}".`);
  }

  const nextSortOrder = (period.sortOrder + 1) % 4;
  const nextPeriod = periods.find((p) => p.sortOrder === nextSortOrder);
  if (!nextPeriod) {
    throw new Error(`Missing period with sortOrder ${nextSortOrder}.`);
  }

  return hhmmToMinutes(nextPeriod.start);
}

/** Resolve the active period at a given wall-clock minute in household timezone.
 * Returns the period with the latest start <= nowMinutes.
 * If now is before the first period's start, wraps to night (INV-05 / AC-03).
 * This is the ONLY logic for active-period resolution — shared by server and client.
 * @returns PeriodId of the active period
 */
export function resolveActivePeriod(periods: DayPeriodDTO[], nowMinutes: number): PeriodId {
  if (periods.length === 0) {
    throw new Error("Cannot resolve active period: no periods provided.");
  }

  const sorted = [...periods].sort((a, b) => a.sortOrder - b.sortOrder);
  const starts = sorted.map((p) => ({ id: p.id, start: hhmmToMinutes(p.start) }));

  // Find the latest period whose start <= nowMinutes
  let active = starts[starts.length - 1];
  for (const p of starts) {
    if (p.start <= nowMinutes) {
      active = p;
    }
  }

  return active.id;
}
