/** Days per month (non-leap year index 0 = placeholder, indices 1-12 used).
 * Index 0 is never accessed - months are 1-indexed.
 */
const DAYS_IN_MONTH: number[] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Check if a year is a leap year.
 * Rule: divisible by 4 AND (not divisible by 100 OR divisible by 400).
 */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Get the number of days in a month, accounting for leap years when year is provided.
 */
function getDaysInMonth(month: number, year?: number | null): number {
  if (year === undefined || year === null) {
    // leap-agnostic: treat February as having 29 days when no year is given
    if (month === 2) {
      return 29;
    }
    return DAYS_IN_MONTH[month];
  }

  if (month === 2 && isLeapYear(year)) {
    return 29;
  }

  return DAYS_IN_MONTH[month];
}

/** Parse and validate a birth date.
 * - { month, day } with no year: valid if day <= days-in-month for that month (Feb = 29, leap-agnostic).
 * - { month, day, year }: valid only if day <= actual days-in-month for that (month, year).
 * - Partial input ({ month } only or { day } only): invalid.
 * - A whole value of null: valid (means "clear" / no birth date).
 */
import { z } from "zod";

export const parseBirthDate = z.union([
  z.null(),
  z
    .object({
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1),
      year: z.number().int().nullable().optional(),
    })
    .superRefine((obj, ctx) => {
      const maxDay = getDaysInMonth(obj.month, obj.year ?? null);
      if (obj.day > maxDay) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid birth date: day is not valid for the given month and year.",
          path: ["day"],
        });
      }
    })
    .transform((obj) => ({ month: obj.month, day: obj.day, year: obj.year ?? null })),
]);

/** Pure comparator to check if a birth date matches the current month/day.
 * NO Date/Intl/Date.now usage inside - tzNow must be passed as { month, day }.
 * Returns true only if both month AND day match (year is ignored).
 */
export function isBirthdayToday(
  birthDate: { month: number; day: number; year: number | null } | null,
  tzNow: { month: number; day: number }
): boolean {
  if (birthDate === null) {
    return false;
  }

  return birthDate.month === tzNow.month && birthDate.day === tzNow.day;
}
