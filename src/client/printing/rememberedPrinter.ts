/** The printer this browser last paired, kept in `localStorage` so a reload (including the
 * kiosk's daily forced reload) can reconnect without a new gesture. Web Bluetooth device ids
 * are per browser and origin, so this is browser-local state, not a household setting: the
 * server's `printerTransport` object may describe a device paired from another browser.
 * Every storage failure (private mode, quota, disabled storage, a malformed entry) degrades
 * to "nothing remembered", which only means the next session asks for a tap again.
 */
import type { PrinterTransportSettings } from "../../shared";

export const REMEMBERED_PRINTER_KEY = "marplanner.printing.rememberedPrinter.v1";

function isRememberedPrinter(value: unknown): value is PrinterTransportSettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.deviceId === "string" &&
    record.deviceId !== "" &&
    typeof record.name === "string" &&
    typeof record.serviceUuid === "string" &&
    typeof record.characteristicUuid === "string"
  );
}

export function loadRememberedPrinter(): PrinterTransportSettings | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_PRINTER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRememberedPrinter(parsed)) return null;
    return {
      deviceId: parsed.deviceId,
      name: parsed.name,
      serviceUuid: parsed.serviceUuid,
      characteristicUuid: parsed.characteristicUuid,
    };
  } catch {
    return null;
  }
}

export function saveRememberedPrinter(identity: PrinterTransportSettings): void {
  if (!identity.deviceId) return;
  try {
    window.localStorage.setItem(REMEMBERED_PRINTER_KEY, JSON.stringify(identity));
  } catch {
    // Best effort: without storage the next session simply asks for a tap again.
  }
}
