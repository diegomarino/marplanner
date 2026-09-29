import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import {
  isStrictCalendarDate,
  readHouseholdTimezone,
  weekdayOf,
  nextOccurrenceInTz,
  todayInHouseholdTz,
} from "../../src/server/lib/household-date";

describe("household-date (T004 RED tests, T005 implementation)", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isStrictCalendarDate", () => {
    it("accepts a valid calendar date", () => {
      expect(isStrictCalendarDate("2026-08-09")).toBe(true);
    });

    it("accepts a leap year date", () => {
      expect(isStrictCalendarDate("2024-02-29")).toBe(true);
    });

    it("rejects an impossible date (Feb 30)", () => {
      expect(isStrictCalendarDate("2025-02-30")).toBe(false);
    });

    it("rejects an invalid month (13)", () => {
      expect(isStrictCalendarDate("2025-13-01")).toBe(false);
    });

    it("rejects malformed strings", () => {
      expect(isStrictCalendarDate("abc")).toBe(false);
      expect(isStrictCalendarDate("2025-8-9")).toBe(false);
      expect(isStrictCalendarDate("2025/08/09")).toBe(false);
    });
  });

  describe("readHouseholdTimezone", () => {
    it("returns Europe/Madrid when no locale settings object exists", () => {
      expect(readHouseholdTimezone()).toBe("Europe/Madrid");
    });

    it("returns the persisted timezone when a locale settings object exists", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
        )
        .run(JSON.stringify({ timezone: "America/New_York" }), Date.now());
      expect(readHouseholdTimezone()).toBe("America/New_York");
    });

    it("ignores other fields and returns only the timezone", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
        )
        .run(JSON.stringify({ timezone: "Asia/Tokyo", language: "ja" }), Date.now());
      expect(readHouseholdTimezone()).toBe("Asia/Tokyo");
    });
  });

  describe("weekdayOf", () => {
    it("handles a DST spring-forward boundary correctly (2026-03-29 in Europe/Madrid)", () => {
      // 2026-03-29 is a Sunday in Europe/Madrid (spring-forward happens that day)
      // The calendar date determines the weekday, not UTC-shifted day
      expect(weekdayOf("2026-03-29", "Europe/Madrid")).toBe("sun");
    });

    it("maps all 7 canonical weekday codes", () => {
      // 2026-08-10 = Monday
      expect(weekdayOf("2026-08-10", "Europe/Madrid")).toBe("mon");
      // 2026-08-11 = Tuesday
      expect(weekdayOf("2026-08-11", "Europe/Madrid")).toBe("tue");
      // 2026-08-12 = Wednesday
      expect(weekdayOf("2026-08-12", "Europe/Madrid")).toBe("wed");
      // 2026-08-13 = Thursday
      expect(weekdayOf("2026-08-13", "Europe/Madrid")).toBe("thu");
      // 2026-08-14 = Friday
      expect(weekdayOf("2026-08-14", "Europe/Madrid")).toBe("fri");
      // 2026-08-15 = Saturday
      expect(weekdayOf("2026-08-15", "Europe/Madrid")).toBe("sat");
      // 2026-08-16 = Sunday
      expect(weekdayOf("2026-08-16", "Europe/Madrid")).toBe("sun");
    });

    // Regression lock for the P1 timezone-invariance fix: the pre-fix
    // implementation formatted the UTC instant IN the caller's tz, which for
    // west-of-UTC (negative-offset) zones rolled the date back a day. These
    // pass against the current (fixed) implementation; against the pre-fix
    // code, the America/New_York and Pacific/Pago_Pago cases below would
    // have returned "tue" and "sat" respectively instead of "wed"/"sun".
    it("is timezone-invariant west of UTC (America/New_York, UTC-4/5)", () => {
      // 2026-08-12 is a Wednesday everywhere, regardless of timezone.
      expect(weekdayOf("2026-08-12", "America/New_York")).toBe("wed");
    });

    it("is timezone-invariant at the UTC-11 extreme (Pacific/Pago_Pago)", () => {
      expect(weekdayOf("2026-08-12", "Pacific/Pago_Pago")).toBe("wed");
    });

    it("is timezone-invariant at the UTC+14 extreme (Pacific/Kiritimati)", () => {
      expect(weekdayOf("2026-08-12", "Pacific/Kiritimati")).toBe("wed");
    });

    it("is timezone-invariant on a US DST spring-forward boundary (America/New_York)", () => {
      // 2026-03-08 is the US DST spring-forward Sunday.
      expect(weekdayOf("2026-03-08", "America/New_York")).toBe("sun");
    });
  });

  describe("nextOccurrenceInTz (T001 — research D2 DST policy)", () => {
    describe("Europe/Madrid spring-forward gap (2026-03-29)", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires at the first instant after the gap for a nonexistent local time", () => {
        const nowMs = Date.UTC(2026, 2, 28, 12, 0, 0); // 2026-03-28T12:00:00Z, well before the transition
        const result = nextOccurrenceInTz("02:30", "Europe/Madrid", nowMs);
        expect(result).toBe(Date.UTC(2026, 2, 29, 1, 0, 0)); // 2026-03-29T01:00:00.000Z (exact transition instant)
      });
    });

    describe("Europe/Madrid fall-back repeat (2026-10-25)", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires on the FIRST occurrence only for a repeated local time", () => {
        const nowMs = Date.UTC(2026, 9, 24, 12, 0, 0); // well before the transition
        const result = nextOccurrenceInTz("02:30", "Europe/Madrid", nowMs);
        expect(result).toBe(Date.UTC(2026, 9, 25, 0, 30, 0)); // 2026-10-25T00:30:00.000Z (CEST, first occurrence)
      });

      it("BACKGROUND-JOBS-SCHEDULER-INV-04: re-arming from inside the fired day rolls to the next household-local DATE, never the second rendering of the repeated hour", () => {
        const firstOccurrence = Date.UTC(2026, 9, 25, 0, 30, 0); // the instant just asserted above
        const result = nextOccurrenceInTz("02:30", "Europe/Madrid", firstOccurrence);
        // NOT the second occurrence of the SAME repeated hour (2026-10-25T01:30:00Z, CET) —
        // the next household-local DATE's occurrence instead.
        const secondOccurrenceSameDay = Date.UTC(2026, 9, 25, 1, 30, 0);
        expect(result).not.toBe(secondOccurrenceSameDay);
        expect(result).toBe(Date.UTC(2026, 9, 26, 1, 30, 0)); // 2026-10-26T01:30:00.000Z (CET, no transition)
      });
    });

    describe("America/New_York spring-forward gap (2026-03-08)", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires at the first instant after the gap", () => {
        const nowMs = Date.UTC(2026, 2, 7, 12, 0, 0);
        const result = nextOccurrenceInTz("02:30", "America/New_York", nowMs);
        expect(result).toBe(Date.UTC(2026, 2, 8, 7, 0, 0)); // 2026-03-08T07:00:00.000Z (exact transition instant)
      });
    });

    describe("America/New_York fall-back repeat (2026-11-01)", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires on the FIRST occurrence only", () => {
        const nowMs = Date.UTC(2026, 9, 31, 12, 0, 0);
        const result = nextOccurrenceInTz("01:30", "America/New_York", nowMs);
        expect(result).toBe(Date.UTC(2026, 10, 1, 5, 30, 0)); // 2026-11-01T05:30:00.000Z (EDT, first occurrence)
      });
    });

    describe("Australia/Sydney fall-back repeat (2026-04-05) — large positive offset, review B1", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires on the FIRST occurrence only (not the second, UTC-day-boundary-probe regression)", () => {
        const nowMs = Date.UTC(2026, 3, 4, 0, 0, 0); // 2026-04-04T00:00:00Z, well before the transition
        const result = nextOccurrenceInTz("02:30", "Australia/Sydney", nowMs);
        expect(result).toBe(Date.UTC(2026, 3, 4, 15, 30, 0)); // 2026-04-04T15:30:00.000Z (AEDT, first occurrence)
        expect(result).not.toBe(Date.UTC(2026, 3, 4, 16, 30, 0)); // NOT the second occurrence (AEST)
      });
    });

    describe("Australia/Sydney spring-forward gap (2026-10-04) — large positive offset, review B1", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires at the first instant after the gap", () => {
        const nowMs = Date.UTC(2026, 9, 3, 0, 0, 0); // 2026-10-03T00:00:00Z, well before the transition
        const result = nextOccurrenceInTz("02:30", "Australia/Sydney", nowMs);
        expect(result).toBe(Date.UTC(2026, 9, 3, 16, 0, 0)); // 2026-10-03T16:00:00.000Z (exact transition instant)
      });
    });

    describe("Australia/Lord_Howe fall-back repeat (2026-04-05) — 30-minute DST shift, review B1", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires on the FIRST occurrence only", () => {
        const nowMs = Date.UTC(2026, 3, 4, 0, 0, 0);
        const result = nextOccurrenceInTz("01:45", "Australia/Lord_Howe", nowMs);
        expect(result).toBe(Date.UTC(2026, 3, 4, 14, 45, 0)); // 2026-04-04T14:45:00.000Z (+11:00, first occurrence)
        expect(result).not.toBe(Date.UTC(2026, 3, 4, 15, 15, 0)); // NOT the second occurrence (+10:30)
      });
    });

    describe("Australia/Lord_Howe spring-forward gap (2026-10-04) — 30-minute DST shift, review B1", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires at the first instant after the gap", () => {
        const nowMs = Date.UTC(2026, 9, 3, 0, 0, 0);
        const result = nextOccurrenceInTz("02:15", "Australia/Lord_Howe", nowMs);
        expect(result).toBe(Date.UTC(2026, 9, 3, 15, 30, 0)); // 2026-10-03T15:30:00.000Z (exact transition instant)
      });
    });

    describe("America/Santiago spring-forward gap AT local midnight (2026-09-06) — review R1", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires at the first instant after the gap even though local midnight itself doesn't exist", () => {
        // Noon UTC the day before, not midnight UTC: at a negative offset,
        // 00:00 UTC renders as the PREVIOUS household-local calendar date,
        // which would leave nextOccurrenceInTz's single day-roll one day
        // short of the actual transition date.
        const nowMs = Date.UTC(2026, 8, 5, 12, 0, 0); // 2026-09-05 local, well before the transition
        const result = nextOccurrenceInTz("00:30", "America/Santiago", nowMs);
        expect(result).toBe(Date.UTC(2026, 8, 6, 4, 0, 0)); // 2026-09-06T04:00:00.000Z (exact transition instant)
      });
    });

    describe("America/Havana spring-forward gap AT local midnight (2026-03-08) — review R1", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires at the first instant after the gap even though local midnight itself doesn't exist", () => {
        const nowMs = Date.UTC(2026, 2, 7, 12, 0, 0); // 2026-03-07 local, well before the transition
        const result = nextOccurrenceInTz("00:30", "America/Havana", nowMs);
        expect(result).toBe(Date.UTC(2026, 2, 8, 5, 0, 0)); // 2026-03-08T05:00:00.000Z (exact transition instant)
      });
    });

    describe("America/Havana fall-back repeat AT local midnight (2026-11-01) — review R1 guard", () => {
      it("BACKGROUND-JOBS-SCHEDULER-AC-03: fires on the FIRST occurrence only (non-degenerate overlap case, must stay correct)", () => {
        const nowMs = Date.UTC(2026, 9, 31, 12, 0, 0); // 2026-10-31 local, well before the transition
        const result = nextOccurrenceInTz("00:30", "America/Havana", nowMs);
        expect(result).toBe(Date.UTC(2026, 10, 1, 4, 30, 0)); // 2026-11-01T04:30:00.000Z (offset -4, first occurrence)
      });
    });

    describe("no-transition day", () => {
      it("BACKGROUND-JOBS-SCHEDULER-INV-04: computes a plain household-local wall-clock instant (Europe/Madrid, summer)", () => {
        const nowMs = Date.UTC(2026, 5, 14, 0, 0, 0); // 2026-06-14T00:00:00Z, before 10:00 local the same day
        const result = nextOccurrenceInTz("10:00", "Europe/Madrid", nowMs);
        expect(result).toBe(Date.UTC(2026, 5, 14, 8, 0, 0)); // 2026-06-14T08:00:00.000Z (CEST, +2h)
      });
    });

    describe("UTC household", () => {
      it("BACKGROUND-JOBS-SCHEDULER-INV-04: computes the instant directly with zero offset", () => {
        const nowMs = Date.UTC(2026, 5, 15, 5, 0, 0); // before 10:00 the same day
        const result = nextOccurrenceInTz("10:00", "UTC", nowMs);
        expect(result).toBe(Date.UTC(2026, 5, 15, 10, 0, 0));
      });

      it("BACKGROUND-JOBS-SCHEDULER-AC-03: returns a strictly future instant, rolling to the next day when already past", () => {
        const nowMs = Date.UTC(2026, 5, 15, 11, 0, 0); // after 10:00 the same day
        const result = nextOccurrenceInTz("10:00", "UTC", nowMs);
        expect(result).toBe(Date.UTC(2026, 5, 16, 10, 0, 0));
      });
    });
  });

  describe("todayInHouseholdTz (T001)", () => {
    it("BACKGROUND-JOBS-SCHEDULER-INV-04: derives the household-local date using the default timezone (Europe/Madrid)", () => {
      const now = Date.UTC(2026, 7, 9, 23, 30, 0); // 2026-08-09T23:30:00Z -> 2026-08-10T01:30 CEST
      expect(todayInHouseholdTz(now)).toBe("2026-08-10");
    });

    it("BACKGROUND-JOBS-SCHEDULER-INV-04: derives the household-local date for a UTC household", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
        )
        .run(JSON.stringify({ timezone: "UTC" }), Date.now());
      const now = Date.UTC(2026, 7, 9, 23, 30, 0); // no shift for a UTC household
      expect(todayInHouseholdTz(now)).toBe("2026-08-09");
    });

    it("BACKGROUND-JOBS-SCHEDULER-INV-04: derives the household-local date for America/New_York", () => {
      getDb()
        .prepare(
          "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
        )
        .run(JSON.stringify({ timezone: "America/New_York" }), Date.now());
      const now = Date.UTC(2026, 7, 9, 23, 30, 0); // EDT -4h -> 19:30 same day
      expect(todayInHouseholdTz(now)).toBe("2026-08-09");
    });
  });
});
