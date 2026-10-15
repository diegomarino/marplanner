import { describe, expect, it } from "vitest";

import { weekBands } from "@/admin/daily-messages-weeks";

function window14(from: string): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
const runs = (bands: string[]) =>
  bands.reduce<[string, number][]>((acc, band) => {
    const last = acc[acc.length - 1];
    if (last && last[0] === band) last[1] += 1;
    else acc.push([band, 1]);
    return acc;
  }, []);

describe("weekBands", () => {
  it("Monday start, list starts mid-week (Thu 2026-01-15): plain lead-in, then shaded week, then plain", () => {
    expect(runs(weekBands(window14("2026-01-15"), 1))).toEqual([
      ["plain", 4],
      ["shaded", 7],
      ["plain", 3],
    ]);
  });

  it("Sunday start, list starts mid-week (Thu): lead-in is Thu-Sat", () => {
    expect(runs(weekBands(window14("2026-01-15"), 0))).toEqual([
      ["plain", 3],
      ["shaded", 7],
      ["plain", 4],
    ]);
  });

  it("list starting exactly on a Monday: first week plain, second shaded", () => {
    expect(runs(weekBands(window14("2026-01-19"), 1))).toEqual([
      ["plain", 7],
      ["shaded", 7],
    ]);
  });

  it("list starting exactly on a Sunday with Sunday start: first week plain, second shaded", () => {
    expect(runs(weekBands(window14("2026-01-18"), 0))).toEqual([
      ["plain", 7],
      ["shaded", 7],
    ]);
  });

  it("a Monday-start window under a Sunday-start household treats Monday as mid-week", () => {
    expect(runs(weekBands(window14("2026-01-19"), 0))).toEqual([
      ["plain", 6],
      ["shaded", 7],
      ["plain", 1],
    ]);
  });

  it("falls back to Monday for null, undefined and unexpected values", () => {
    const monday = weekBands(window14("2026-01-15"), 1);
    expect(weekBands(window14("2026-01-15"), null)).toEqual(monday);
    expect(weekBands(window14("2026-01-15"), undefined)).toEqual(monday);
    expect(weekBands(window14("2026-01-15"), 7)).toEqual(monday);
  });

  it("returns an empty list for no dates", () => {
    expect(weekBands([], 1)).toEqual([]);
  });
});
