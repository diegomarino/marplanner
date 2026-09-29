/** Firing engine — pure decide logic + dedupe.
 * `computeNext` is a thin wrapper over the shared `nextRuleOccurrence` (ported DST math,
 * src/shared/householdTime.ts, D1) that picks the MIN occurrence across active rules —
 * never re-deriving any DST policy itself. `isFireDue` is the fire-time re-check against
 * an ARMED instant: `now >= instant`, bounded by a staleness window — NEVER a literal
 * `HH:MM` wall-clock comparison, which would silently swallow a spring-gap firing (whose
 * policy is "first instant after the gap", a wall-clock reading that can differ from the
 * rule's nominal `time`).
 * `DedupeJournal` is the per-browser dedupe (D5): an in-memory `Set` backed by a bounded
 * (cap 64, FIFO) localStorage journal so the ~4am forced kiosk reload doesn't replay the
 * pre-reload minute. Every storage touch is wrapped — a localStorage failure degrades to
 * memory-only and NEVER blocks a `recordFired`/`hasFired` call (INV-08 direction: a
 * dedupe failure may double-speak, must never silence a legitimate announcement).
 */
import { localDateParts, type WeekdayCode } from "../../shared/householdTime.js";
import { nextRuleOccurrence } from "../../shared/householdTime.js";

/** The minimal rule shape the engine needs (a `TimeAnnouncementRule` satisfies this). */
export interface EngineRule {
  id: string;
  time: string;
  weekDays: WeekdayCode[];
  isActive: boolean;
}

/** `time`/`isActive` are a SNAPSHOT of the rule's content at the instant `computeNext`
 * computed this decision — never re-derive them from a fresh rule lookup at fire time
 * (2026-09-04): a rule can be edited between when a decision is armed and
 * when its timer fires, and pairing the OLD armed instant with the rule's CURRENT
 * (edited) content both speaks the wrong phrase AND records the dedupe key under the
 * NEW time — silently suppressing the genuine future fire at that new time (the INV-08
 * forbidden direction: a dedupe bug must never SILENCE a legitimate announcement).
 */
export interface FireDecision {
  nextAt: number;
  ruleId: string;
  time: string;
  isActive: boolean;
}

/** The MIN next occurrence across ACTIVE rules, in `tz`, strictly after `nowMs`. `null`
 * when there are no active rules or none produces a valid occurrence (e.g. a
 * defensively-invalid `tz` — INV-11; the server's active-overlap invariant, INV-04,
 * guarantees no two active rules ever tie on the same occurrence instant, so "pick the
 * single minimum" never silently drops a simultaneous second rule).
 */
export function computeNext(rules: EngineRule[], tz: string, nowMs: number): FireDecision | null {
  let best: FireDecision | null = null;
  for (const rule of rules) {
    if (!rule.isActive) continue;
    const occurrence = nextRuleOccurrence(rule, tz, nowMs);
    if (occurrence === null) continue;
    if (best === null || occurrence < best.nextAt) {
      best = { nextAt: occurrence, ruleId: rule.id, time: rule.time, isActive: rule.isActive };
    }
  }
  return best;
}

/** Whether an ARMED occurrence instant is due to fire at `nowMs`: `now` has reached it
 * (never before) and hasn't drifted more than `staleWindowMs` past it (a timer that fires
 * dramatically late — e.g. after a long tab suspension — should re-evaluate to the NEXT
 * occurrence instead of firing a stale one).
 */
export function isFireDue(armedAt: number, nowMs: number, staleWindowMs: number): boolean {
  return nowMs >= armedAt && nowMs - armedAt <= staleWindowMs;
}

/** `YYYY-MM-DD` in `tz` for the given instant — the dedupe key's "local date" component. */
export function localDateFor(instantMs: number, tz: string): string {
  const { y, m, d } = localDateParts(instantMs, tz);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `(local date, HH:MM, ruleId)` dedupe key. `hhmm` is the rule's nominal `time`. */
export function dedupeKey(localDate: string, hhmm: string, ruleId: string): string {
  return `${localDate}|${hhmm}|${ruleId}`;
}

const JOURNAL_CAP = 64;
const STORAGE_KEY = "mp:time-announcements-dedupe";

/** `localStorage`, probed eagerly (privacy-mode browsers can throw on first touch), else `null`. */
function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const probeKey = "__mp_ta_probe__";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return null;
  }
}

export class DedupeJournal {
  private memory = new Set<string>();
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = safeLocalStorage()) {
    this.storage = storage;
    this.hydrate();
  }

  private hydrate(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const key of parsed) {
          if (typeof key === "string") this.memory.add(key);
        }
      }
    } catch {
      // corrupted/inaccessible journal — degrade to an empty memory-only start (failure-open)
    }
  }

  /** Whether `key` was already recorded as fired (this session, or hydrated from the journal). */
  hasFired(key: string): boolean {
    return this.memory.has(key);
  }

  /** Record `key` as fired. Idempotent. A storage failure degrades to memory-only — never throws. */
  recordFired(key: string): void {
    this.memory.add(key);
    this.trimToCap();
    this.persist();
  }

  private trimToCap(): void {
    if (this.memory.size <= JOURNAL_CAP) return;
    const list = Array.from(this.memory);
    this.memory = new Set(list.slice(list.length - JOURNAL_CAP));
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(Array.from(this.memory)));
    } catch {
      // INV-08 direction: a storage failure must never block a speak — memory-only from here on
    }
  }
}
