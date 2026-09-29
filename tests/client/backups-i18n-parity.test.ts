import { describe, expect, it } from "vitest";

import { messages } from "@/i18n/messages";

/** — per-domain i18n parity for the backups admin panel chrome (server-provided error
 * `message` text stays English by design, FR-014's "English operational messages" — only this
 * panel chrome is localized, mirroring telemetry-i18n-parity's `Out of Scope` precedent).
 */
const isBackupsKey = (key: string) => key.startsWith("backups.") || key === "admin.nav.backups";

describe("backups-i18n-parity", () => {
  it("every backups key in en exists in es", () => {
    const enKeys = Object.keys(messages.en).filter(isBackupsKey);

    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      expect(Object.hasOwn(messages.es, key)).toBe(true);
    }
  });

  it("every backups key in es exists in en", () => {
    const esKeys = Object.keys(messages.es).filter(isBackupsKey);

    expect(esKeys.length).toBeGreaterThan(0);
    for (const key of esKeys) {
      expect(Object.hasOwn(messages.en, key)).toBe(true);
    }
  });

  it("backups keys resolve to non-empty strings in both languages", () => {
    const keys = Object.keys(messages.en).filter(isBackupsKey);

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
