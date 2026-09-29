import { getDb } from "../../db/client";
import type { DayPeriodDTO, PeriodId } from "../../../shared";
import {
  hhmmToMinutes,
  minutesToHhmm,
  resolveActivePeriod,
  validateStartOrdering,
} from "../../../shared/dayPeriods";
import { z } from "zod";

export function listDayPeriods(): DayPeriodDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, label_key, start_minutes, sort_order FROM day_periods ORDER BY sort_order ASC"
    )
    .all() as Array<{
    id: string;
    label_key: string;
    start_minutes: number;
    sort_order: number;
  }>;

  return rows.map((r) => ({
    id: r.id as DayPeriodDTO["id"],
    labelKey: r.label_key,
    start: minutesToHhmm(r.start_minutes),
    sortOrder: r.sort_order,
  }));
}

const editStartSchema = z
  .object({
    start: z
      .string()
      .min(1)
      .regex(/^\d{2}:\d{2}$/),
  })
  .strict();

export class DayPeriodValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayPeriodValidationError";
  }
}

export class DayPeriodNotFoundError extends Error {
  constructor(id: string) {
    super(`Day period not found: ${id}`);
    this.name = "DayPeriodNotFoundError";
  }
}

export function editDayPeriodStart(id: string, body: unknown): DayPeriodDTO {
  const parsed = editStartSchema.safeParse(body);

  if (!parsed.success) {
    throw new DayPeriodValidationError(parsed.error.message);
  }

  const { start } = parsed.data;
  let startMinutes: number;
  try {
    startMinutes = hhmmToMinutes(start);
  } catch {
    throw new DayPeriodValidationError(`Invalid time format: ${start}`);
  }

  const db = getDb();

  const row = db
    .prepare("SELECT id, label_key, start_minutes, sort_order FROM day_periods WHERE id = ?")
    .get(id) as
    | {
        id: string;
        label_key: string;
        start_minutes: number;
        sort_order: number;
      }
    | undefined;

  if (!row) {
    throw new DayPeriodNotFoundError(id);
  }

  const periods = listDayPeriods();
  const updatedPeriods = periods.map((p) => (p.id === id ? { ...p, start } : p));

  try {
    validateStartOrdering(updatedPeriods);
  } catch (e) {
    throw new DayPeriodValidationError(e instanceof Error ? e.message : "Validation failed");
  }

  db.prepare("UPDATE day_periods SET start_minutes = ? WHERE id = ?").run(startMinutes, id);

  return {
    id: row.id as DayPeriodDTO["id"],
    labelKey: row.label_key,
    start: minutesToHhmm(startMinutes),
    sortOrder: row.sort_order,
  };
}

export function resolveActive(nowMinutes: number): PeriodId {
  return resolveActivePeriod(listDayPeriods(), nowMinutes);
}
