import { describe, expect, it } from "vitest";

import { messages } from "@/i18n/messages";

const isDailyBriefingKey = (key: string) =>
  key.startsWith("dailyBriefing.") || key === "admin.nav.dailyBriefingManagement";

describe("daily-briefing-i18n-parity", () => {
  it("every daily briefing key in en exists in es", () => {
    const enKeys = Object.keys(messages.en).filter(isDailyBriefingKey);

    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      expect(Object.hasOwn(messages.es, key)).toBe(true);
    }
  });

  it("every daily briefing key in es exists in en", () => {
    const esKeys = Object.keys(messages.es).filter(isDailyBriefingKey);

    expect(esKeys.length).toBeGreaterThan(0);
    for (const key of esKeys) {
      expect(Object.hasOwn(messages.en, key)).toBe(true);
    }
  });

  it("daily briefing keys resolve to non-empty strings in both languages", () => {
    const keys = Object.keys(messages.en).filter(isDailyBriefingKey);

    for (const key of keys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });
});
