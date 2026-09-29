import { useEffect, useState } from "react";

import { StatusToggle } from "@/components/StatusToggle";
import { useT } from "@/i18n";
import {
  applyStoredDensity,
  DENSITY_STORAGE_KEY,
  COMFORTABLE_DENSITY,
  DENSITY_ATTRIBUTE,
  KIOSK_DENSITY,
  setDensity,
  type Density,
} from "./densityAttribute";

/** Per-device kiosk-density control (FR-002, FR-002a).
 * Before this component
 * existed, nothing in production called `setDensity` (`./densityAttribute.ts`) — the
 * mechanism was wired at boot (`applyStoredDensity`, `main.tsx`) but had no
 * caller a family member could actually reach, so kiosk density itself was unreachable by
 * any user despite every migrated surface already honouring it once active.
 * * Shell chrome, not an admin setting* (FR-002a): this is a per-DEVICE choice — this
 * browser's `localStorage`, never the server — so it is mounted in `Shell.tsx` alongside
 * `PrintExecutor` (the printer-card precedent), ONE level above the per-route branch chain,
 * NOT inside `AdminGate`/`AdminPanel`. A parent does not need to unlock the admin PIN to make
 * THIS kiosk touch-friendly, and setting it here never affects any other device.
 * * L2 choice — `StatusToggle`, not a bespoke switch* pressed-state contract, big enough to
 * hit at comfortable density, `aria-pressed` carries the on/off state for free. Per
 * `StatusToggle`'s own doc (`@/components/StatusToggle`): the accessible name MUST be
 * STATE-INVARIANT (`shell.density.accessibleName`, "Kiosk mode"/"Modo kiosco" — names the
 * setting, never the state, because `aria-pressed` already announces that); the visible
 * `label` is free to be action-shaped, so it reads as what a tap DOES
 * (`shell.density.enable`/`shell.density.disable`) — the same convention the chores toggle
 * uses. `StatusToggle` is built on `components/ui/button.tsx`, so it inherits the
 * density-token height/text-size classes for free — this component itself never sets a
 * literal size and stays token-clean without any extra work (it also means the control
 * itself grows once kiosk density is active, so it participates in the interactive-control size
 * census.
 * * Initial state, fresh device (FR-002a)* `applyStoredDensity` runs at boot (`main.tsx`),
 * BEFORE this component ever mounts, and it is the single writer of `data-density` on
 * `document.documentElement` before persistence exists — this component ONLY reads that
 * attribute once, on mount, to decide its initial pressed state, rather than re-deriving the
 * stored choice itself (that private read stays inside `densityAttribute.ts`). A fresh
 * device/profile has nothing stored, `applyStoredDensity` leaves the attribute absent, and
 * this control renders unpressed ("comfortable") — never persisting anything until the
 * family actually taps it.
 */
export function DensityControl() {
  const t = useT();
  const [pressed, setPressed] = useState<boolean>(
    () => document.documentElement.getAttribute(DENSITY_ATTRIBUTE) === KIOSK_DENSITY
  );

  // Cross-tab synchronization: two same-origin tabs on the SAME
  // device are a supported context (the time-announcements leader election exists for it), and
  // localStorage's `storage` event only fires in the OTHER tabs — exactly the ones whose root
  // attribute and pressed state would otherwise go stale until reload, leaving one device
  // operating at two densities (against FR-002's per-device framing). Re-applying through
  // applyStoredDensity keeps densityAttribute.ts the single reader of the stored value; this
  // component mirrors the attribute it already treats as the source of truth.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== DENSITY_STORAGE_KEY) return;
      applyStoredDensity();
      setPressed(document.documentElement.getAttribute(DENSITY_ATTRIBUTE) === KIOSK_DENSITY);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handlePress = () => {
    const next: Density = pressed ? COMFORTABLE_DENSITY : KIOSK_DENSITY;
    setDensity(next);
    setPressed(next === KIOSK_DENSITY);
  };

  return (
    <StatusToggle
      pressed={pressed}
      label={t(pressed ? "shell.density.disable" : "shell.density.enable")}
      accessibleName={t("shell.density.accessibleName")}
      onPress={handlePress}
      data-testid="density-control-toggle"
    />
  );
}
