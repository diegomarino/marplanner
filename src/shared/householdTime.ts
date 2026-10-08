// ─────────────────────────────────────────────────────────────────────
// Pure household timezone/DST math — no I/O, no clock, no deps.
//
// Ported verbatim from
// `src/server/lib/household-date.ts` so server and client share ONE
// implementation instead of two DST-math copies that could drift
// (ADR-005). `household-date.ts` keeps only its three impure settings
// readers (`readHouseholdTimezone`, `readWeekStartDay`,
// `todayInHouseholdTz` — they touch `getDb`) and re-exports this
// module's pure set, so no server call site changes.
//
// The DST policies travel unchanged: nonexistent local time (spring-
// forward gap) fires at the first valid instant after the gap
// (binary-searched transition); repeated local time (fall-back overlap)
// fires on its FIRST occurrence only; the day-edge fallback covers
// midnight-transition zones (America/Santiago, America/Havana) where the
// local day boundary itself doesn't exist.
// ─────────────────────────────────────────────────────────────────────

import type { WeekdayCode } from "./weekdays";
export type { WeekdayCode } from "./weekdays";

/** True when `s` is `YYYY-MM-DD` shaped (no calendar-validity check — see `isStrictCalendarDate`). */
export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Strict calendar-date validation: rejects impossible dates, malformed
 * strings, and non-zero-padded forms. Only accepts YYYY-MM-DD that
 * represents a real calendar date — never normalizes.
 */
export function isStrictCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Derive a canonical weekday code (mon..sun) from a YYYY-MM-DD date
 * string in the given IANA timezone. Confirms the CALENDAR date
 * (not a UTC-shifted day) determines the weekday.
 * Per ADR-020: the canonical weekday representation is a set of string
 * codes `mon | tue | wed | thu | fri | sat | sun`.
 */
export function weekdayOf(date: string, _tz: string): WeekdayCode {
  // The weekday of an already-known calendar date (Y-M-D) is TIMEZONE-INVARIANT:
  // Aug 12 2026 is a Wednesday everywhere, regardless of timezone. The previous
  // implementation formatted the UTC instant in the caller's tz, which for timezones
  // west of UTC (negative offset) would return the PREVIOUS day's weekday — a P1 bug.
  // Fix: format the UTC instant IN UTC, which gives the correct timezone-invariant
  // weekday. Keep the tz parameter in the signature per the issue DoD, but it does
  // not affect the result (the calendar date alone determines the weekday).
  const [y, m, d] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(y, m - 1, d));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
  });
  const weekday = formatter.format(instant);
  return weekday.substring(0, 3).toLowerCase() as WeekdayCode;
}

/** Compute the next UTC epoch-ms instant at which the household-local
 * wall-clock time `at` ("HH:MM") occurs in `tz`, strictly after `nowMs`.
 * Implements via Intl offset probing only (no date library).
 * DST policy (FR-005):
 * - Nonexistent local time (spring-forward gap): fires at the first valid
 * instant after the gap (the exact transition instant).
 * - Repeated local time (fall-back overlap): fires on its FIRST occurrence
 * only (the instant using the larger, pre-transition UTC offset).
 * Re-arm contract: this function
 * is a pure function of (household-local calendar date, `at`, `tz`) — for a
 * given date it always resolves to the SAME candidate instant, never "the
 * next occurrence after `nowMs` within that same date". Combined with the
 * "strictly future" rule, this means re-arming with a `nowMs` taken from
 * INSIDE the day that just fired (e.g. immediately after the action
 * completes) always rolls forward to the next household-local DATE's
 * occurrence — never a second rendering of the same `HH:MM` on the same
 * local day. This is what prevents a double-fire inside a fall-back
 * repeated hour: the caller must never call this with a same-day `nowMs`
 * expecting "the second occurrence" — there isn't one, by design.
 */
export function nextOccurrenceInTz(at: string, tz: string, nowMs: number): number {
  const [hh, mm] = at.split(":").map(Number);
  let { y, m, d } = localDateParts(nowMs, tz);
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = occurrenceForLocalDate(y, m, d, hh, mm, tz);
    if (candidate > nowMs) return candidate;
    ({ y, m, d } = addOneLocalDay(y, m, d));
  }
  // Safety net: two calendar-day rolls always produce a strictly future
  // instant in practice (a full day always exceeds any single day's DST
  // shift), but compute directly for the rolled date rather than looping
  // unboundedly.
  return occurrenceForLocalDate(y, m, d, hh, mm, tz);
}

/** `nextRuleOccurrence` — the next household-local occurrence (strictly
 * after `nowMs`) of a rule's `time` on one of its listed weekdays
 *. Composed from the primitives below rather than
 * re-deriving DST logic: steps forward one
 * household-CALENDAR day at a time — via `addOneLocalDay`, never a literal
 * UTC +24h — so the weekday check stays correct across a spring-forward
 * day (the v1 "+24h weekday trap" FR-008/edge-cases calls out: naive
 * +24h-ms stepping can land on the wrong local weekday when that day's DST
 * shift is nonzero). Scanning chronologically day-by-day naturally yields
 * the MIN occurrence across the listed weekdays — no separate per-weekday
 * computation + min is needed.
 * Returns `null` — never throws — when there are no listed weekdays, `at`
 * isn't `HH:MM` shaped, or `tz` is defensively invalid (INV-11: the
 * settings boundary normally guarantees a valid IANA zone, but a corrupted
 * or stale client read must degrade to "no fire", never crash); callers
 * log a miss in the invalid-tz case.
 */
export function nextRuleOccurrence(
  rule: { time: string; weekDays: WeekdayCode[] },
  tz: string,
  nowMs: number
): number | null {
  if (!rule.weekDays || rule.weekDays.length === 0) return null;
  if (!isValidTimeZone(tz)) return null;

  const match = rule.time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);

  let { y, m, d } = localDateParts(nowMs, tz);
  // Bounded to 8 calendar-day steps: the weekday cycle repeats every 7 days,
  // so scanning today..+7 is guaranteed to both (a) hit every listed weekday
  // at least once and (b) land on a strictly-future instant by the +7 step
  // (a full week always exceeds any single day's DST shift) — this never
  // loops unboundedly.
  for (let step = 0; step < 8; step++) {
    const dateStr = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (rule.weekDays.includes(weekdayOf(dateStr, tz))) {
      const candidate = occurrenceForLocalDate(y, m, d, hh, mm, tz);
      if (candidate > nowMs) return candidate;
    }
    ({ y, m, d } = addOneLocalDay(y, m, d));
  }
  return null;
}

/** Whether `tz` is a timezone `Intl` accepts — used defensively by
 * `nextRuleOccurrence` (INV-11): a corrupted/stale client-side tz value
 * must degrade to "no fire", never throw when probed against `Intl`.
 */
function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Household-local calendar date parts (Intl en-CA technique). Exported
 * (not module-private) because `household-date.ts`'s `todayInHouseholdTz`
 * — the one impure reader that needs this pure date-parts split — composes
 * it directly; the rest of the private helpers below stay module-local.
 */
export function localDateParts(instantMs: number, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return { y: part("year"), m: part("month"), d: part("day") };
}

/** The UTC offset (ms) in effect for `tz` at `instantMs`, expressed such
 * that `instantMs + offset` renders as the local wall-clock reading. Used
 * to probe both sides of a DST transition without a date library.
 */
function offsetMsAt(instantMs: number, tz: string): number {
  // Floor to the whole second before formatting: `formatToParts` has no
  // sub-second field, so an `instantMs` with a millisecond remainder (e.g.
  // a calendar day's closing instant, `23:59:59.999`) would otherwise
  // corrupt the returned offset by that same remainder — real-world UTC
  // offsets are always whole-minute (usually whole-hour) values, so
  // second-granularity is exact and safe here.
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(wholeSecondMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const asUtcMs = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return asUtcMs - wholeSecondMs;
}

/** `{y, m, d}` plus one calendar day, normalizing month/year overflow. */
function addOneLocalDay(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

/** Resolve the actual UTC instant (+ offset in effect there) for a raw naive
 * guess — `Date.UTC(y, m, d, hh, mm)` is itself a UTC instant, not the
 * intended local one, so probing its offset directly can land on the wrong
 * side of a DST transition, or — for zones far from UTC — look at an
 * entirely different local hour than intended (e.g. UTC midnight is already
 * mid-morning in Australia/Sydney, UTC+10/11h). Fixpoint-iterates: probe the
 * offset at the guess, shift the guess back by that offset, and re-probe;
 * repeat until the offset stops changing (real-world DST shifts converge in
 * at most one extra iteration).
 * Returns `null` when there is no fixpoint to find — the naive guess itself
 * sits inside a spring-forward gap (a transition at/around local midnight,
 * e.g. America/Santiago, America/Havana), so no local instant renders that
 * exact reading and the offset probe oscillates between the two regimes
 * instead of converging. Detected either by revisiting an offset already
 * seen (definitive oscillation) or by exhausting the iteration budget.
 * Callers must not trust an unconverged `{instant, offset}` pair — it is
 * self-inconsistent .
 */
function resolveOffset(
  naiveUtcGuess: number,
  tz: string
): { instant: number; offset: number } | null {
  let offset = offsetMsAt(naiveUtcGuess, tz);
  let instant = naiveUtcGuess - offset;
  const seenOffsets = new Set<number>([offset]);
  for (let i = 0; i < 5; i++) {
    const nextOffset = offsetMsAt(instant, tz);
    if (nextOffset === offset) {
      return { instant, offset };
    }
    if (seenOffsets.has(nextOffset)) {
      return null; // oscillating between previously-seen offsets — no fixpoint exists
    }
    seenOffsets.add(nextOffset);
    offset = nextOffset;
    instant = naiveUtcGuess - offset;
  }
  return null; // exhausted the budget without converging — treat as degenerate too
}

/** Resolve the UTC instant at which local `HH:MM` renders as `naiveUtc - loOffset`
 * or `naiveUtc - hiOffset`, given a `[loInstant, hiInstant]` bracket known to
 * bound at most one DST transition, with `loOffset`/`hiOffset` the (stable,
 * self-consistent) offsets in effect at those bracket ends. Shared by the
 * normal day-edge path and the degenerate-day-edge fallback in
 * `occurrenceForLocalDate` below — same gap/overlap/single-regime logic,
 * parameterized by where the bracket came from.
 */
function resolveGapOrOverlap(
  naiveUtc: number,
  loInstant: number,
  loOffset: number,
  hiInstant: number,
  hiOffset: number,
  tz: string
): number {
  if (loOffset === hiOffset) {
    // No DST transition across this bracket: a single offset regime applies.
    const candidate = naiveUtc - loOffset;
    // Belt-and-braces: confirm the single-regime assumption actually holds
    // for this specific candidate before trusting it directly.
    if (offsetMsAt(candidate, tz) === loOffset) {
      return candidate;
    }
    // Extremely rare (e.g. a zone with more than one transition inside a
    // single bracket): fall through to the general gap/overlap path below.
  }

  const candidateLo = naiveUtc - loOffset;
  const candidateHi = naiveUtc - hiOffset;
  const validLo = offsetMsAt(candidateLo, tz) === loOffset;
  const validHi = offsetMsAt(candidateHi, tz) === hiOffset;

  if (validLo && validHi) {
    // Repeated local time (fall-back overlap): two UTC instants both
    // render as the requested local HH:MM. Fire on the FIRST occurrence —
    // for a fixed local reading, the larger (pre-transition) offset
    // corresponds to the earlier UTC instant.
    return loOffset > hiOffset ? candidateLo : candidateHi;
  }
  if (validLo) return candidateLo;
  if (validHi) return candidateHi;

  // Nonexistent local time (spring-forward gap): neither candidate is
  // self-consistent. Binary-search the bracket for the exact UTC transition
  // instant and fire at the first instant after the gap.
  let lo = loInstant;
  let hi = hiInstant;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMsAt(mid, tz) === loOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** Resolve the UTC instant at which local `HH:MM` occurs on household-local
 * calendar date `y-m-d` in `tz`, applying the D2 DST policy. Offset-probes
 * both edges of the calendar day (via `resolveOffset`, so the probe lands on
 * the TRUE local midnight / local end-of-day instant, not a same-numbered
 * UTC instant that can be many hours off for zones far from UTC).
 */
function occurrenceForLocalDate(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string
): number {
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const dayStart = resolveOffset(Date.UTC(y, m - 1, d, 0, 0, 0, 0), tz);
  const dayEnd = resolveOffset(Date.UTC(y, m - 1, d, 23, 59, 59, 999), tz);

  if (dayStart && dayEnd) {
    return resolveGapOrOverlap(
      naiveUtc,
      dayStart.instant,
      dayStart.offset,
      dayEnd.instant,
      dayEnd.offset,
      tz
    );
  }

  // One (or both) of the local day-boundary instants doesn't exist — a DST
  // transition sits at/around local midnight or local end-of-day (e.g.
  // America/Santiago, America/Havana spring-forward), so `resolveOffset`'s
  // fixpoint has no solution there. Anchor the search a full day on either
  // side of the REQUESTED instant instead of the degenerate day-edge pair —
  // real-world DST shifts are far shorter than a day, so both anchors are
  // chosen in a stable, single-offset regime.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const loInstant = naiveUtc - ONE_DAY_MS;
  const hiInstant = naiveUtc + ONE_DAY_MS;
  return resolveGapOrOverlap(
    naiveUtc,
    loInstant,
    offsetMsAt(loInstant, tz),
    hiInstant,
    offsetMsAt(hiInstant, tz),
    tz
  );
}
