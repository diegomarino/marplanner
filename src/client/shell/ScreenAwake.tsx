import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { log } from "@/lib/logger";
import type { DayPeriodDTO } from "../../shared";
import { resolveActivePeriod } from "../../shared/dayPeriods";
import {
  loadScreenAwakePreferences,
  SCREEN_AWAKE_CHANGE_EVENT,
  SCREEN_AWAKE_STORAGE_KEY,
  screenAwakeSupport,
  type ScreenAwakePreferences,
} from "./screenAwake";

/** How long a tap lifts the night dimming before it settles again. */
export const NIGHT_PEEK_MS = 5 * 60_000;
const CLOCK_TICK_MS = 30_000;

/** Wall-clock minutes since midnight in `timezone`, or in the browser's zone when it is null. */
export function wallClockMinutes(now: Date, timezone: string | null): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    ...(timezone ? { timeZone: timezone } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(fields.hour) * 60 + Number(fields.minute);
}

function useScreenAwakePreferences(): ScreenAwakePreferences {
  const [preferences, setPreferences] = useState(loadScreenAwakePreferences);
  useEffect(() => {
    const reload = () => setPreferences(loadScreenAwakePreferences());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === SCREEN_AWAKE_STORAGE_KEY) reload();
    };
    window.addEventListener(SCREEN_AWAKE_CHANGE_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SCREEN_AWAKE_CHANGE_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return preferences;
}

/** True while the household's `night` day period is active. The catalog is read only while the
 * feature is on, so a device that never enables it makes no extra request. A failed read means
 * "never night": the screen simply stays awake. */
function useIsNight(enabled: boolean): boolean {
  const { timezone } = useHouseholdSettings();
  const [periods, setPeriods] = useState<DayPeriodDTO[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authFetch("/api/day-periods", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`list day-periods: ${res.status}`);
        return res.json() as Promise<DayPeriodDTO[]>;
      })
      .then((data) => {
        if (!cancelled) setPeriods(data);
      })
      .catch((err: unknown) => {
        log("warn", "screen-awake", "day_periods_unavailable", { detail: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  if (!enabled || !periods || periods.length === 0) return false;
  // A malformed catalog must never take the always-mounted shell down: treat it as daytime.
  try {
    return resolveActivePeriod(periods, wallClockMinutes(new Date(now), timezone)) === "night";
  } catch {
    return false;
  }
}

/** Holds a screen wake lock while `active`, re-acquiring it whenever the page becomes visible
 * again: the browser drops the lock on its own when the tab is hidden or the device locks. */
function useWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || screenAwakeSupport() !== "supported") return;
    let disposed = false;

    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      if (sentinel.current && !sentinel.current.released) return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (disposed) {
            void lock.release();
            return;
          }
          sentinel.current = lock;
        })
        .catch((err: unknown) => {
          log("warn", "screen-awake", "wake_lock_refused", { detail: String(err) });
        });
    };

    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      const lock = sentinel.current;
      sentinel.current = null;
      if (lock && !lock.released) void lock.release();
    };
  }, [active]);
}

/** Always-mounted, per-device keep-awake service (see `screenAwake.ts`). Renders nothing unless
 * the night dimming layer is showing. */
export function ScreenAwake(): React.JSX.Element | null {
  const t = useT();
  const preferences = useScreenAwakePreferences();
  const isNight = useIsNight(preferences.enabled);
  const [peeking, setPeeking] = useState(false);

  const nightOff = isNight && preferences.night === "off";
  useWakeLock(preferences.enabled && !nightOff);

  useEffect(() => {
    if (!peeking) return;
    const timer = setTimeout(() => setPeeking(false), NIGHT_PEEK_MS);
    return () => clearTimeout(timer);
  }, [peeking]);

  const peek = useCallback(() => setPeeking(true), []);

  const dimmed = preferences.enabled && isNight && preferences.night === "dim" && !peeking;
  if (!dimmed) return null;
  // A pointer-down anywhere on the layer lifts it; the layer itself swallows that touch, so the
  // first tap of the night never lands on a chore or a meal underneath.
  return (
    <div
      data-testid="screen-awake-night-dim"
      role="presentation"
      title={t("screenAwake.night.wake")}
      onPointerDown={peek}
      className="screen-awake-night-dim"
    />
  );
}
