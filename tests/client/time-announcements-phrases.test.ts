import { describe, expect, it } from "vitest";
import { buildPhrase, __testables } from "@/time-announcements/phrases";
import { messages } from "@/i18n/messages";

/** — phrase builder golden tables.
 * `es` reproduces v1's 12-case golden table VERBATIM (the oracle); `en` uses the
 * agreed natural-spoken register. Pure — no clock, no I/O.
 * (Traces: TIME-ANNOUNCEMENTS-AC-05, TIME-ANNOUNCEMENTS-INV-09)
 */
describe("time-announcements phrase builders", () => {
  describe("es golden table — v1's 12-case oracle, verbatim (TIME-ANNOUNCEMENTS-AC-05)", () => {
    const cases: Array<[number, number, string]> = [
      [0, 0, "Es medianoche"],
      [12, 0, "Es mediodía"],
      [1, 0, "Es la una"],
      [5, 0, "Son las cinco"],
      [1, 15, "Es la una y cuarto"],
      [5, 15, "Son las cinco y cuarto"],
      [1, 30, "Es la una y media"],
      [5, 30, "Son las cinco y media"],
      [1, 45, "Son las dos menos cuarto"],
      [5, 45, "Son las seis menos cuarto"],
      [5, 10, "Son las cinco y diez"],
      [5, 50, "Son las seis menos diez"],
    ];

    for (const [hour, minute, expected] of cases) {
      it(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} -> "${expected}"`, () => {
        expect(buildPhrase("es", hour, minute)).toBe(expected);
      });
    }
  });

  describe("en golden table — natural spoken register (TIME-ANNOUNCEMENTS-AC-05)", () => {
    const cases: Array<[number, number, string]> = [
      [0, 0, "It's midnight"],
      [12, 0, "It's twelve noon"],
      [1, 0, "It's one o'clock"],
      [5, 0, "It's five o'clock"],
      [1, 15, "It's quarter past one"],
      [7, 30, "It's half past seven"],
      [5, 45, "It's quarter to six"],
      [23, 45, "It's quarter to twelve"],
    ];

    for (const [hour, minute, expected] of cases) {
      it(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} -> "${expected}"`, () => {
        expect(buildPhrase("en", hour, minute)).toBe(expected);
      });
    }
  });

  describe("representative generic minutes (INV-09 — never silence-crashes on any valid hour/minute)", () => {
    it("es: minute < 30 uses 'y {minute}'", () => {
      expect(buildPhrase("es", 5, 10)).toBe("Son las cinco y diez");
      expect(buildPhrase("es", 1, 5)).toBe("Es la una y cinco");
    });

    it("es: minute > 30 (non-45) uses 'menos {remaining}' against the NEXT hour", () => {
      expect(buildPhrase("es", 5, 50)).toBe("Son las seis menos diez");
      expect(buildPhrase("es", 23, 55)).toBe("Son las doce menos cinco");
    });

    it("en: generic minutes read literally as hour + digital-style minute", () => {
      expect(buildPhrase("en", 5, 10)).toBe("It's five ten");
      expect(buildPhrase("en", 5, 50)).toBe("It's five fifty");
      expect(buildPhrase("en", 5, 5)).toBe("It's five oh five");
      expect(buildPhrase("en", 5, 22)).toBe("It's five twenty-two");
    });

    it("both locales cover all 24 hours x 60 minutes without throwing", () => {
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m++) {
          expect(() => buildPhrase("es", h, m)).not.toThrow();
          expect(() => buildPhrase("en", h, m)).not.toThrow();
          expect(typeof buildPhrase("es", h, m)).toBe("string");
          expect(typeof buildPhrase("en", h, m)).toBe("string");
        }
      }
    });
  });

  describe("missing-es-key fallback (FR-010 edge case: never throws)", () => {
    it("phraseText falls back to the en text when the es catalog is missing a key", () => {
      const key = "timeAnnouncements.phrase.midnight" as const;
      const original = (messages.es as Record<string, string>)[key];
      delete (messages.es as Record<string, string>)[key];
      try {
        expect(__testables.phraseText("es", key)).toBe(messages.en[key]);
      } finally {
        (messages.es as Record<string, string>)[key] = original;
      }
    });
  });

  describe("interpolate() — the module's only templating helper", () => {
    it("substitutes named tokens and leaves an unknown token untouched", () => {
      expect(
        __testables.interpolate("Son las {hour} y {minute}", { hour: "cinco", minute: "diez" })
      ).toBe("Son las cinco y diez");
      expect(__testables.interpolate("hello {missing}", {})).toBe("hello {missing}");
    });
  });
});
