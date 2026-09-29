import { describe, expect, it } from "vitest";

import { messages } from "@/i18n/messages";

/** — per-domain i18n parity for the WHOLE printing surface (executor +
 * admin panel) — parity is repo-global, so this covers both `printing.*` prefixes and
 * `admin.nav.printing` together (backups-i18n-parity's filter-based precedent).
 */
const isPrintingKey = (key: string) => key.startsWith("printing.") || key === "admin.nav.printing";

describe("printing-i18n-parity", () => {
  it("every printing key in en exists in es", () => {
    const enKeys = Object.keys(messages.en).filter(isPrintingKey);

    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      expect(Object.hasOwn(messages.es, key)).toBe(true);
    }
  });

  it("every printing key in es exists in en", () => {
    const esKeys = Object.keys(messages.es).filter(isPrintingKey);

    expect(esKeys.length).toBeGreaterThan(0);
    for (const key of esKeys) {
      expect(Object.hasOwn(messages.en, key)).toBe(true);
    }
  });

  it("printing keys resolve to non-empty strings in both languages", () => {
    const keys = Object.keys(messages.en).filter(isPrintingKey);

    for (const key of keys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  // SC-003 — dead-letter/retrying must be their OWN keys, never aliases of "pending"the key.
  it("dead-letter and retrying are distinct keys from pending (SC-003, no false-green collapse)", () => {
    expect(messages.en["printing.management.state.deadLetter"]).toBeDefined();
    expect(messages.en["printing.management.state.retrying"]).toBeDefined();
    expect(messages.en["printing.management.state.deadLetter"]).not.toBe(
      messages.en["printing.management.state.pending"]
    );
    expect(messages.en["printing.management.state.retrying"]).not.toBe(
      messages.en["printing.management.state.pending"]
    );
    expect(messages.es["printing.management.state.deadLetter"]).not.toBe(
      messages.es["printing.management.state.pending"]
    );
    expect(messages.es["printing.management.state.retrying"]).not.toBe(
      messages.es["printing.management.state.pending"]
    );
  });

  it("admin.nav.printing resolves in both languages", () => {
    expect(messages.en["admin.nav.printing"]).toBe("Printing");
    expect(messages.es["admin.nav.printing"]).toBe("Impresión");
  });
});
