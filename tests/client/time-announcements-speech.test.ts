import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** — speech + seams jsdom tests.
 * jsdom has no real `speechSynthesis` — every test installs a fake on
 * `window.speechSynthesis` (or deletes it, to simulate absence). The module holds
 * page-lifetime `primed` state, so each test re-imports it fresh via
 * `vi.resetModules` to avoid state bleed (same pattern as `tests/client/logger.test.ts`).
 * (Traces: TIME-ANNOUNCEMENTS-INV-08, TIME-ANNOUNCEMENTS-INV-09, TIME-ANNOUNCEMENTS-AC-05,
 * TIME-ANNOUNCEMENTS-AC-06, I18N-LOCALIZATION-INV-11)
 */

interface FakeUtterance {
  text: string;
  lang: string;
  volume: number;
  voice: unknown;
}

function installFakeSynth(opts: {
  voices?: Array<{ lang: string }>;
  throwOnSpeak?: boolean;
  throwOnCancel?: boolean;
  throwOnGetVoices?: boolean;
}) {
  const spoken: FakeUtterance[] = [];
  const fake = {
    cancel: vi.fn(() => {
      if (opts.throwOnCancel) throw new Error("cancel blocked");
    }),
    getVoices: vi.fn(() => {
      if (opts.throwOnGetVoices) throw new Error("getVoices blocked");
      return opts.voices ?? [];
    }),
    speak: vi.fn((utterance: FakeUtterance) => {
      if (opts.throwOnSpeak) throw new Error("speak blocked");
      spoken.push(utterance);
    }),
  };
  vi.stubGlobal("speechSynthesis", fake);
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    vi.fn(function (this: FakeUtterance, text: string) {
      this.text = text;
      this.lang = "";
      this.volume = 1;
      this.voice = null;
    })
  );
  return { fake, spoken };
}

/** Reset the module registry ONCE, spy on the (freshly loaded) logger's `log`, THEN load
 * `speech` against that same fresh registry — so `speech`'s (transitive, via `seams`)
 * import of `@/lib/logger` resolves to the SAME spied instance, not a second reset copy.
 */
async function freshSpeechWithLoggerSpy() {
  vi.resetModules();
  const logger = await import("@/lib/logger");
  const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});
  const speech = await import("@/time-announcements/speech");
  return { ...speech, logSpy };
}

async function freshSpeech() {
  vi.resetModules();
  return import("@/time-announcements/speech");
}

describe("time-announcements speech (T006)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("TIME-ANNOUNCEMENTS-INV-09/I18N-LOCALIZATION-INV-11: utterance.lang is ALWAYS the household locale, matching voice present -> no miss logged", async () => {
    const { spoken } = installFakeSynth({ voices: [{ lang: "es-ES" }] });
    const { speak, markPrimed, logSpy } = await freshSpeechWithLoggerSpy();

    markPrimed();
    speak("Son las cinco", "es");

    expect(spoken).toHaveLength(1);
    expect(spoken[0].lang).toBe("es-ES");
    expect(spoken[0].voice).not.toBeNull();
    expect(logSpy).not.toHaveBeenCalledWith(
      "warn",
      "time-announcements",
      "voice-miss",
      expect.anything()
    );
  });

  it("TIME-ANNOUNCEMENTS-AC-05: utterance.lang is set even with NO matching voice, and a voice-miss is logged", async () => {
    const { spoken } = installFakeSynth({ voices: [{ lang: "fr-FR" }] });
    const { speak, markPrimed, logSpy } = await freshSpeechWithLoggerSpy();

    markPrimed();
    speak("It's five o'clock", "en");

    expect(spoken).toHaveLength(1);
    expect(spoken[0].lang).toBe("en-US");
    expect(spoken[0].voice).toBeNull();
    expect(logSpy).toHaveBeenCalledWith("warn", "time-announcements", "voice-miss", {
      lang: "en-US",
    });
  });

  it("TIME-ANNOUNCEMENTS-INV-08: a throwing speechSynthesis.speak is swallowed as a no-op, and the NEXT call still works", async () => {
    const { fake, spoken } = installFakeSynth({ voices: [{ lang: "en-US" }], throwOnSpeak: true });
    const { speak, markPrimed, logSpy } = await freshSpeechWithLoggerSpy();
    markPrimed();

    expect(() => speak("It's midnight", "en")).not.toThrow();
    expect(spoken).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith("warn", "time-announcements", "speech-failed", {
      lang: "en-US",
    });

    // next call, speak no longer throws — proves the failure didn't wedge the module.
    fake.speak.mockImplementation((u: FakeUtterance) => spoken.push(u));
    speak("It's noon", "en");
    expect(spoken).toHaveLength(1);
  });

  it("TIME-ANNOUNCEMENTS-INV-08: an absent speechSynthesis API is a swallowed no-op + logged miss, never a throw", async () => {
    vi.stubGlobal("speechSynthesis", undefined);
    const { speak, markPrimed, logSpy } = await freshSpeechWithLoggerSpy();
    markPrimed();

    expect(() => speak("It's midnight", "en")).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith("warn", "time-announcements", "api-missing", {
      lang: "en-US",
    });
  });

  it("TIME-ANNOUNCEMENTS-INV-08: an unprimed fire is a swallowed no-op + logged miss (no speechSynthesis touch)", async () => {
    const { fake } = installFakeSynth({ voices: [{ lang: "en-US" }] });
    const { speak, logSpy } = await freshSpeechWithLoggerSpy();

    speak("It's midnight", "en");

    expect(fake.speak).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("warn", "time-announcements", "unprimed", {
      lang: "en-US",
    });
  });

  it("primeOnFirstGesture: fires once on the first gesture, then detaches (no double-prime speak)", async () => {
    const { fake, spoken } = installFakeSynth({ voices: [{ lang: "en-US" }] });
    const { primeOnFirstGesture, isPrimed } = await freshSpeech();

    expect(isPrimed()).toBe(false);
    primeOnFirstGesture();

    window.dispatchEvent(new Event("pointerdown"));
    expect(isPrimed()).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].volume).toBe(0);

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));
    expect(fake.speak).toHaveBeenCalledTimes(1); // one-shot — later gestures are no-ops for the primer
  });

  it("testVoice speaks the unsaved time and doubles as a manual primer", async () => {
    const { spoken } = installFakeSynth({ voices: [{ lang: "es-ES" }] });
    const { testVoice, isPrimed } = await freshSpeech();

    expect(isPrimed()).toBe(false);
    testVoice("05:30", "es");

    expect(isPrimed()).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("Son las cinco y media");
    expect(spoken[0].lang).toBe("es-ES");
  });

  describe("sink mirror gate (D9 — window.__mpAnnouncements, DEV/e2e-gated)", () => {
    afterEach(() => {
      delete window.__mpAnnouncements;
    });

    it("mirrors + dispatches a CustomEvent when DEV is on", async () => {
      vi.stubEnv("DEV", true);
      vi.resetModules(); // HOOKS_ENABLED is computed ONCE at module scope — force a fresh read
      const { mirrorAnnouncement, ANNOUNCEMENT_EVENT } = await import("@/time-announcements/seams");
      const handler = vi.fn();
      window.addEventListener(ANNOUNCEMENT_EVENT, handler);

      mirrorAnnouncement({ ruleId: "r1", phrase: "It's midnight", lang: "en", at: 1000 });

      expect(window.__mpAnnouncements?.entries).toEqual([
        { ruleId: "r1", phrase: "It's midnight", lang: "en", at: 1000 },
      ]);
      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener(ANNOUNCEMENT_EVENT, handler);
    });

    it("stays gated off (no window hook, no event) when DEV is off and VITE_E2E_HOOKS is unset", async () => {
      vi.stubEnv("DEV", false);
      vi.stubEnv("VITE_E2E_HOOKS", undefined as unknown as string);
      vi.resetModules();
      const { mirrorAnnouncement, ANNOUNCEMENT_EVENT } = await import("@/time-announcements/seams");
      const handler = vi.fn();
      window.addEventListener(ANNOUNCEMENT_EVENT, handler);

      mirrorAnnouncement({ ruleId: "r1", phrase: "It's midnight", lang: "en", at: 1000 });

      expect(window.__mpAnnouncements).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
      window.removeEventListener(ANNOUNCEMENT_EVENT, handler);
    });

    it("stays enabled when VITE_E2E_HOOKS='true' even with DEV off", async () => {
      vi.stubEnv("DEV", false);
      vi.stubEnv("VITE_E2E_HOOKS", "true");
      vi.resetModules();
      const { mirrorAnnouncement } = await import("@/time-announcements/seams");

      mirrorAnnouncement({ ruleId: "r2", phrase: "It's noon", lang: "en", at: 2000 });

      expect(window.__mpAnnouncements?.entries).toHaveLength(1);
    });

    it("caps the mirrored array at 50 entries (bounded, FIFO)", async () => {
      vi.stubEnv("DEV", true);
      vi.resetModules();
      const { mirrorAnnouncement } = await import("@/time-announcements/seams");

      for (let i = 0; i < 55; i++) {
        mirrorAnnouncement({ ruleId: `r${i}`, phrase: "x", lang: "en", at: i });
      }

      const entries = window.__mpAnnouncements?.entries ?? [];
      expect(entries).toHaveLength(50);
      expect(entries[0].ruleId).toBe("r5"); // oldest 5 evicted
      expect(entries[49].ruleId).toBe("r54");
    });
  });
});
