/** This module was previously untested because migrated surfaces set `data-density` in their
 * own test setup. Cover fresh-device, stored-kiosk, invalid-stored-value, and unavailable-
 * `localStorage` cases here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DENSITY_ATTRIBUTE,
  applyStoredDensity,
  COMFORTABLE_DENSITY,
  KIOSK_DENSITY,
  setDensity,
} from "@/shell/densityAttribute";

const STORAGE_KEY = "marplanner:density";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
  vi.restoreAllMocks();
});

describe("densityAttribute", () => {
  describe("applyStoredDensity", () => {
    it("a fresh device (nothing stored) applies comfortable — no attribute at all", () => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

      applyStoredDensity();

      expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
    });

    it("a device with a stored kiosk choice boots into kiosk", () => {
      window.localStorage.setItem(STORAGE_KEY, KIOSK_DENSITY);

      applyStoredDensity();

      expect(document.documentElement.getAttribute(DENSITY_ATTRIBUTE)).toBe(KIOSK_DENSITY);
    });

    it("a garbage stored value falls back to comfortable", () => {
      window.localStorage.setItem(STORAGE_KEY, "not-a-real-density");

      applyStoredDensity();

      expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
    });

    it("localStorage throwing on read (private browsing / disabled storage) still boots, at comfortable", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });

      expect(() => applyStoredDensity()).not.toThrow();
      expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
    });

    it("LOW-7: never persists — a fresh device stays with nothing stored after boot", () => {
      applyStoredDensity();

      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("LOW-7: applying a stored kiosk choice at boot does not rewrite storage", () => {
      window.localStorage.setItem(STORAGE_KEY, KIOSK_DENSITY);
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

      applyStoredDensity();

      expect(setItemSpy).not.toHaveBeenCalled();
    });
  });

  describe("setDensity", () => {
    it("sets the attribute and persists an explicit kiosk choice", () => {
      setDensity(KIOSK_DENSITY);

      expect(document.documentElement.getAttribute(DENSITY_ATTRIBUTE)).toBe(KIOSK_DENSITY);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(KIOSK_DENSITY);
    });

    it("removes the attribute and persists an explicit comfortable choice", () => {
      document.documentElement.setAttribute(DENSITY_ATTRIBUTE, KIOSK_DENSITY);

      setDensity(COMFORTABLE_DENSITY);

      expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(COMFORTABLE_DENSITY);
    });

    it("localStorage throwing on write still applies the attribute for this page life", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });

      expect(() => setDensity(KIOSK_DENSITY)).not.toThrow();
      expect(document.documentElement.getAttribute(DENSITY_ATTRIBUTE)).toBe(KIOSK_DENSITY);
    });
  });
});
