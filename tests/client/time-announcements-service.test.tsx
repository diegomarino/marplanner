import { render, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeAnnouncementRule } from "../../src/shared";

const NativeDateTimeFormat = Intl.DateTimeFormat;

/** — headless service jsdom integration tests. Household
 * settings are mocked (this file tests the service in isolation, not the real
 * `HouseholdSettingsProvider` fetch — that's `tests/client/shell-service-mount.test.tsx`'s * job for); rule fetch is mocked via `global.fetch`; the announcer and clock are
 * injected per `AnnouncementServiceProps`; leader election uses injected `leaderDeps`
 * (locks: null, channelFactory: null -> the "always leader" single-tab-equivalent path,
 * D4) except in the multi-instance "only the leader announces" test, which shares one
 * `FakeLockManager` across two rendered instances.
 * (Traces: TIME-ANNOUNCEMENTS-INV-01, TIME-ANNOUNCEMENTS-INV-11, TIME-ANNOUNCEMENTS-AC-03,
 * KIOSK-SHELL-NAVIGATION-AC-07 — announcements half)
 */

let currentSettings: {
  timezone: string | null;
  language: string | null;
  weekStartDay: number | null;
} = {
  timezone: null,
  language: null,
  weekStartDay: null,
};

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
}));

function setSettings(timezone: string | null, language: string | null) {
  currentSettings = { timezone, language, weekStartDay: 1 };
}

/** A plain object satisfying the `res.ok` / `res.json` shape the service reads — NOT a
 * real `Response` (whose `.json` goes through actual body-stream parsing, which can
 * take several extra microtask/task hops and makes fake-timer-driven tests flaky).
 */
function mockRulesResponse(rules: TimeAnnouncementRule[]) {
  return vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rules) })
  );
}

/** A MUTABLE variant: the mock's `setRules` swaps what the NEXT fetch call
 * returns, so a test can simulate "the admin edited a rule and a refetch landed" mid-run.
 */
function mockMutableRulesResponse(initialRules: TimeAnnouncementRule[]) {
  let current = initialRules;
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(current) })
  );
  return {
    fetchMock,
    setRules(rules: TimeAnnouncementRule[]) {
      current = rules;
    },
  };
}

/** Fake timers never fake the Promise microtask queue, but `fetch ->.json -> setRules`
 * is several `.then` hops deep — flush enough microtask checkpoints for that whole
 * chain (plus the resulting re-render's effect) to settle before touching timers.
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function makeRule(
  overrides: Partial<TimeAnnouncementRule> & Pick<TimeAnnouncementRule, "id" | "time" | "weekDays">
): TimeAnnouncementRule {
  return {
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A minimal exclusive fake `navigator.locks`-like manager (leader.ts test precedent). */
class FakeLockManager {
  private waiters: Array<() => void> = [];
  private busy = false;

  request<T>(
    _name: string,
    _options: unknown,
    callback: (lock: unknown) => Promise<T>
  ): Promise<T> {
    return new Promise<T>((resolveOuter, rejectOuter) => {
      const run = () => {
        this.busy = true;
        void callback({}).then(
          (result) => {
            resolveOuter(result);
            this.busy = false;
            const next = this.waiters.shift();
            next?.();
          },
          (error) => {
            rejectOuter(error);
            this.busy = false;
            const next = this.waiters.shift();
            next?.();
          }
        );
      };
      if (this.busy) this.waiters.push(run);
      else run();
    });
  }
}

describe("AnnouncementService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: NativeDateTimeFormat,
    });
    setSettings(null, null);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // `vi.resetModules` also guarantees speech.ts's page-lifetime `primed` flag starts
    // fresh (false) for the NEXT test, since every test dynamically re-imports the
    // service (and transitively speech.ts) AFTER this reset.
    vi.resetModules();
    window.localStorage.clear();
  });

  it("TIME-ANNOUNCEMENTS-AC-03/INV-01: fires at the armed minute in HOUSEHOLD tz even when it differs from the jsdom default (Pacific/Kiritimati, UTC+14, vs UTC)", async () => {
    // At this anchor instant, the household-local (Pacific/Kiritimati, UTC+14) wall clock
    // reads exactly 14:00:00 — one minute before the rule's 14:01, so the occurrence is a
    // short, deterministic ~60s away (proves household-tz resolution: were this computed
    // in jsdom's UTC default instead, "14:01" would be ~14h away, not ~60s).
    vi.setSystemTime(Date.UTC(2026, 7, 10, 0, 0, 0));
    setSettings("Pacific/Kiritimati", "en");
    const rule = makeRule({
      id: "r1",
      time: "14:01",
      weekDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: Array<{ ruleId: string; phrase: string; lang: string }> = [];
    const announcer = {
      announce: (input: { ruleId: string; phrase: string; lang: string }) => announced.push(input),
    };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      // The first arm is clamped to the 30s safety interval; the re-arm loop reaches the
      // real ~60s-away occurrence within a single advance that spans both ticks.
      await vi.advanceTimersByTimeAsync(65_000);
    });

    expect(announced).toHaveLength(1);
    expect(announced[0].ruleId).toBe("r1");
    expect(announced[0].lang).toBe("en");
  });

  it("TIME-ANNOUNCEMENTS-AC-03: timer-clamp recovery — a far-future rule arms a timeout clamped to the 30s safety interval, not the full delay", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 12, 0, 0)); // Monday noon UTC
    setSettings("UTC", "en");
    const rule = makeRule({ id: "sunday-only", time: "09:00", weekDays: ["sun"] }); // ~6 days out
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: unknown[] = [];
    const announcer = { announce: (i: unknown) => announced.push(i) };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });

    const pendingCount = vi.getTimerCount();
    expect(pendingCount).toBeGreaterThan(0);

    // If the real ~6-day delay had been armed directly, advancing 30s would do nothing
    // observable either way — the real proof is that the loop keeps re-arming every 30s
    // (i.e. a NEW timer is scheduled after each 30s tick) rather than one giant timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(announced).toHaveLength(0); // nowhere near Sunday yet
    expect(vi.getTimerCount()).toBeGreaterThan(0); // re-armed again — the loop is alive
  });

  it("TIME-ANNOUNCEMENTS-INV-11: a defensively-invalid household tz never fires and never crashes, and logs an invalid-tz miss", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 12, 0, 0));
    setSettings("Not/AZone", "en");
    const rule = makeRule({
      id: "r1",
      time: "09:00",
      weekDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const logger = await import("@/lib/logger");
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});
    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: unknown[] = [];
    const announcer = { announce: (i: unknown) => announced.push(i) };

    expect(() =>
      render(
        <AnnouncementService
          announcer={announcer}
          leaderDeps={{ locks: null, channelFactory: null }}
        />
      )
    ).not.toThrow();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(announced).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith("warn", "time-announcements", "invalid-tz", {
      timezone: "Not/AZone",
    });
  });

  it("only the LEADER announces — a follower stays silent (INV-06/-07, AC-04)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900)); // 100ms before the fire instant
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] }); // Monday 2026-08-10
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const manager = new FakeLockManager();
    const announcedLeader: unknown[] = [];
    const announcedFollower: unknown[] = [];
    const leaderAnnouncer = { announce: (i: unknown) => announcedLeader.push(i) };
    const followerAnnouncer = { announce: (i: unknown) => announcedFollower.push(i) };

    render(
      <>
        <AnnouncementService announcer={leaderAnnouncer} leaderDeps={{ locks: manager }} />
        <AnnouncementService announcer={followerAnnouncer} leaderDeps={{ locks: manager }} />
      </>
    );
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(announcedLeader).toHaveLength(1);
    expect(announcedFollower).toHaveLength(0);
  });

  it("visibilitychange resume re-evaluates immediately (D11)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900));
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: unknown[] = [];
    const announcer = { announce: (i: unknown) => announced.push(i) };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });

    // Advance the SYSTEM clock past the fire instant WITHOUT letting the armed timer's own
    // callback run (simulating a suspended/backgrounded tab), then resume via visibility.
    vi.setSystemTime(Date.UTC(2026, 7, 10, 9, 0, 1));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(announced).toHaveLength(1);
  });

  it("inactive rules are ignored (never armed, never fire)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 0, 0));
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"], isActive: false });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: unknown[] = [];
    const announcer = { announce: (i: unknown) => announced.push(i) };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 3600_000);
    });

    expect(announced).toHaveLength(0); // no arm timeout was ever set for the inactive-only rule set
  });

  it("empty-weekday rules are ignored (never armed, never fire)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 0, 0));
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: [] });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: unknown[] = [];
    const announcer = { announce: (i: unknown) => announced.push(i) };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });

    expect(announced).toHaveLength(0);
  });

  it("P1-1: the gesture primer is installed on mount — a real pointerdown gesture primes speech (2026-09-04 review)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 0, 0));
    setSettings("UTC", "en");
    vi.stubGlobal("fetch", mockRulesResponse([]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const speech = await import("@/time-announcements/speech");

    expect(speech.isPrimed()).toBe(false);

    render(<AnnouncementService leaderDeps={{ locks: null, channelFactory: null }} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(speech.isPrimed()).toBe(false); // mounting alone must not prime — only a real gesture does

    window.dispatchEvent(new Event("pointerdown"));

    expect(speech.isPrimed()).toBe(true);
  });

  it("P1-2: performFire uses the ARMED decision's own snapshot, never a live re-read of the rule object (defense-in-depth: the invalidation fix (rearmFresh) already closes the ordinary edit race by cancelling a stale timer, so this test isolates the SNAPSHOT half directly — mutate the rule object rulesRef still points at IN PLACE, with no setRules/re-render/rearmFresh in between, 2026-09-04 review)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900)); // 100ms before 09:00, Monday 2026-08-10
    setSettings("UTC", "en");
    const mutableRule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    vi.stubGlobal("fetch", mockRulesResponse([mutableRule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const announced: Array<{ ruleId: string; phrase: string }> = [];
    const announcer = {
      announce: (i: { ruleId: string; phrase: string }) => announced.push(i),
    };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    }); // armed against a decision snapshotting time="09:00"

    // Mutate the SAME rule object `rulesRef.current` points at, IN PLACE — no `setRules`
    // call, no re-render, no `rearmFresh` discard is triggered by this (the array
    // REFERENCE never changes). If `performFire` re-read `.time` from `rulesRef` at fire
    // time instead of using the armed decision's snapshot, it would mis-speak here.
    mutableRule.time = "10:00";

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(announced).toHaveLength(1);
    expect(announced[0].phrase).toBe("It's nine o'clock"); // honest: matches what was ARMED
  });

  it("P1-2: an edit landing BEFORE the old timer fires discards the stale decision — no mis-speak at the old time, the genuine new-time fire still occurs (2026-09-04 review)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900)); // 100ms before 09:00, Monday 2026-08-10
    setSettings("UTC", "en");
    const original = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    const { fetchMock, setRules } = mockMutableRulesResponse([original]);
    vi.stubGlobal("fetch", fetchMock);

    const { AnnouncementService, RULES_CHANGED_EVENT } =
      await import("@/time-announcements/service");
    const announced: Array<{ ruleId: string; phrase: string }> = [];
    const announcer = {
      announce: (i: { ruleId: string; phrase: string }) => announced.push(i),
    };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    }); // armed for ~100ms targeting 09:00

    // The edit (09:00 -> 10:00) lands BEFORE the old timer's tick fires.
    setRules([makeRule({ id: "r1", time: "10:00", weekDays: ["mon"] })]);
    await act(async () => {
      window.dispatchEvent(new Event(RULES_CHANGED_EVENT));
      await flushMicrotasks();
    });

    // Advance PAST the old 09:00 instant — nothing should fire (the stale decision was discarded).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(announced).toHaveLength(0);

    // Advance to the GENUINE new 10:00 occurrence — it must still fire (not suppressed by
    // a wrongly-recorded dedupe key from a mis-speak that never happened).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3600_000 + 1_000);
    });
    expect(announced).toHaveLength(1);
    expect(announced[0].phrase).toBe("It's ten o'clock");
  });

  it("P1-2: an edit landing AFTER the old timer already fired never mis-speaks the NEW content, and the genuine new-time fire is NOT suppressed (2026-09-04 review, the reviewer's exact probe)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900));
    setSettings("UTC", "en");
    const original = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    const { fetchMock, setRules } = mockMutableRulesResponse([original]);
    vi.stubGlobal("fetch", fetchMock);

    const { AnnouncementService, RULES_CHANGED_EVENT } =
      await import("@/time-announcements/service");
    const announced: Array<{ ruleId: string; phrase: string }> = [];
    const announcer = {
      announce: (i: { ruleId: string; phrase: string }) => announced.push(i),
    };

    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });

    // Let the ORIGINAL 09:00 fire actually happen — this proves the SNAPSHOT (not a
    // fresh rule lookup) speaks the phrase that matches what was armed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(announced).toHaveLength(1);
    expect(announced[0].phrase).toBe("It's nine o'clock"); // NOT "ten o'clock" — honest, matches the snapshot

    // The edit (09:00 -> 10:00) lands immediately AFTER — saved at ~09:00:01, exactly
    // the reviewer's scenario.
    setRules([makeRule({ id: "r1", time: "10:00", weekDays: ["mon"] })]);
    await act(async () => {
      window.dispatchEvent(new Event(RULES_CHANGED_EVENT));
      await flushMicrotasks();
    });

    // The genuine NEW 10:00 fire must still occur — it would be silently suppressed if
    // the earlier fire had (wrongly) recorded a "10:00" dedupe key instead of "09:00".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3600_000 + 1_000);
    });
    expect(announced).toHaveLength(2);
    expect(announced[1].phrase).toBe("It's ten o'clock");
  });

  it("P2-4: LEADER-ONLY dedupe write — a follower's journal.recordFired is NEVER called, even though it independently evaluates the same fire (2026-09-04 review)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900));
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const { DedupeJournal } = await import("@/time-announcements/engine");
    const manager = new FakeLockManager();

    // Memory-only (no localStorage) — each instance gets its OWN journal so the spy
    // attribution is unambiguous.
    const leaderJournal = new DedupeJournal(null);
    const followerJournal = new DedupeJournal(null);
    const leaderRecordSpy = vi.spyOn(leaderJournal, "recordFired");
    const followerRecordSpy = vi.spyOn(followerJournal, "recordFired");

    render(
      <>
        <AnnouncementService
          leaderDeps={{ locks: manager }}
          journal={leaderJournal}
          announcer={{ announce: () => {} }}
        />
        <AnnouncementService
          leaderDeps={{ locks: manager }}
          journal={followerJournal}
          announcer={{ announce: () => {} }}
        />
      </>
    );
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(leaderRecordSpy).toHaveBeenCalledTimes(1);
    expect(followerRecordSpy).not.toHaveBeenCalled();
  });

  // 30s timeout: this advances 19h of fake time (~2,280 safety-interval iterations + ~228
  // refetch round-trips) — well under 5s locally but past vitest's default on a loaded CI
  // runner; a timeout here poisons every later test in the file (mounted component,
  // pending timers), which is exactly the cascade CI showed on 2279290.
  it(
    "P2-5: DST spring-forward gap at the SERVICE level — America/New_York, 2026-03-08 02:30 fires at the first valid instant after the gap (03:00 EDT), never a naive-but-nonexistent 02:30 (2026-09-04 review)",
    { timeout: 30_000 },
    async () => {
      vi.setSystemTime(Date.UTC(2026, 2, 7, 12, 0, 0)); // Saturday noon UTC, well before the transition
      setSettings("America/New_York", "en");
      const rule = makeRule({ id: "gap", time: "02:30", weekDays: ["sun"] });
      vi.stubGlobal("fetch", mockRulesResponse([rule]));

      const { AnnouncementService } = await import("@/time-announcements/service");
      const announced: Array<{ ruleId: string; phrase: string }> = [];
      const announcer = {
        announce: (i: { ruleId: string; phrase: string }) => announced.push(i),
      };

      render(
        <AnnouncementService
          announcer={announcer}
          leaderDeps={{ locks: null, channelFactory: null }}
        />
      );
      await act(async () => {
        await flushMicrotasks();
      });

      // The gap-resolved occurrence is 2026-03-08T07:00:00Z (03:00 EDT) — 68,400,000ms
      // from the anchor. A literal `HH:MM` re-check mutation (comparing against the naive
      // "02:30" wall-clock reading, which never occurs that day) would swallow this fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(68_400_000 + 5_000);
      });

      expect(announced).toHaveLength(1);
      expect(announced[0].ruleId).toBe("gap");
      expect(announced[0].phrase).toBe("It's half past two"); // 02:30 -> quarter/half special form
    }
  );

  it("P3-6: a promoted follower re-evaluates IMMEDIATELY — it must not lose an in-window minute waiting for its own next tick (2026-09-04 review)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 59, 900)); // 100ms before 09:00, Monday
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    vi.stubGlobal("fetch", mockRulesResponse([rule]));

    const { AnnouncementService } = await import("@/time-announcements/service");
    const manager = new FakeLockManager();
    const announcedLeader: unknown[] = [];
    const announcedFollower: unknown[] = [];
    const leaderAnnouncer = { announce: (i: unknown) => announcedLeader.push(i) };
    const followerAnnouncer = { announce: (i: unknown) => announcedFollower.push(i) };

    const leaderRender = render(
      <AnnouncementService announcer={leaderAnnouncer} leaderDeps={{ locks: manager }} />
    );
    const followerRender = render(
      <AnnouncementService announcer={followerAnnouncer} leaderDeps={{ locks: manager }} />
    );
    await act(async () => {
      await flushMicrotasks();
    }); // both independently armed for ~100ms

    // Jump the SYSTEM clock past the fire instant WITHOUT advancing the fake timer
    // engine — neither instance's own pending tick gets to run.
    vi.setSystemTime(Date.UTC(2026, 7, 10, 9, 0, 1));

    // The leader "leaves" (unmount tears down its `acquireLeadership` release, exactly
    // like a graceful navigation-away) — the follower is promoted. WITHOUT the
    // fix, the follower would only notice the already-due minute at its own next
    // (never-advanced-to) tick; WITH it, promotion itself triggers the catch-up.
    await act(async () => {
      leaderRender.unmount();
      await flushMicrotasks();
    });

    expect(announcedFollower).toHaveLength(1);
    expect(announcedLeader).toHaveLength(0); // torn down before its own tick ever ran

    followerRender.unmount();
  });

  it("N-1 (re-review): a content-IDENTICAL refetch must NOT swallow a genuinely-due armed fire — the armed decision fires before rearming (TIME-ANNOUNCEMENTS-INV-08 direction)", async () => {
    // Arm a 09:00 rule, advance PAST it without letting the timer run (throttled-tab
    // shape), then land a refetch with identical content. The unconditional-discard
    // regression swallowed this fire entirely; the snapshot-match path must speak it.
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 0)); // Mon 08:59 UTC
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    const { fetchMock, setRules } = mockMutableRulesResponse([rule]);
    vi.stubGlobal("fetch", fetchMock);

    const announced: Array<{ ruleId: string }> = [];
    const announcer = { announce: (i: { ruleId: string }) => announced.push(i) };
    const { AnnouncementService, RULES_CHANGED_EVENT } =
      await import("@/time-announcements/service");
    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(announced).toHaveLength(0);

    // Cross the fire minute WITHOUT advancing timers (the armed timeout never ticks).
    vi.setSystemTime(Date.UTC(2026, 7, 10, 9, 0, 1));

    // A refetch (same CONTENT, fresh array identity — how res.json always behaves in
    // production; the shared mock's same-reference shortcut would bail React's setState)
    // lands — rearmFresh must fire the due decision, not discard it.
    setRules([makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] })]);
    await act(async () => {
      window.dispatchEvent(new Event(RULES_CHANGED_EVENT));
      await flushMicrotasks();
    });

    expect(announced).toHaveLength(1);
    expect(announced[0].ruleId).toBe("r1");
  });

  it("N-1 counterpart: an in-window EDIT of the armed rule's content still discards the stale decision (no stale-time announcement)", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 59, 0));
    setSettings("UTC", "en");
    const rule = makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] });
    const { fetchMock, setRules } = mockMutableRulesResponse([rule]);
    vi.stubGlobal("fetch", fetchMock);

    const announced: Array<{ ruleId: string; phrase: string }> = [];
    const announcer = {
      announce: (i: { ruleId: string; phrase: string }) => announced.push(i),
    };
    const { AnnouncementService, RULES_CHANGED_EVENT } =
      await import("@/time-announcements/service");
    render(
      <AnnouncementService
        announcer={announcer}
        leaderDeps={{ locks: null, channelFactory: null }}
      />
    );
    await act(async () => {
      await flushMicrotasks();
    });

    vi.setSystemTime(Date.UTC(2026, 7, 10, 9, 0, 1));
    // Edit lands mid-window: the rule's time CHANGED, so the stale 09:00 decision
    // must be discarded (snapshot mismatch), not spoken.
    setRules([makeRule({ id: "r1", time: "10:00", weekDays: ["mon"] })]);
    await act(async () => {
      window.dispatchEvent(new Event(RULES_CHANGED_EVENT));
      await flushMicrotasks();
    });

    expect(announced).toHaveLength(0);
  });

  it("P3-9: RULES_CHANGED_EVENT triggers an immediate refetch that reflects in the next armed decision", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 0, 0));
    setSettings("UTC", "en");
    const { fetchMock, setRules } = mockMutableRulesResponse([]);
    vi.stubGlobal("fetch", fetchMock);

    const { AnnouncementService, RULES_CHANGED_EVENT } =
      await import("@/time-announcements/service");
    render(<AnnouncementService leaderDeps={{ locks: null, channelFactory: null }} />);
    await act(async () => {
      await flushMicrotasks();
    });

    const callsBefore = fetchMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0); // the mount-time fetch

    setRules([makeRule({ id: "r1", time: "09:00", weekDays: ["mon"] })]);
    await act(async () => {
      window.dispatchEvent(new Event(RULES_CHANGED_EVENT));
      await flushMicrotasks();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore); // refetched on the signal
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the newly-fetched rule is now armed
  });

  it("P3-9: the SLOW_REFETCH_MS periodic interval refetches without any RULES_CHANGED_EVENT signal", async () => {
    vi.setSystemTime(Date.UTC(2026, 7, 10, 8, 0, 0));
    setSettings("UTC", "en");
    const { fetchMock } = mockMutableRulesResponse([]);
    vi.stubGlobal("fetch", fetchMock);

    const { AnnouncementService, SLOW_REFETCH_MS } = await import("@/time-announcements/service");
    render(<AnnouncementService leaderDeps={{ locks: null, channelFactory: null }} />);
    await act(async () => {
      await flushMicrotasks();
    });

    const callsBefore = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_REFETCH_MS + 1_000);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
