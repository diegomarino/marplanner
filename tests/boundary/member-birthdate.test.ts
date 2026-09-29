import { describe, it, expect } from "vitest";
import { parseBirthDate, isBirthdayToday } from "../../src/server/modules/members/birthdate";

describe("parseBirthDate", () => {
  it("accepts {2,29} with no year (leap-agnostic when no year)", () => {
    expect(parseBirthDate.safeParse({ month: 2, day: 29 })).toEqual({
      success: true,
      data: { month: 2, day: 29, year: null },
    });
  });

  it("accepts {2,29,year:null} (explicit null year = leap-agnostic)", () => {
    expect(parseBirthDate.safeParse({ month: 2, day: 29, year: null })).toEqual({
      success: true,
      data: { month: 2, day: 29, year: null },
    });
  });

  it("accepts {2,29,2020} (leap year)", () => {
    expect(parseBirthDate.safeParse({ month: 2, day: 29, year: 2020 })).toEqual({
      success: true,
      data: { month: 2, day: 29, year: 2020 },
    });
  });

  it("rejects {2,29,2021} (non-leap year)", () => {
    const result = parseBirthDate.safeParse({ month: 2, day: 29, year: 2021 });
    expect(result.success).toBe(false);
  });

  it("rejects {2,30} (February never has 30 days)", () => {
    const result = parseBirthDate.safeParse({ month: 2, day: 30 });
    expect(result.success).toBe(false);
  });

  it("rejects partial {month:5} (day is required)", () => {
    const result = parseBirthDate.safeParse({ month: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects partial {day:10} (month is required)", () => {
    const result = parseBirthDate.safeParse({ day: 10 });
    expect(result.success).toBe(false);
  });

  it("treats null as clear (valid — means no birth date)", () => {
    const result = parseBirthDate.safeParse(null);
    expect(result.success).toBe(true);
  });

  it("accepts {1,15} (valid month/day)", () => {
    expect(parseBirthDate.safeParse({ month: 1, day: 15 })).toEqual({
      success: true,
      data: { month: 1, day: 15, year: null },
    });
  });

  it("accepts {12,31} (valid month/day)", () => {
    expect(parseBirthDate.safeParse({ month: 12, day: 31 })).toEqual({
      success: true,
      data: { month: 12, day: 31, year: null },
    });
  });

  it("accepts {4,30} (April has 30 days)", () => {
    expect(parseBirthDate.safeParse({ month: 4, day: 30 })).toEqual({
      success: true,
      data: { month: 4, day: 30, year: null },
    });
  });

  it("rejects {4,31} (April has only 30 days)", () => {
    const result = parseBirthDate.safeParse({ month: 4, day: 31 });
    expect(result.success).toBe(false);
  });

  it("accepts {9,30} (September has 30 days)", () => {
    expect(parseBirthDate.safeParse({ month: 9, day: 30 })).toEqual({
      success: true,
      data: { month: 9, day: 30, year: null },
    });
  });

  it("accepts {11,30} (November has 30 days)", () => {
    expect(parseBirthDate.safeParse({ month: 11, day: 30 })).toEqual({
      success: true,
      data: { month: 11, day: 30, year: null },
    });
  });

  it("accepts {1,31} (January has 31 days)", () => {
    expect(parseBirthDate.safeParse({ month: 1, day: 31 })).toEqual({
      success: true,
      data: { month: 1, day: 31, year: null },
    });
  });

  it("accepts {7,31} (July has 31 days)", () => {
    expect(parseBirthDate.safeParse({ month: 7, day: 31 })).toEqual({
      success: true,
      data: { month: 7, day: 31, year: null },
    });
  });

  it("rejects {7,32} (July has only 31 days)", () => {
    const result = parseBirthDate.safeParse({ month: 7, day: 32 });
    expect(result.success).toBe(false);
  });

  it("accepts {2,28,2021} (non-leap Feb 28 is valid)", () => {
    expect(parseBirthDate.safeParse({ month: 2, day: 28, year: 2021 })).toEqual({
      success: true,
      data: { month: 2, day: 28, year: 2021 },
    });
  });

  it("rejects {2,29,2100} (divisible by 100 but not 400)", () => {
    const result = parseBirthDate.safeParse({ month: 2, day: 29, year: 2100 });
    expect(result.success).toBe(false);
  });

  it("accepts {2,29,2000} (divisible by 400)", () => {
    expect(parseBirthDate.safeParse({ month: 2, day: 29, year: 2000 })).toEqual({
      success: true,
      data: { month: 2, day: 29, year: 2000 },
    });
  });

  it("rejects {2,29,1900} (divisible by 100 but not 400)", () => {
    const result = parseBirthDate.safeParse({ month: 2, day: 29, year: 1900 });
    expect(result.success).toBe(false);
  });

  it("accepts {6,15,2023} (June has 30 days, day 15 is valid)", () => {
    expect(parseBirthDate.safeParse({ month: 6, day: 15, year: 2023 })).toEqual({
      success: true,
      data: { month: 6, day: 15, year: 2023 },
    });
  });

  it("rejects {month:0,day:10} (month must be >= 1)", () => {
    const result = parseBirthDate.safeParse({ month: 0, day: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects {month:13,day:10} (month must be <= 12)", () => {
    const result = parseBirthDate.safeParse({ month: 13, day: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects {month:5,day:0} (day must be >= 1)", () => {
    const result = parseBirthDate.safeParse({ month: 5, day: 0 });
    expect(result.success).toBe(false);
  });
});

describe("isBirthdayToday", () => {
  it("returns true when month and day match (year null)", () => {
    const result = isBirthdayToday({ month: 3, day: 15, year: null }, { month: 3, day: 15 });
    expect(result).toBe(true);
  });

  it("returns true when month and day match (year present)", () => {
    const result = isBirthdayToday({ month: 3, day: 15, year: 1980 }, { month: 3, day: 15 });
    expect(result).toBe(true);
  });

  it("returns false when month mismatch (day matches)", () => {
    const result = isBirthdayToday({ month: 3, day: 15, year: null }, { month: 4, day: 15 });
    expect(result).toBe(false);
  });

  it("returns false when day mismatch (month matches)", () => {
    const result = isBirthdayToday({ month: 3, day: 15, year: null }, { month: 3, day: 20 });
    expect(result).toBe(false);
  });

  it("returns false when both month and day mismatch", () => {
    const result = isBirthdayToday({ month: 3, day: 15, year: null }, { month: 4, day: 20 });
    expect(result).toBe(false);
  });

  it("returns false when birthDate is null", () => {
    const result = isBirthdayToday(null, { month: 5, day: 5 });
    expect(result).toBe(false);
  });

  it("proves purity: result tracks passed tzNow (June 15), not real date", () => {
    const result = isBirthdayToday({ month: 6, day: 15, year: null }, { month: 6, day: 15 });
    expect(result).toBe(true);
  });

  it("proves purity: different tzNow returns false (January 1), proves no clock used", () => {
    const result = isBirthdayToday({ month: 6, day: 15, year: null }, { month: 1, day: 1 });
    expect(result).toBe(false);
  });

  it("proves purity: February 29 (leap-agnostic), proves no internal clock", () => {
    const result = isBirthdayToday({ month: 2, day: 29, year: null }, { month: 2, day: 29 });
    expect(result).toBe(true);
  });
});
