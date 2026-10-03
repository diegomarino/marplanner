import { describe, it, expect } from "vitest";
import type { DayPeriodDTO } from "../../src/shared/index";
import {
  hhmmToMinutes,
  minutesToHhmm,
  validateStartOrdering,
  derivedEndMinutes,
  resolveActivePeriod,
} from "../../src/shared/dayPeriods";

/** / — Day Periods resolver unit tests (RED first).
 * WHITE-BOX: Pure functions only, no I/O/clock/deps.
 * RED-BY-DESIGN: Implemented in to green the suite.
 * FRs realized: FR-002, FR-003, FR-005, FR-006, FR-007, FR-008, FR-009
 * Guarantees traced: DAY-PERIODS-INV-01..05, AC-01..04
 */

describe("day-periods-resolver (RED first, turns green)", () => {
  // ──────────────────────────────────────────────────────────────────
  // Test fixtures: seeded defaults (ADR-011)
  // ──────────────────────────────────────────────────────────────────

  const seed: DayPeriodDTO[] = [
    { id: "morning", labelKey: "dayPeriod.morning", start: "05:00", sortOrder: 0 },
    { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
    { id: "evening", labelKey: "dayPeriod.evening", start: "18:00", sortOrder: 2 },
    { id: "night", labelKey: "dayPeriod.night", start: "21:00", sortOrder: 3 },
  ];

  describe("hhmmToMinutes / minutesToHhmm", () => {
    it("round-trips 05:00 → 300", () => {
      expect(hhmmToMinutes("05:00")).toBe(300);
      expect(minutesToHhmm(300)).toBe("05:00");
    });

    it("round-trips 12:00 → 720", () => {
      expect(hhmmToMinutes("12:00")).toBe(720);
      expect(minutesToHhmm(720)).toBe("12:00");
    });

    it("round-trips 18:00 → 1080", () => {
      expect(hhmmToMinutes("18:00")).toBe(1080);
      expect(minutesToHhmm(1080)).toBe("18:00");
    });

    it("round-trips 21:00 → 1260", () => {
      expect(hhmmToMinutes("21:00")).toBe(1260);
      expect(minutesToHhmm(1260)).toBe("21:00");
    });

    it("round-trips 00:00 → 0", () => {
      expect(hhmmToMinutes("00:00")).toBe(0);
      expect(minutesToHhmm(0)).toBe("00:00");
    });

    it("round-trips 23:59 → 1439", () => {
      expect(hhmmToMinutes("23:59")).toBe(1439);
      expect(minutesToHhmm(1439)).toBe("23:59");
    });

    it("round-trips single-digit hours with leading zero 02:30 → 150", () => {
      expect(hhmmToMinutes("02:30")).toBe(150);
      expect(minutesToHhmm(150)).toBe("02:30");
    });

    it("round-trips single-digit minutes 14:05 → 845", () => {
      expect(hhmmToMinutes("14:05")).toBe(845);
      expect(minutesToHhmm(845)).toBe("14:05");
    });

    it("round-trips 04:59 → 299 (before-first-start boundary)", () => {
      expect(hhmmToMinutes("04:59")).toBe(299);
      expect(minutesToHhmm(299)).toBe("04:59");
    });

    it("round-trips 02:00 → 120 (wrap boundary)", () => {
      expect(hhmmToMinutes("02:00")).toBe(120);
      expect(minutesToHhmm(120)).toBe("02:00");
    });

    it("round-trips 23:00 → 1380 (night band)", () => {
      expect(hhmmToMinutes("23:00")).toBe(1380);
      expect(minutesToHhmm(1380)).toBe("23:00");
    });

    it("rejects empty string", () => {
      expect(() => hhmmToMinutes("")).toThrow();
    });

    it("rejects missing colon", () => {
      expect(() => hhmmToMinutes("0500")).toThrow();
    });

    it("rejects wrong colon position", () => {
      expect(() => hhmmToMinutes(":05:00")).toThrow();
    });

    it("rejects hour>23", () => {
      expect(() => hhmmToMinutes("24:00")).toThrow();
    });

    it("rejects hour<0", () => {
      expect(() => hhmmToMinutes("-1:00")).toThrow();
    });

    it("rejects minute>59", () => {
      expect(() => hhmmToMinutes("05:60")).toThrow();
    });

    it("rejects minute<0", () => {
      expect(() => hhmmToMinutes("05:-1")).toThrow();
    });

    it("rejects non-numeric hour", () => {
      expect(() => hhmmToMinutes("ab:00")).toThrow();
    });

    it("rejects non-numeric minute", () => {
      expect(() => hhmmToMinutes("05:cd")).toThrow();
    });

    it("rejects minutes<0 (minutesToHhmm)", () => {
      expect(() => minutesToHhmm(-1)).toThrow();
    });

    it("rejects minutes>1439 (minutesToHhmm)", () => {
      expect(() => minutesToHhmm(1440)).toThrow();
    });
  });

  describe("validateStartOrdering", () => {
    it("accepts strictly-increasing candidate (seed order)", () => {
      expect(() => validateStartOrdering(seed)).not.toThrow();
    });

    it("accepts strictly-increasing candidate (reversed sortOrder)", () => {
      const reversed = seed.slice().sort((a, b) => b.sortOrder - a.sortOrder);
      expect(() => validateStartOrdering(reversed)).not.toThrow();
    });

    it("accepts strictly-increasing candidate (arbitrary order)", () => {
      const arbitrary = [seed[2], seed[0], seed[3], seed[1]];
      expect(() => validateStartOrdering(arbitrary)).not.toThrow();
    });

    it("throws on equal-neighbour (uniqueness violation)", () => {
      const candidate = seed.map((p) => ({ ...p, start: p.start }));
      candidate[0].start = "12:00"; // same as afternoon (sortOrder 1)
      expect(() => validateStartOrdering(candidate)).toThrow("uniqueness");
    });

    it("throws on crossed-neighbour (reorder violation) — pull afternoon earlier than morning", () => {
      const candidate = seed.map((p) => ({ ...p, start: p.start }));
      candidate[1].start = "04:00"; // afternoon before morning
      expect(() => validateStartOrdering(candidate)).toThrow("reorder");
    });

    it("throws on crossed-neighbour (reorder violation) — push evening later than night", () => {
      const candidate = seed.map((p) => ({ ...p, start: p.start }));
      candidate[2].start = "23:00"; // evening after night
      expect(() => validateStartOrdering(candidate)).toThrow("reorder");
    });

    it("throws on equal-neighbour (any pair)", () => {
      const candidate = seed.map((p) => ({ ...p, start: p.start }));
      candidate[2].start = "12:00"; // evening same as afternoon
      expect(() => validateStartOrdering(candidate)).toThrow("uniqueness");
    });
  });

  describe("derivedEndMinutes", () => {
    it("returns next period's start by sortOrder (morning → afternoon)", () => {
      expect(derivedEndMinutes(seed, "morning")).toBe(720);
    });

    it("returns next period's start by sortOrder (afternoon → evening)", () => {
      expect(derivedEndMinutes(seed, "afternoon")).toBe(1080);
    });

    it("returns next period's start by sortOrder (evening → night)", () => {
      expect(derivedEndMinutes(seed, "evening")).toBe(1260);
    });

    it("returns next period's start by sortOrder (night → morning mod-4 wrap)", () => {
      expect(derivedEndMinutes(seed, "night")).toBe(300);
    });

    it("handles arbitrary period order", () => {
      const reversed = seed.slice().sort((a, b) => b.sortOrder - a.sortOrder);
      expect(derivedEndMinutes(reversed, "night")).toBe(300);
    });
  });

  describe("resolveActivePeriod", () => {
    it("returns latest start <= now (12:00 → afternoon)", () => {
      expect(resolveActivePeriod(seed, 720)).toBe("afternoon");
    });

    it("returns latest start <= now (12:01 → afternoon)", () => {
      expect(resolveActivePeriod(seed, 721)).toBe("afternoon");
    });

    it("returns latest start <= now (18:00 → evening)", () => {
      expect(resolveActivePeriod(seed, 1080)).toBe("evening");
    });

    it("returns latest start <= now (21:00 → night)", () => {
      expect(resolveActivePeriod(seed, 1260)).toBe("night");
    });

    it("returns latest start <= now (23:00 → night)", () => {
      expect(resolveActivePeriod(seed, 1380)).toBe("night");
    });

    it("returns latest start <= now (02:00 → night wrap)", () => {
      expect(resolveActivePeriod(seed, 120)).toBe("night");
    });

    it("returns latest start <= now (04:59 → night before first start)", () => {
      expect(resolveActivePeriod(seed, 299)).toBe("night");
    });

    it("returns latest start <= now (05:00 → morning, start-inclusive)", () => {
      expect(resolveActivePeriod(seed, 300)).toBe("morning");
    });

    it("returns latest start <= now (06:00 → morning)", () => {
      expect(resolveActivePeriod(seed, 360)).toBe("morning");
    });

    it("returns latest start <= now (13:00 → afternoon)", () => {
      expect(resolveActivePeriod(seed, 780)).toBe("afternoon");
    });

    it("returns latest start <= now (19:00 → evening)", () => {
      expect(resolveActivePeriod(seed, 1140)).toBe("evening");
    });

    it("returns latest start <= now (22:00 → night)", () => {
      expect(resolveActivePeriod(seed, 1320)).toBe("night");
    });

    it("every sampled minute maps to exactly one period (no gap/overlap)", () => {
      const map = new Map<string, number>();
      for (let minute = 0; minute < 1440; minute++) {
        const period = resolveActivePeriod(seed, minute);
        map.set(period, (map.get(period) ?? 0) + 1);
      }
      expect(map.size).toBe(4);
      expect(map.get("morning")).toBe(720 - 300); // 05:00..11:59 → 420 minutes
      expect(map.get("afternoon")).toBe(1080 - 720); // 12:00..17:59 → 360 minutes
      expect(map.get("evening")).toBe(1260 - 1080); // 18:00..20:59 → 180 minutes
      expect(map.get("night")).toBe(300 + (1440 - 1260)); // 21:00..04:59 → 420 minutes
    });

    it("handles arbitrary period order", () => {
      const reversed = seed.slice().sort((a, b) => b.sortOrder - a.sortOrder);
      expect(resolveActivePeriod(reversed, 720)).toBe("afternoon");
    });
  });
});
