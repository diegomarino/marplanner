import { describe, expect, it } from "vitest";

import { messages } from "@/i18n/messages";

/** — per-domain i18n parity for the telemetry admin panel chrome (row content stays English
 * by design, "Out of Scope"; only this chrome is localized).
 */
const isTelemetryKey = (key: string) =>
  key.startsWith("telemetry.") || key === "admin.nav.telemetry";

describe("telemetry-i18n-parity", () => {
  it("every telemetry key in en exists in es", () => {
    const enKeys = Object.keys(messages.en).filter(isTelemetryKey);

    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      expect(Object.hasOwn(messages.es, key)).toBe(true);
    }
  });

  it("every telemetry key in es exists in en", () => {
    const esKeys = Object.keys(messages.es).filter(isTelemetryKey);

    expect(esKeys.length).toBeGreaterThan(0);
    for (const key of esKeys) {
      expect(Object.hasOwn(messages.en, key)).toBe(true);
    }
  });

  it("telemetry keys resolve to non-empty strings in both languages", () => {
    const keys = Object.keys(messages.en).filter(isTelemetryKey);

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
