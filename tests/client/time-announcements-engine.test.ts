import { describe, expect, it } from "vitest";
import {
  computeNext,
  isFireDue,
  localDateFor,
  dedupeKey,
  DedupeJournal,
  type EngineRule,
} from "@/time-announcements/engine";

/** — engine (computeNext + dedupe) jsdom tests.
 * All inputs are pure `nowMs` parameters — no system-clock mocking needed for the
 * `computeNext`/`isFireDue` tests. The dedupe tests use a scripted fake `Storage`
 * (jsdom's real `localStorage` also works, but a fake lets storage-failure be scripted).
 * (Traces: TIME-ANNOUNCEMENTS-INV-01, TIME-ANNOUNCEMENTS-INV-06, TIME-ANNOUNCEMENTS-INV-07,
 * TIME-ANNOUNCEMENTS-AC-03, TIME-ANNOUNCEMENTS-AC-04)
 */

function fakeStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => {
      if (opts.throwOnGet) throw new Error("get blocked");
      return map.has(key) ? map.get(key)! : null;
    },
    setItem: (key: string, value: string) => {
      if (opts.throwOnSet) throw new Error("set blocked");
      map.set(key, value);
    },
    removeItem: (key: string) => map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("computeNext (TIME-ANNOUNCEMENTS-INV-01, TIME-ANNOUNCEMENTS-AC-03)", () => {
  const nowMs = Date.UTC(2026, 7, 10, 6, 0, 0); // Monday 08:00 Europe/Madrid (CEST, +2h)

  it("null when there are no rules", () => {
    expect(computeNext([], "Europe/Madrid", nowMs)).toBeNull();
  });

  it("skips inactive rules entirely (they never arm)", () => {
    const rules: EngineRule[] = [{ id: "r1", time: "09:00", weekDays: ["mon"], isActive: false }];
    expect(computeNext(rules, "Europe/Madrid", nowMs)).toBeNull();
  });

  it("picks the MIN occurrence across multiple active rules (delegates to the shared DST math, D1)", () => {
    const rules: EngineRule[] = [
      { id: "later", time: "18:00", weekDays: ["mon"], isActive: true },
      { id: "earlier", time: "09:00", weekDays: ["mon"], isActive: true },
      { id: "inactive-earliest", time: "08:30", weekDays: ["mon"], isActive: false },
    ];
    const result = computeNext(rules, "Europe/Madrid", nowMs);
    expect(result?.ruleId).toBe("earlier");
    expect(result?.nextAt).toBe(Date.UTC(2026, 7, 10, 7, 0, 0)); // 09:00 CEST = 07:00Z
  });

  it("P1-2: the returned decision SNAPSHOTS the winning rule's time/isActive at compute time", () => {
    const rules: EngineRule[] = [{ id: "r1", time: "09:00", weekDays: ["mon"], isActive: true }];
    const result = computeNext(rules, "Europe/Madrid", nowMs);
    expect(result?.time).toBe("09:00");
    expect(result?.isActive).toBe(true);
  });

  it("returns null for a defensively-invalid tz (INV-11) instead of throwing", () => {
    const rules: EngineRule[] = [{ id: "r1", time: "09:00", weekDays: ["mon"], isActive: true }];
    expect(computeNext(rules, "Not/AZone", nowMs)).toBeNull();
  });

  it("DST spring-forward gap: the shared math resolves the first valid instant after the gap (delegation spot-check)", () => {
    // America/New_York spring-forward 2026-03-08; a rule at the nonexistent 02:30 local
    // must delegate to the shared gap policy, not re-derive it here.
    const rules: EngineRule[] = [{ id: "gap", time: "02:30", weekDays: ["sun"], isActive: true }];
    const before = Date.UTC(2026, 2, 7, 12, 0, 0); // Saturday, well before the transition
    const result = computeNext(rules, "America/New_York", before);
    expect(result?.nextAt).not.toBeNull();
    // Sanity: the resolved instant renders as >= 03:00 local (the gap skips 02:00-03:00).
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(result!.nextAt));
    expect(local).toBe("03:00");
  });
});

describe("isFireDue (fire-time re-check against the ARMED instant, never a literal HH:MM comparison)", () => {
  it("false before the armed instant", () => {
    expect(isFireDue(1000, 999, 5000)).toBe(false);
  });

  it("true exactly at the armed instant", () => {
    expect(isFireDue(1000, 1000, 5000)).toBe(true);
  });

  it("true within the staleness window after the armed instant", () => {
    expect(isFireDue(1000, 1000 + 4999, 5000)).toBe(true);
  });

  it("false once drifted past the staleness window (re-evaluate to the NEXT occurrence instead)", () => {
    expect(isFireDue(1000, 1000 + 5001, 5000)).toBe(false);
  });
});

describe("localDateFor / dedupeKey", () => {
  it("localDateFor renders the HOUSEHOLD-local calendar date, not UTC", () => {
    // 2026-08-10T23:30:00Z is already 2026-08-11 01:30 in Europe/Madrid (+2h CEST).
    const instant = Date.UTC(2026, 7, 10, 23, 30, 0);
    expect(localDateFor(instant, "Europe/Madrid")).toBe("2026-08-11");
    expect(localDateFor(instant, "UTC")).toBe("2026-08-10");
  });

  it("dedupeKey composes (local date, HH:MM, ruleId) verbatim", () => {
    expect(dedupeKey("2026-08-11", "09:00", "rule-1")).toBe("2026-08-11|09:00|rule-1");
  });
});

describe("DedupeJournal (D5 — memory Set + bounded localStorage journal, failure-open)", () => {
  it("truth table: fresh journal has not fired; recordFired makes hasFired true; a later re-evaluation of the SAME key stays deduped (replay-safe)", () => {
    const journal = new DedupeJournal(fakeStorage());
    const key = dedupeKey("2026-08-11", "09:00", "r1");

    expect(journal.hasFired(key)).toBe(false);
    journal.recordFired(key);
    expect(journal.hasFired(key)).toBe(true);

    // Re-evaluation replay (visibility resume / safety interval) sees the SAME key again —
    // still deduped, and re-recording is a harmless no-op.
    journal.recordFired(key);
    expect(journal.hasFired(key)).toBe(true);
  });

  it("distinct rules/minutes/dates are independent dedupe entries", () => {
    const journal = new DedupeJournal(fakeStorage());
    journal.recordFired(dedupeKey("2026-08-11", "09:00", "r1"));

    expect(journal.hasFired(dedupeKey("2026-08-11", "09:00", "r2"))).toBe(false);
    expect(journal.hasFired(dedupeKey("2026-08-11", "09:15", "r1"))).toBe(false);
    expect(journal.hasFired(dedupeKey("2026-08-12", "09:00", "r1"))).toBe(false);
  });

  it("4am-reload journal survival: a NEW journal instance (simulating the forced kiosk reload) hydrates from the persisted storage and does not replay the pre-reload minute", () => {
    const storage = fakeStorage();
    const key = dedupeKey("2026-08-11", "09:00", "r1");

    const beforeReload = new DedupeJournal(storage);
    beforeReload.recordFired(key);

    const afterReload = new DedupeJournal(storage); // fresh in-memory Set, same backing storage
    expect(afterReload.hasFired(key)).toBe(true);
  });

  it("bounded cap 64, FIFO: the oldest entries are evicted once the cap is exceeded", () => {
    const storage = fakeStorage();
    const journal = new DedupeJournal(storage);

    for (let i = 0; i < 70; i++) {
      journal.recordFired(dedupeKey("2026-08-11", "09:00", `r${i}`));
    }

    expect(journal.hasFired(dedupeKey("2026-08-11", "09:00", "r0"))).toBe(false); // evicted
    expect(journal.hasFired(dedupeKey("2026-08-11", "09:00", "r5"))).toBe(false); // evicted
    expect(journal.hasFired(dedupeKey("2026-08-11", "09:00", "r69"))).toBe(true); // newest kept

    // Reload from the persisted journal — the cap survives the reload too.
    const reloaded = new DedupeJournal(storage);
    expect(reloaded.hasFired(dedupeKey("2026-08-11", "09:00", "r69"))).toBe(true);
    expect(reloaded.hasFired(dedupeKey("2026-08-11", "09:00", "r0"))).toBe(false);
  });

  it("TIME-ANNOUNCEMENTS-INV-08 direction: a storage read failure at construction degrades to an empty memory-only journal, never throws", () => {
    const storage = fakeStorage({ throwOnGet: true });
    expect(() => new DedupeJournal(storage)).not.toThrow();
    const journal = new DedupeJournal(storage);
    expect(journal.hasFired(dedupeKey("2026-08-11", "09:00", "r1"))).toBe(false);
  });

  it("TIME-ANNOUNCEMENTS-INV-08 direction: a storage write failure degrades to memory-only — recordFired/hasFired still work (failure-open, never silences a speak)", () => {
    const storage = fakeStorage({ throwOnSet: true });
    const journal = new DedupeJournal(storage);
    const key = dedupeKey("2026-08-11", "09:00", "r1");

    expect(() => journal.recordFired(key)).not.toThrow();
    expect(journal.hasFired(key)).toBe(true); // memory-only, but still correctly deduping THIS session
  });

  it("no localStorage at all (default constructor path) never throws", () => {
    expect(() => {
      const journal = new DedupeJournal(null);
      journal.recordFired(dedupeKey("2026-08-11", "09:00", "r1"));
    }).not.toThrow();
  });
});
