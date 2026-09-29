import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { readEffectiveSettings, writeSettingsObject } from "../../src/server/modules/settings";
import { useIsolatedDb } from "../helpers/db";

describe("settings domain seam", () => {
  useIsolatedDb();

  it("validates seedable locale, weather, printer, and transport objects without implying printer runtime state", () => {
    expect(() =>
      writeSettingsObject("locale", { timezone: "UTC", language: "en", weekStartDay: 0 })
    ).not.toThrow();
    expect(() =>
      writeSettingsObject("weather", { lat: 39.78, lon: -89.64, label: "Springfield" })
    ).not.toThrow();
    const afterPrinterWrite = writeSettingsObject("printer", { paperWidthDots: 576 });
    const afterTransportWrite = writeSettingsObject("printerTransport", {
      deviceId: "local-device",
      name: "Portable printer",
      serviceUuid: "000018F0-0000-1000-8000-00805F9B34FB",
      characteristicUuid: "00002AF1-0000-1000-8000-00805F9B34FB",
    });
    expect(() => writeSettingsObject("printer", { paperWidthDots: 0 })).toThrow("invalid_settings");

    const expectedEffectiveSettings = {
      locale: { timezone: "UTC", language: "en", weekStartDay: 0 },
      weather: { lat: 39.78, lon: -89.64, label: "Springfield" },
      printer: { paperWidthDots: 576 },
      printerTransport: {
        deviceId: "local-device",
        name: "Portable printer",
        serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb",
        characteristicUuid: "00002af1-0000-1000-8000-00805f9b34fb",
      },
    };
    expect(afterPrinterWrite).toMatchObject({ printer: { paperWidthDots: 576 } });
    expect(afterTransportWrite).toMatchObject(expectedEffectiveSettings);
    expect(readEffectiveSettings()).toMatchObject(expectedEffectiveSettings);
    expect(
      getDb().prepare("SELECT object_name FROM settings_objects ORDER BY object_name").all()
    ).toEqual([
      { object_name: "locale" },
      { object_name: "printer" },
      { object_name: "printerTransport" },
      { object_name: "weather" },
    ]);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM printer_capabilities").get()).toEqual({
      count: 0,
    });
  });

  it("keeps settings HTTP routing as an injected adapter rather than a domain dependency", () => {
    const routeSource = readFileSync("src/server/routes/settings.ts", "utf8");
    expect(routeSource).not.toMatch(/modules\/settings/);
    expect(routeSource).toContain("SettingsRouteDependencies");
  });
});
