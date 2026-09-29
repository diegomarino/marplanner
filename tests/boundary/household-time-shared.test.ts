import { describe, it, expect } from "vitest";
import { nextOccurrenceInTz, nextRuleOccurrence } from "../../src/shared/householdTime";

/** pure tests for the shared tz-math module exercised
 * directly from the client side of the import graph — i.e. NOT through
 * `src/server/lib/household-date.ts`'s re-export path (that path is covered,
 * unchanged, by `tests/boundary/household-date.test.ts`). All inputs are pure
 * `nowMs` parameters — no `Date.now`/system-clock mocking needed anywhere here
 * (Constitution IV: frozen/injected clocks).
 */
describe("household-time-shared (slice-015 T001) — nextRuleOccurrence", () => {
  describe("weekday filter", () => {
    it("skips a non-listed weekday and picks the next listed one", () => {
      // 2026-08-10 is a Monday, 2026-08-12 a Wednesday (Europe/Madrid, no DST edge).
      const nowMs = Date.UTC(2026, 7, 10, 6, 0, 0); // Monday 08:00 local (CEST, +2h)
      const result = nextRuleOccurrence(
        { time: "09:00", weekDays: ["wed"] },
        "Europe/Madrid",
        nowMs
      );
      // Wednesday 2026-08-12 09:00 CEST = 07:00Z.
      expect(result).toBe(Date.UTC(2026, 7, 12, 7, 0, 0));
    });

    it("picks the MIN occurrence across several listed weekdays (chronological scan)", () => {
      // Monday 2026-08-10, already past 09:00 local — the walker must roll to the
      // NEXT listed weekday (Wednesday), not re-fire the same Monday.
      const nowMs = Date.UTC(2026, 7, 10, 8, 0, 0); // Monday 10:00 local (CEST, +2h)
      const result = nextRuleOccurrence(
        { time: "09:00", weekDays: ["mon", "wed", "fri"] },
        "Europe/Madrid",
        nowMs
      );
      expect(result).toBe(Date.UTC(2026, 7, 12, 7, 0, 0)); // Wednesday 2026-08-12 09:00 CEST
    });

    it("returns null for an empty weekday set (no listed day to fire on)", () => {
      const nowMs = Date.UTC(2026, 7, 10, 6, 0, 0);
      expect(
        nextRuleOccurrence({ time: "09:00", weekDays: [] }, "Europe/Madrid", nowMs)
      ).toBeNull();
    });
  });

  describe("+24h weekday trap across a spring-forward day (v1 bug, FR-008/edge-cases)", () => {
    it("steps by HOUSEHOLD-CALENDAR day, not a literal UTC +24h, across America/New_York's 2026-03-08 spring-forward Sunday", () => {
      // 2026-03-08 (Sunday) is the US spring-forward day; a naive epoch+24h step from
      // a pre-transition instant lands on a wall-clock reading that is NOT exactly
      // 24h later locally (the local day is only 23h long), which can mis-derive the
      // following day's weekday. `nextRuleOccurrence` must still resolve Monday
      // 2026-03-09's occurrence correctly by stepping HOUSEHOLD-calendar days
      // (`addOneLocalDay`) rather than adding a fixed millisecond offset.
      const nowMs = Date.UTC(2026, 2, 7, 12, 0, 0); // Saturday 2026-03-07, well before the transition
      const result = nextRuleOccurrence(
        { time: "09:00", weekDays: ["mon"] },
        "America/New_York",
        nowMs
      );
      // Monday 2026-03-09 09:00 EDT (-4h, post-transition) = 13:00Z.
      expect(result).toBe(Date.UTC(2026, 2, 9, 13, 0, 0));
    });
  });

  describe("DST gap/repeat delegation spot-checks (composed from nextOccurrenceInTz's primitives)", () => {
    it("delegates the spring-forward GAP policy correctly (Europe/Madrid 2026-03-29, a Sunday)", () => {
      const nowMs = Date.UTC(2026, 2, 28, 12, 0, 0); // Saturday, well before the transition
      const ruleResult = nextRuleOccurrence(
        { time: "02:30", weekDays: ["sun"] },
        "Europe/Madrid",
        nowMs
      );
      // Must match nextOccurrenceInTz's own gap resolution exactly (same underlying
      // primitives) — the exact transition instant per
      // tests/boundary/household-date.test.ts.
      const directResult = nextOccurrenceInTz("02:30", "Europe/Madrid", nowMs);
      expect(ruleResult).toBe(directResult);
      expect(ruleResult).toBe(Date.UTC(2026, 2, 29, 1, 0, 0));
    });

    it("delegates the fall-back REPEAT policy correctly (Europe/Madrid 2026-10-25, a Sunday) — fires on the FIRST occurrence only", () => {
      const nowMs = Date.UTC(2026, 9, 24, 12, 0, 0); // Saturday, well before the transition
      const ruleResult = nextRuleOccurrence(
        { time: "02:30", weekDays: ["sun"] },
        "Europe/Madrid",
        nowMs
      );
      const directResult = nextOccurrenceInTz("02:30", "Europe/Madrid", nowMs);
      expect(ruleResult).toBe(directResult);
      expect(ruleResult).toBe(Date.UTC(2026, 9, 25, 0, 30, 0));
    });
  });

  describe("invalid-tz → null (INV-11, no throw)", () => {
    it("returns null instead of throwing for a garbage timezone string", () => {
      const nowMs = Date.UTC(2026, 7, 10, 6, 0, 0);
      expect(() =>
        nextRuleOccurrence({ time: "09:00", weekDays: ["mon"] }, "Not/ARealZone", nowMs)
      ).not.toThrow();
      expect(
        nextRuleOccurrence({ time: "09:00", weekDays: ["mon"] }, "Not/ARealZone", nowMs)
      ).toBeNull();
    });

    it("returns null instead of throwing for an empty-string timezone", () => {
      const nowMs = Date.UTC(2026, 7, 10, 6, 0, 0);
      expect(nextRuleOccurrence({ time: "09:00", weekDays: ["mon"] }, "", nowMs)).toBeNull();
    });
  });
});

// Discriminating case for the +24h weekday trap: near local
// midnight in America/New_York on the eve of spring-forward, naive +86400000 stepping skips
// the 23-hour Sunday entirely and lands a full week late. addOneLocalDay must not.
it("+24h trap (discriminating): Sat 23:30 local NY before the spring-forward Sunday still finds Sunday 10:00", () => {
  const nowMs = Date.UTC(2026, 2, 8, 4, 30); // Sat 2026-03-07 23:30 America/New_York
  const result = nextRuleOccurrence(
    { time: "10:00", weekDays: ["sun"] },
    "America/New_York",
    nowMs
  );
  expect(result).toBe(Date.UTC(2026, 2, 8, 14, 0)); // Sun 10:00 EDT — not a week later
});
