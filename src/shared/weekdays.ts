export const CANONICAL_WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayCode = (typeof CANONICAL_WEEKDAY_ORDER)[number];

export function isWeekday(value: unknown): value is WeekdayCode {
  return typeof value === "string" && CANONICAL_WEEKDAY_ORDER.includes(value as WeekdayCode);
}

/** Validate tokens; each domain retains its empty-set, duplicate and ordering policy. */
export function validateWeekdays(
  value: unknown,
  ValidationError: new (message: string) => Error = Error
): WeekdayCode[] {
  if (!Array.isArray(value)) throw new ValidationError("weekdays must be an array");
  for (const day of value) {
    if (!isWeekday(day)) {
      throw new ValidationError(
        `Invalid weekday "${String(day)}": must be one of mon, tue, wed, thu, fri, sat, sun`
      );
    }
  }
  return value as WeekdayCode[];
}
