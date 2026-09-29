import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

/** — Network Devices i18n parity (per-domain template, see
 * `tests/client/weather-i18n-parity.test.ts`).
 * Locks en/es catalog parity for every `networkDevices.*` key: both locales must define the
 * exact same key set, and every value must be a non-empty string. Parity is repo-global
 * (AGENTS.md), so the whole-catalog check runs here too, not just the domain-scoped slice.
 * (Traces: FR-013, FR-022)
 */
describe("network-devices-i18n-parity", () => {
  const isNetworkDevicesKey = (key: string) => key.startsWith("networkDevices.");

  it("en and es catalogs have identical keys (both directions)", () => {
    const enKeys = Object.keys(messages.en);
    const esKeys = Object.keys(messages.es);

    expect(enKeys).toHaveLength(esKeys.length);
    for (const key of enKeys) expect(esKeys).toContain(key);
    for (const key of esKeys) expect(enKeys).toContain(key);
  });

  it("networkDevices.* keys have identical coverage in en and es (both directions, non-vacuous)", () => {
    const enKeys = Object.keys(messages.en).filter(isNetworkDevicesKey);
    const esKeys = Object.keys(messages.es).filter(isNetworkDevicesKey);

    expect(enKeys.length).toBeGreaterThan(0);
    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) expect(esKeys).toContain(key);
    for (const key of esKeys) expect(enKeys).toContain(key);
  });

  it("networkDevices.* keys resolve to a non-empty string in both languages", () => {
    const enKeys = Object.keys(messages.en).filter(isNetworkDevicesKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it("covers the closed 5-state live-cache taxonomy (FR-020), both languages", () => {
    const states = ["unconfigured", "cold", "stale", "freshEmpty"] as const;
    for (const state of states) {
      const key = `networkDevices.picker.state.${state}` as keyof typeof messages.en;
      expect(messages.en[key]).toBeTruthy();
      expect(messages.es[key]).toBeTruthy();
    }
  });

  it("covers the dedicated register-rejection codes (reselect_required, duplicate_mac), both languages", () => {
    expect(messages.en["networkDevices.error.reselectRequired"]).toBeTruthy();
    expect(messages.es["networkDevices.error.reselectRequired"]).toBeTruthy();
    expect(messages.en["networkDevices.error.duplicateMac"]).toBeTruthy();
    expect(messages.es["networkDevices.error.duplicateMac"]).toBeTruthy();
  });

  it("covers the three 502 controller-degradation states, both languages", () => {
    expect(messages.en["networkDevices.error.controllerUnavailable"]).toBeTruthy();
    expect(messages.es["networkDevices.error.controllerUnavailable"]).toBeTruthy();
    expect(messages.en["networkDevices.error.controllerRejected"]).toBeTruthy();
    expect(messages.es["networkDevices.error.controllerRejected"]).toBeTruthy();
    expect(messages.en["networkDevices.error.controllerUnreachable"]).toBeTruthy();
    expect(messages.es["networkDevices.error.controllerUnreachable"]).toBeTruthy();
  });

  it("covers the belief-divergence affordance keys, both languages", () => {
    expect(messages.en["networkDevices.badge.blockedConfirming"]).toBeTruthy();
    expect(messages.es["networkDevices.badge.blockedConfirming"]).toBeTruthy();
    expect(messages.en["networkDevices.badge.unblockedConfirming"]).toBeTruthy();
    expect(messages.es["networkDevices.badge.unblockedConfirming"]).toBeTruthy();
  });

  it("the delete confirmation for a blocked device names the stranded upstream block, both languages", () => {
    expect(messages.en["networkDevices.action.deleteConfirmBlocked"].toLowerCase()).toContain(
      "block"
    );
    expect(messages.es["networkDevices.action.deleteConfirmBlocked"].toLowerCase()).toContain(
      "bloque"
    );
  });

  it("admin.nav.networkDevices resolves in both languages (exact strings, per admin-nav-i18n-parity precedent)", () => {
    expect(messages.en["admin.nav.networkDevices"]).toBe("Network Devices");
    expect(messages.es["admin.nav.networkDevices"]).toBe("Dispositivos de Red");
  });
});
