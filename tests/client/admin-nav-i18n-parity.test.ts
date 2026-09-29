import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

describe("admin-nav-i18n-parity", () => {
  it("en and es catalogs have identical keys (both directions)", () => {
    const enKeys = Object.keys(messages.en);
    const esKeys = Object.keys(messages.es);

    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) {
      expect(esKeys).toContain(key);
    }

    for (const key of esKeys) {
      expect(enKeys).toContain(key);
    }
  });

  // Only the post-unlock admin navigation is localized under ADR-061; the pre-unlock
  // affordance and PIN gate stay English.
  it("admin.nav.* label keys resolve in both languages", () => {
    expect(messages.en["admin.nav.memberCreate"]).toBe("Member Create");
    expect(messages.en["admin.nav.membersManagement"]).toBe("Members Management");
    expect(messages.en["admin.nav.dayPeriods"]).toBe("Day Periods");

    expect(messages.es["admin.nav.memberCreate"]).toBe("Crear Miembro");
    expect(messages.es["admin.nav.membersManagement"]).toBe("Gestión de Miembros");
    expect(messages.es["admin.nav.dayPeriods"]).toBe("Períodos Diarios");
  });
});
