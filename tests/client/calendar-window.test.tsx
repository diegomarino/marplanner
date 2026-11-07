import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarView } from "@/calendar/CalendarView";
import { LanguageProvider } from "@/i18n";

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: false, setUnlocked: vi.fn() }),
}));

/** — the calendar admin list rendered EVERY expanded occurrence the server returned for
 * the fetched range with no bound: a single weekly recurring event alone produced ~52 flat
 * rows (the fetch range is ~1 year). The fix bounds the RENDERED window to the next 28 days —
 * the fetch/expansion themselves are untouched (server-side, out of scope per the task).
 * All fixture dates are now-relative (never a fixed calendar date — a hardcoded date silently
 * ages out of any date-window assertion once "today" passes it).
 */
describe("CalendarView — bounds the recurring-event list to a 28-day window (#684)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  function ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  beforeEach(() => {
    // A weekly all-day event, 10 occurrences starting TODAY: offsets 0/7/14/21/28/…/63 days.
    // Only offsets 0/7/14/21 (< 28 days out) fall inside the 28-day render window — the
    // window's upper bound is exclusive, so the offset-28 occurrence itself is just outside.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const occurrences = Array.from({ length: 10 }, (_, i) => {
      const start = new Date(todayStart.getTime() + i * 7 * 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      return {
        id: "evt-weekly",
        title: "Weekly Standup",
        allDay: true,
        occurrenceStart: ymd(start),
        occurrenceEnd: ymd(end),
        source: "local" as const,
        assignedTo: [] as string[],
      };
    });

    mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/calendar/events")) {
        return Promise.resolve(new Response(JSON.stringify(occurrences), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders only occurrences that fit in the visible month grid", async () => {
    render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("calendar-event-row").length).toBeGreaterThan(0);
    });

    const rows = screen.getAllByTestId("calendar-event-row");
    // A month grid spans up to six weeks, so a weekly event starting today shows at most six
    // times (e.g. today = 2026-11-01, grid 2026-10-26..2026-12-06).
    expect(rows.length).toBeLessThanOrEqual(6);
    // The fixture fed 10 occurrences — proves this is the window bounding it, not a
    // coincidence of the fixture itself only ever having a handful of rows.
    expect(rows.length).toBeLessThan(10);

    expect(screen.getByTestId("calendar-month-grid")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-period-title")).toBeInTheDocument();
  });
});

/** (P2, tz) — the window filter must compare an all-day `occurrenceStart`
 * (`YYYY-MM-DD`, tz-neutral, ADR-062) against the viewer's LOCAL calendar date, never via
 * `Date`-instant math: parsing the all-day date at UTC midnight and comparing that instant
 * against a LOCAL midnight `windowStart` silently drops TODAY's all-day event (and shifts the
 * window by a day) in any negative-UTC-offset timezone.
 * Forces both the system clock AND `process.env.TZ` to America/New_York (EDT, UTC-4) so the
 * scenario is deterministic regardless of when/where the suite runs: the pinned instant
 * (02:30 UTC) is calendar-date 2026-06-15 in UTC but still 2026-06-14 local in New York — a
 * guaranteed one-day mismatch between "UTC-parsed" and "local" that reproduces the bug on
 * demand. `process.env.TZ` is read live by V8/ICU on every `Date` call in this Node runtime
 * (verified empirically — no timezone-mock dependency needed). Uses `vi.setSystemTime` WITHOUT
 * `vi.useFakeTimers` — it mocks `Date` alone (verified empirically) and leaves real timers
 * running, so the component's fetch promise chain and `waitFor`'s polling both still work
 * exactly as in every other test in this file.
 */
describe("CalendarView — all-day window filter is LOCAL-calendar-date-safe (#684 review fold, tz)", () => {
  const originalTz = process.env.TZ;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TZ = "America/New_York";
    vi.setSystemTime(new Date("2026-06-15T02:30:00.000Z"));

    // "Today" in New York, at the pinned instant, is 2026-06-14 (still the evening before in
    // UTC's 2026-06-15) — a single all-day event dated exactly that LOCAL today.
    const occurrences = [
      {
        id: "evt-today-ny",
        title: "Local Today (NY)",
        allDay: true,
        occurrenceStart: "2026-06-14",
        occurrenceEnd: "2026-06-15",
        source: "local" as const,
        assignedTo: [] as string[],
      },
    ];

    mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/calendar/events")) {
        return Promise.resolve(new Response(JSON.stringify(occurrences), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env.TZ = originalTz;
    cleanup();
  });

  it("keeps today's all-day event visible in America/New_York", async () => {
    render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Local Today (NY)")).toBeInTheDocument();
    });

    expect(screen.getAllByTestId("calendar-event-row")).toHaveLength(1);
  });
});

/** P2 on — `windowEnd` was computed as `windowStart.getTime + 28 * DAY_MS`: a
 * fixed-duration ms addition. Crossing the America/New_York autumn DST fall-back (the clocks
 * go back an hour, so that calendar day has 25 real hours) inside the 28-day span makes that
 * addition land ONE HOUR SHORT of the true local midnight it's aiming for — `windowEnd` ends
 * up at 23:00 local on the day BEFORE the correct one. That silently turns the window's true
 * LAST calendar day into an excluded day, dropping its all-day events and clipping timed
 * events in its final hour.
 * Pinned scenario (verified empirically — `node -e` against this exact Node/ICU build):
 * "today" = 2026-10-05 local in America/New_York; DST falls back on 2026-11-01 (the first
 * Sunday of November). The CORRECT 28-day window is [2026-10-05, 2026-11-02) — its true last
 * calendar day is 2026-11-01. The buggy ms-arithmetic version computes `windowEnd` as
 * 2026-11-01T23:00 local (one hour short of 2026-11-02T00:00), so `windowEndDate` becomes
 * "2026-11-01" and the exclusive `< windowEndDate` check drops that day entirely.
 */
describe("CalendarView — window end survives a DST fall-back inside the span (Codex P2 on #686)", () => {
  const originalTz = process.env.TZ;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TZ = "America/New_York";
    // 2026-10-05T14:00:00Z = 10:00 EDT (America/New_York is still on daylight time on Oct 5) —
    // local calendar date is unambiguously 2026-10-05.
    vi.setSystemTime(new Date("2026-10-05T14:00:00.000Z"));

    const occurrences = [
      {
        id: "evt-last-day-allday",
        title: "Window Last Day (all-day)",
        allDay: true,
        // The window's true last calendar day (2026-10-05 + 28 days, half-open end 2026-11-02).
        occurrenceStart: "2026-11-01",
        occurrenceEnd: "2026-11-02",
        source: "local" as const,
        assignedTo: [] as string[],
      },
      {
        id: "evt-last-day-timed",
        title: "Window Last Day (timed, final hour)",
        allDay: false,
        // 2026-11-01T23:30 local (EST, UTC-5 post-fallback) = 2026-11-02T04:30:00.000Z — inside
        // the correct window, but AFTER the buggy windowEnd (2026-11-01T23:00 local /
        // 2026-11-02T04:00:00.000Z).
        occurrenceStart: "2026-11-02T04:30:00.000Z",
        occurrenceEnd: "2026-11-02T05:00:00.000Z",
        source: "local" as const,
        assignedTo: [] as string[],
      },
    ];

    mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/calendar/events")) {
        return Promise.resolve(new Response(JSON.stringify(occurrences), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env.TZ = originalTz;
    cleanup();
  });

  it("keeps both the all-day and the timed event on the window's true last calendar day", async () => {
    render(
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Window Last Day (all-day)")).toBeInTheDocument();
    });
    expect(screen.getByText("Window Last Day (timed, final hour)")).toBeInTheDocument();
    expect(screen.getAllByTestId("calendar-event-row")).toHaveLength(2);
  });
});
