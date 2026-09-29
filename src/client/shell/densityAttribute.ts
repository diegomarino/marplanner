/** Density attribute writer (FR-001, FR-002, FR-002a).
 * CSS cannot set an attribute on the document root, so the token layer in
 * `src/client/styles/globals.css` (`:root[data-density="kiosk"]`) is inert
 * until something writes `data-density` onto `document.documentElement`. This
 * is that something — called once at client boot from `src/client/main.tsx`,
 * before the app renders, so the attribute is never absent because "nothing
 * wrote it yet" (every later migration batch's density test depends on that).
 * Per-device only (FR-002a): the choice lives in this browser's
 * `localStorage`, never on the server — no settings object, no admin action,
 * no other device is affected. A fresh device or browser profile has nothing
 * stored and starts at the comfortable default. The
 * user-facing control that calls `setDensity` is `src/client/shell/DensityControl.tsx`,
 * built separately from this mechanism; this file only owns the
 * mechanism and the boot-time application of whatever was last chosen on
 * this device.
 * "comfortable" is applied by REMOVING the attribute rather than writing
 * `data-density="comfortable"` explicitly — matching both the CSS token
 * layer's base `:root` values (no attribute needed) and the frozen density
 * helper's check (`tests/client/helpers/density.ts`), which treats an absent
 * attribute and an explicit "comfortable" identically.
 */

export const DENSITY_ATTRIBUTE = "data-density";
export const COMFORTABLE_DENSITY = "comfortable";
export const KIOSK_DENSITY = "kiosk";

export type Density = typeof COMFORTABLE_DENSITY | typeof KIOSK_DENSITY;

export const DENSITY_STORAGE_KEY = "marplanner:density";

function isDensity(value: string | null): value is Density {
  return value === COMFORTABLE_DENSITY || value === KIOSK_DENSITY;
}

/** Reads this device's stored density choice, defaulting to comfortable when
 * nothing was ever stored (fresh device/profile) or storage is unavailable
 * (private browsing, disabled storage) — never throws during boot. */
function readStoredDensity(): Density {
  try {
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    return isDensity(stored) ? stored : COMFORTABLE_DENSITY;
  } catch {
    return COMFORTABLE_DENSITY;
  }
}

/** Applies `density` to the document root ONLY — no persistence. Shared by `setDensity` (which
 * persists on top of this) and `applyStoredDensity` (which must NOT persist — see below). */
function applyDensityAttribute(density: Density): void {
  if (density === COMFORTABLE_DENSITY) {
    document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(DENSITY_ATTRIBUTE, density);
  }
}

/** Applies `density` to the document root and persists the choice for this
 * device. `DensityControl.tsx` calls this directly; boot does NOT call
 * this (see `applyStoredDensity` below) — boot must not turn "nothing was
 * ever chosen" into a persisted, explicit choice.
 */
export function setDensity(density: Density): void {
  applyDensityAttribute(density);
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Storage unavailable: the attribute above still applies for this page
    // life; a future load falls back to comfortable, the documented cost of
    // FR-002a's "set once per device" tradeoff.
  }
}

/** Applies this device's stored density (or the comfortable default) to the
 * document root. Called once at client boot, before the app renders.
 * Deliberately does NOT call `setDensity`: `setDensity` persists, and re-persisting "comfortable" on every
 * boot of a fresh device would turn "the user never chose a density" into
 * "the user explicitly chose comfortable" in `localStorage` — a distinction
 * `DensityControl.tsx` needs (e.g. to decide whether to show a
 * first-run hint).
 * Applying without persisting means a stored value is always the result of an
 * actual `setDensity` call, i.e. an actual user choice.
 */
export function applyStoredDensity(): void {
  applyDensityAttribute(readStoredDensity());
}
