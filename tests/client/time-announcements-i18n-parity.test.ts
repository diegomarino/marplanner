import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

/** — time-announcements i18n parity (per-domain template, see e.g.
 * `tests/client/daily-messages-i18n-parity.test.ts`).
 * Locks en/es catalog parity for every `timeAnnouncements.*` key: both locales must
 * define the exact same key set, and every value must be a non-empty string.
 * (Traces: TIME-ANNOUNCEMENTS-AC-05, TIME-ANNOUNCEMENTS-INV-09, I18N-LOCALIZATION-INV-11)
 */
describe("time-announcements-i18n-parity", () => {
  const isTimeAnnouncementsKey = (key: string) => key.startsWith("timeAnnouncements.");

  it("en and es catalogs have identical keys (both directions)", () => {
    const enKeys = Object.keys(messages.en);
    const esKeys = Object.keys(messages.es);

    expect(enKeys).toHaveLength(esKeys.length);
    for (const key of enKeys) expect(esKeys).toContain(key);
    for (const key of esKeys) expect(enKeys).toContain(key);
  });

  it("timeAnnouncements.* keys have identical coverage in en and es (both directions, non-vacuous)", () => {
    const enKeys = Object.keys(messages.en).filter(isTimeAnnouncementsKey);
    const esKeys = Object.keys(messages.es).filter(isTimeAnnouncementsKey);

    // Sanity: this module actually added keys in this namespace.
    expect(enKeys.length).toBeGreaterThan(0);
    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) expect(esKeys).toContain(key);
    for (const key of esKeys) expect(enKeys).toContain(key);
  });

  it("timeAnnouncements.* keys resolve to a non-empty string in both languages", () => {
    const enKeys = Object.keys(messages.en).filter(isTimeAnnouncementsKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });
});
