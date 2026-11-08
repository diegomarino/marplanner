/** Keep-screen-awake preferences (per device).
 * A kiosk tablet should not go dark between glances, so this device can hold a Screen Wake Lock
 * (`navigator.wakeLock.request("screen")`). The choice is browser-local, like density and the
 * remembered printer: it lives in `localStorage`, never on the server, so turning it on for the
 * kitchen tablet leaves every other device alone.
 * `night` decides what happens during the household's `night` day period:
 * - `"off"`: release the lock and let the operating system turn the screen off. A web page
 *   cannot turn a screen back on, so it stays dark until someone touches it.
 * - `"dim"`: keep the lock and cover the page with a near-black layer, which lifts by itself
 *   when `night` ends (and for a while after a tap).
 * Every storage failure degrades to the defaults (off), never to a throw.
 */

export type ScreenAwakeNight = "off" | "dim";

export interface ScreenAwakePreferences {
  enabled: boolean;
  night: ScreenAwakeNight;
}

export const SCREEN_AWAKE_STORAGE_KEY = "marplanner.screenAwake.v1";
/** Dispatched on `window` after this tab saves, so the running service picks the change up at
 * once; other tabs hear the native `storage` event instead. */
export const SCREEN_AWAKE_CHANGE_EVENT = "marplanner:screen-awake-change";

/** Dispatched on `window` after this device saves a day-period boundary, so the keep-awake
 * service re-reads the catalog at once instead of dimming at the old time. Edits made on another
 * device reach it through the service's periodic re-read. */
export const DAY_PERIODS_CHANGED_EVENT = "marplanner:day-periods-changed";

export const DEFAULT_SCREEN_AWAKE: ScreenAwakePreferences = { enabled: false, night: "dim" };

export function loadScreenAwakePreferences(): ScreenAwakePreferences {
  try {
    const raw = window.localStorage.getItem(SCREEN_AWAKE_STORAGE_KEY);
    if (!raw) return DEFAULT_SCREEN_AWAKE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SCREEN_AWAKE;
    const record = parsed as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      night: record.night === "off" ? "off" : "dim",
    };
  } catch {
    return DEFAULT_SCREEN_AWAKE;
  }
}

export function saveScreenAwakePreferences(preferences: ScreenAwakePreferences): void {
  try {
    window.localStorage.setItem(SCREEN_AWAKE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable: the change still applies to this page life through the event below.
  }
  window.dispatchEvent(new CustomEvent(SCREEN_AWAKE_CHANGE_EVENT, { detail: preferences }));
}

export type ScreenAwakeSupport = "supported" | "insecure-context" | "unsupported";

/** Whether this browser can hold a screen wake lock here. The API only exists in a secure
 * context (HTTPS or localhost), so a kiosk opened over plain `http://` on the LAN reports
 * `insecure-context` rather than a misleading "unsupported browser". */
export function screenAwakeSupport(): ScreenAwakeSupport {
  if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
    return "insecure-context";
  }
  return typeof navigator !== "undefined" && "wakeLock" in navigator ? "supported" : "unsupported";
}
