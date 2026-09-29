import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

/** Boundary tests for the pure recurrence expander.
 * Contract (docs/features/calendar.md, read model):
 * expand({ allDay, startUtc|startDate, tzid, rrule, exdates }, range) -> Occurrence[]
 * Occurrence = { occurrenceStart: string; allDay: boolean } (PURE — no id/title/assignedTo)
 * The core hazard (R2): rrule.js `.between`/`.all` return Date objects whose
 * UTC fields encode the LOCAL wall-clock, NOT the true instant. The expander MUST reconstruct the
 * true UTC instant by interpreting each returned Date's UTC components as a wall-clock time in the
 * event's stored `tzid`. `.toISOString` on the raw rrule Date is the R1 hazard (wrong instant).
 */
describe("calendar recurrence expander (T004, T005)", () => {
  let expand: typeof import("../../src/server/modules/calendar/recurrence").expand;

  beforeAll(async () => {
    const mod = await import("../../src/server/modules/calendar/recurrence");
    expand = mod.expand;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // R2 golden — the core DST hazard (kept from the original suite).
  // ---------------------------------------------------------------------------
  describe("DST transition (research R2 - the core hazard)", () => {
    it("expands weekly 09:00 Europe/Madrid across spring-forward (2026-03-29) with correct UTC instants", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-02T08:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=6",
          exdates: [],
        },
        {
          start: new Date("2026-03-22T00:00:00Z"),
          end: new Date("2026-04-06T00:00:00Z"),
        }
      );

      const sorted = [...occurrences].sort(
        (a, b) => new Date(a.occurrenceStart).getTime() - new Date(b.occurrenceStart).getTime()
      );

      // 09:00 Madrid wall-clock: CET (+01) before 2026-03-29, CEST (+02) after.
      expect(sorted[0].occurrenceStart).toBe("2026-03-23T08:00:00.000Z");
      expect(sorted[1].occurrenceStart).toBe("2026-03-30T07:00:00.000Z");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 3 — EXDATE that falls on the FAR SIDE of a DST transition.
  // The original suite only excluded a same-offset date (2026-03-16), which never
  // exercised the pseudo-UTC/true-UTC mismatch. This excludes the post-transition
  // occurrence (true instant 07:00Z / CEST).
  // ---------------------------------------------------------------------------
  describe("EXDATE across a DST boundary", () => {
    it("removes the post-transition (CEST) occurrence given its true-UTC exdate", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-02T08:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=6",
          exdates: ["2026-03-30T07:00:00.000Z"], // 09:00 Madrid CEST
        },
        {
          start: new Date("2026-03-01T00:00:00Z"),
          end: new Date("2026-04-10T00:00:00Z"),
        }
      );

      const starts = occurrences.map((o) => o.occurrenceStart);
      expect(starts).not.toContain("2026-03-30T07:00:00.000Z");
      // A pre-transition occurrence still present — proves it removed only the excluded one.
      expect(starts).toContain("2026-03-23T08:00:00.000Z");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 1 — unbounded rule (no COUNT / no UNTIL). Must NOT materialize the
  // whole infinite series (`.all` throws / hangs); range-bounded expansion only.
  // ---------------------------------------------------------------------------
  describe("unbounded rule", () => {
    it("expands a rule with no COUNT/UNTIL within the range without materializing the infinite series", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-02T08:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=MO", // no COUNT, no UNTIL
          exdates: [],
        },
        {
          start: new Date("2026-03-01T00:00:00Z"),
          end: new Date("2026-04-01T00:00:00Z"),
        }
      );

      // Mondays in [2026-03-01, 2026-04-01): 03-02, 09, 16, 23, 30 -> 5.
      expect(occurrences.length).toBe(5);
      occurrences.forEach((o) => {
        const t = new Date(o.occurrenceStart);
        expect(t >= new Date("2026-03-01T00:00:00Z")).toBe(true);
        expect(t < new Date("2026-04-01T00:00:00Z")).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 2 — bare FREQ=WEEKLY (no BYDAY / no BYHOUR). The weekday and
  // time-of-day MUST derive from the event's own start (in tzid), never from the
  // server clock. Assert identical output under two different fake system times.
  // ---------------------------------------------------------------------------
  describe("deterministic anchoring (independent of server clock)", () => {
    it("bare FREQ=WEEKLY anchors weekday+time on the event start, not new Date()", () => {
      const params = {
        allDay: false,
        startUtc: "2026-03-02T08:00:00.000Z", // Mon 09:00 Madrid
        tzid: "Europe/Madrid",
        rrule: "FREQ=WEEKLY;COUNT=3", // no BYDAY, no BYHOUR
        exdates: [] as string[],
      };
      const range = {
        start: new Date("2026-03-01T00:00:00Z"),
        end: new Date("2026-04-01T00:00:00Z"),
      };

      vi.useFakeTimers();

      vi.setSystemTime(new Date("2020-07-15T12:34:56Z"));
      const a = expand(params, range).map((o) => o.occurrenceStart);

      vi.setSystemTime(new Date("2031-11-03T23:11:00Z"));
      const b = expand(params, range).map((o) => o.occurrenceStart);

      expect(a).toEqual(b);
      // And it is actually anchored on the event: Mondays 09:00 Madrid (CET here).
      expect(a).toContain("2026-03-02T08:00:00.000Z");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 4 — range boundary strictly BETWEEN the pseudo-UTC wall-clock
  // (09:00Z) and the true instant (07:00Z / CEST) of the 2026-03-30 occurrence.
  // Filtering must run on the RECONSTRUCTED true instant, not the raw rrule Date.
  // ---------------------------------------------------------------------------
  describe("range filtering on the true instant", () => {
    it("excludes an occurrence whose true instant is below range.start even though its wall-clock is above", () => {
      const base = {
        allDay: false,
        startUtc: "2026-03-02T08:00:00.000Z",
        tzid: "Europe/Madrid",
        rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=6",
        exdates: [] as string[],
      };

      // True instant of the 2026-03-30 occurrence is 07:00Z. Pseudo wall-clock is 09:00Z.
      const excluded = expand(base, {
        start: new Date("2026-03-30T07:30:00Z"), // above true 07:00Z, below pseudo 09:00Z
        end: new Date("2026-03-30T23:59:00Z"),
      });
      expect(excluded.map((o) => o.occurrenceStart)).not.toContain("2026-03-30T07:00:00.000Z");
      expect(excluded.length).toBe(0);

      const included = expand(base, {
        start: new Date("2026-03-30T06:30:00Z"), // below the true instant
        end: new Date("2026-03-30T23:59:00Z"),
      });
      expect(included.map((o) => o.occurrenceStart)).toContain("2026-03-30T07:00:00.000Z");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 5 — near-midnight start where the LOCAL date differs from the UTC
  // date. The series must anchor on the local weekday (Tuesday), not the UTC one.
  // ---------------------------------------------------------------------------
  describe("near-midnight start (local date != UTC date)", () => {
    it("anchors the weekly series on the local weekday, not the UTC weekday", () => {
      // 2026-01-12T23:30Z == Tue 2026-01-13 00:30 Madrid (CET).
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-01-12T23:30:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=2",
          exdates: [],
        },
        {
          start: new Date("2026-01-10T00:00:00Z"),
          end: new Date("2026-01-25T00:00:00Z"),
        }
      );

      const starts = occurrences.map((o) => o.occurrenceStart).sort();
      expect(starts).toEqual(["2026-01-12T23:30:00.000Z", "2026-01-19T23:30:00.000Z"]);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 6 — non-recurring startUtc WITHOUT milliseconds. Must NOT be routed
  // through wall-clock reconstruction (which would double-shift the instant).
  // ---------------------------------------------------------------------------
  describe("non-recurring event", () => {
    it("returns exactly one occurrence for an event with no RRULE", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-16T10:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: null,
          exdates: [],
        },
        { start: new Date("2026-03-15T00:00:00Z"), end: new Date("2026-03-18T00:00:00Z") }
      );

      expect(occurrences.length).toBe(1);
      expect(occurrences[0].occurrenceStart).toBe("2026-03-16T10:00:00.000Z");
    });

    it("does not shift a non-recurring instant given a startUtc without milliseconds", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-16T10:00:00Z", // no.000 ms
          tzid: "Europe/Madrid",
          rrule: null,
          exdates: [],
        },
        { start: new Date("2026-03-15T00:00:00Z"), end: new Date("2026-03-18T00:00:00Z") }
      );

      expect(occurrences.length).toBe(1);
      expect(occurrences[0].occurrenceStart).toBe("2026-03-16T10:00:00.000Z");
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 7 — DST spring-forward GAP (wall time does not exist) and fall-back
  // AMBIGUOUS (wall time occurs twice). Policy: deterministic, documented.
  // gap -> forward-shift to the post-transition instant.
  // ambiguous -> the post-transition (standard-time) instant.
  // ---------------------------------------------------------------------------
  describe("DST edge policy", () => {
    it("spring-forward gap: a 02:30 Madrid occurrence on the transition day resolves forward", () => {
      // Sundays 02:30 Madrid; 2026-03-29 is the spring-forward day (02:00 -> 03:00).
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-22T01:30:00.000Z", // Sun 2026-03-22 02:30 Madrid (CET)
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=3",
          exdates: [],
        },
        { start: new Date("2026-03-20T00:00:00Z"), end: new Date("2026-04-10T00:00:00Z") }
      );

      const starts = occurrences.map((o) => o.occurrenceStart).sort();
      // 03-22 02:30 CET -> 01:30Z; 03-29 gap -> 01:30Z (03:30 CEST); 04-05 02:30 CEST -> 00:30Z.
      expect(starts).toEqual([
        "2026-03-22T01:30:00.000Z",
        "2026-03-29T01:30:00.000Z",
        "2026-04-05T00:30:00.000Z",
      ]);
    });

    it("fall-back ambiguous: a 02:30 Madrid occurrence on the transition day is deterministic", () => {
      // Sundays 02:30 Madrid; 2026-10-25 is the fall-back day (03:00 -> 02:00).
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-10-18T00:30:00.000Z", // Sun 2026-10-18 02:30 Madrid (CEST)
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=2",
          exdates: [],
        },
        { start: new Date("2026-10-15T00:00:00Z"), end: new Date("2026-10-30T00:00:00Z") }
      );

      const starts = occurrences.map((o) => o.occurrenceStart).sort();
      // 10-18 02:30 CEST -> 00:30Z; 10-25 ambiguous -> 01:30Z (post-transition CET).
      expect(starts).toEqual(["2026-10-18T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
    });

    // The DST policy must be sign-independent: it has to hold WEST of UTC too, where a
    // naive "correct toward the landed regime" resolves the wrong direction.
    it("spring-forward gap resolves forward in a negative-offset zone (America/New_York)", () => {
      // Sundays 02:30 New_York; 2026-03-08 is the US spring-forward day (02:00 -> 03:00).
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-01T07:30:00.000Z", // Sun 2026-03-01 02:30 EST (-05)
          tzid: "America/New_York",
          rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=3",
          exdates: [],
        },
        { start: new Date("2026-02-27T00:00:00Z"), end: new Date("2026-03-20T00:00:00Z") }
      );

      const starts = occurrences.map((o) => o.occurrenceStart).sort();
      // 03-01 02:30 EST -> 07:30Z; 03-08 gap -> forward to 03:30 EDT -> 07:30Z;
      // 03-15 02:30 EDT -> 06:30Z.
      expect(starts).toEqual([
        "2026-03-01T07:30:00.000Z",
        "2026-03-08T07:30:00.000Z",
        "2026-03-15T06:30:00.000Z",
      ]);
    });

    it("fall-back ambiguous resolves post-transition in a negative-offset zone (America/New_York)", () => {
      // Sundays 01:30 New_York; 2026-11-01 is the US fall-back day (02:00 -> 01:00).
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-10-25T05:30:00.000Z", // Sun 2026-10-25 01:30 EDT (-04)
          tzid: "America/New_York",
          rrule: "FREQ=WEEKLY;BYDAY=SU;COUNT=2",
          exdates: [],
        },
        { start: new Date("2026-10-22T00:00:00Z"), end: new Date("2026-11-05T00:00:00Z") }
      );

      const starts = occurrences.map((o) => o.occurrenceStart).sort();
      // 10-25 01:30 EDT -> 05:30Z; 11-01 ambiguous -> 01:30 EST -> 06:30Z (post-transition).
      expect(starts).toEqual(["2026-10-25T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-second precision must survive recurring expansion too (the non-recurring
  // branch already preserves it) — no silent truncation to whole seconds.
  // ---------------------------------------------------------------------------
  describe("millisecond precision", () => {
    it("preserves the startUtc milliseconds on a recurring occurrence", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-02T08:00:00.123Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=1",
          exdates: [],
        },
        { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-03-05T00:00:00Z") }
      );

      expect(occurrences.map((o) => o.occurrenceStart)).toEqual(["2026-03-02T08:00:00.123Z"]);
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 8 — all-day recurrence is pure date math; the expander emits one
  // start date per occurrence (span/end is the caller's concern — the spec
  // signature carries no end field).
  // ---------------------------------------------------------------------------
  describe("all-day recurrence", () => {
    it("expands all-day events as dates with no timezone conversion", () => {
      const occurrences = expand(
        {
          allDay: true,
          startDate: "2026-03-22",
          rrule: "FREQ=WEEKLY;COUNT=3",
          exdates: [],
        },
        { start: new Date("2026-03-20T00:00:00Z"), end: new Date("2026-04-10T00:00:00Z") }
      );

      const starts = occurrences.map((o) => o.occurrenceStart).sort();
      expect(starts).toEqual(["2026-03-22", "2026-03-29", "2026-04-05"]);
      occurrences.forEach((o) => {
        expect(o.allDay).toBe(true);
        expect(o.occurrenceStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GAP CASE 9 — the expander returns PURE occurrences: no fabricated
  // id/title/source/assignedTo (those belong to getEvents / the FeedItem DTO).
  // ---------------------------------------------------------------------------
  describe("pure-occurrence shape", () => {
    it("returns only { occurrenceStart, allDay } — no fabricated FeedItem fields", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-16T10:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: null,
          exdates: [],
        },
        { start: new Date("2026-03-15T00:00:00Z"), end: new Date("2026-03-18T00:00:00Z") }
      );

      const occ = occurrences[0];
      expect(Object.keys(occ).sort()).toEqual(["allDay", "occurrenceStart"]);
      expect(occ).not.toHaveProperty("id");
      expect(occ).not.toHaveProperty("title");
      expect(occ).not.toHaveProperty("source");
      expect(occ).not.toHaveProperty("assignedTo");
    });
  });

  // ---------------------------------------------------------------------------
  // Range filter (kept) — only occurrences within the passed range are returned.
  // ---------------------------------------------------------------------------
  describe("range filtering", () => {
    it("returns only occurrences within the passed range", () => {
      const occurrences = expand(
        {
          allDay: false,
          startUtc: "2026-03-02T08:00:00.000Z",
          tzid: "Europe/Madrid",
          rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10",
          exdates: [],
        },
        { start: new Date("2026-03-29T00:00:00Z"), end: new Date("2026-03-31T00:00:00Z") }
      );

      occurrences.forEach((o) => {
        const t = new Date(o.occurrenceStart);
        expect(t >= new Date("2026-03-29T00:00:00Z")).toBe(true);
        expect(t < new Date("2026-03-31T00:00:00Z")).toBe(true);
      });
    });
  });
});
