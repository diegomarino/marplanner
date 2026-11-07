import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/credential";
import type { EffectiveSettings } from "../../shared";

/** HouseholdSettingsProvider — the shell
 * hoist's single settings read. Mounted immediately after the shell's
 * provisioning/ready gate (never before — no pre-gate network probe,
 * FR-031/ADR-059 preserved), it performs ONE `GET /api/settings` per boot and
 * exposes `{ timezone, language, weekStartDay }` via `useHouseholdSettings`
 * to everything mounted below it — `LanguageProvider` (consumes it instead of
 * self-fetching, D3), the headless service point, and any surface that opts
 * in later. A failed or unusable response exposes an error state with nullable
 * settings and an explicit shared retry rather than blocking the shell —
 * downstream consumers each own their own fallback (`LanguageProvider` falls
 * back to English).
 */

export interface HouseholdSettingsValue {
  timezone: string | null;
  language: string | null;
  weekStartDay: number | null;
  /** Household weather location — read from the SAME `EffectiveSettings`
   * payload this provider already fetches once per boot; the kiosk pill (`WeatherPill.tsx`)
   * consumes these instead of issuing its own `/api/settings` call, preserving the "exactly
   * ONE /api/settings fetch per boot" guarantee `shell-service-mount.test.tsx` locks in.
   * `null` for either coordinate means blank (both-or-neither, WEATHER-INV-02) — never
   * partially populated.
   */
  weatherLat: number | null;
  weatherLon: number | null;
  weatherLabel: string | null;
  /** Household completion fanfare switch; `null` until the settings read succeeds. */
  celebrationSound: boolean | null;
}

export interface HouseholdSettingsState extends HouseholdSettingsValue {
  /** The lifecycle of the provider-owned settings read. */
  status: "loading" | "ready" | "error";
  /** Starts a shared retry after an error or unusable successful response. */
  retry: () => void;
}

const EMPTY_SETTINGS: HouseholdSettingsState = {
  status: "loading",
  timezone: null,
  language: null,
  weekStartDay: null,
  weatherLat: null,
  weatherLon: null,
  weatherLabel: null,
  celebrationSound: null,
  retry: () => undefined,
};

const HouseholdSettingsContext = createContext<HouseholdSettingsState | undefined>(undefined);

function usableTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function HouseholdSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<HouseholdSettingsState>(EMPTY_SETTINGS);
  const mounted = useRef(true);
  const requestSequence = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;

    const sequence = ++requestSequence.current;
    setSettings((current) => ({ ...current, status: "loading" }));
    const request = authFetch("/api/settings", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`settings: ${res.status}`);
        return res.json() as Promise<EffectiveSettings>;
      })
      .then((data) => {
        if (!mounted.current || sequence !== requestSequence.current) return;
        const lat = data?.weather?.lat;
        const lon = data?.weather?.lon;
        const timezone = usableTimezone(data?.locale?.timezone) ? data.locale.timezone : null;
        // Both-or-neither (WEATHER-INV-02): a malformed partial pair from the server reads
        // as blank here too, never a half-populated coordinate.
        const bothPresent = typeof lat === "number" && typeof lon === "number";
        setSettings({
          status: timezone ? "ready" : "error",
          timezone,
          language: data?.locale?.language ?? null,
          weekStartDay:
            typeof data?.locale?.weekStartDay === "number" ? data.locale.weekStartDay : null,
          weatherLat: bothPresent ? lat : null,
          weatherLon: bothPresent ? lon : null,
          weatherLabel:
            bothPresent && typeof data?.weather?.label === "string" ? data.weather.label : null,
          celebrationSound:
            typeof data?.celebration?.sound === "boolean" ? data.celebration.sound : null,
          retry: EMPTY_SETTINGS.retry,
        });
      })
      .catch(() => {
        if (!mounted.current || sequence !== requestSequence.current) return;
        setSettings({ ...EMPTY_SETTINGS, status: "error" });
      })
      .finally(() => {
        if (inFlight.current === request) inFlight.current = null;
      });
    inFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();

    return () => {
      mounted.current = false;
      // Do not abort or invalidate the request here: StrictMode replays this effect,
      // and its immediate setup must share the one boot request. `mounted` still
      // prevents a real unmount's late response from committing state.
    };
  }, [load]);

  return (
    <HouseholdSettingsContext.Provider value={{ ...settings, retry: () => void load() }}>
      {children}
    </HouseholdSettingsContext.Provider>
  );
}

/** Raw context accessor — `undefined` when rendered with NO ancestor
 * `HouseholdSettingsProvider` in the tree, distinct from "a provider exists
 * but its fetch hasn't resolved yet" (which is the all-`null` value above).
 * `LanguageProvider` relies on exactly this distinction to
 * decide whether to consume the parent context or fall back to its own
 * legacy self-fetch; most other consumers want the public `useHouseholdSettings`
 * hook below instead.
 */
export function useHouseholdSettingsContext(): HouseholdSettingsState | undefined {
  return useContext(HouseholdSettingsContext);
}

/** Household settings, degrading to all-`null` when rendered outside a provider. */
export function useHouseholdSettings(): HouseholdSettingsState {
  return useHouseholdSettingsContext() ?? EMPTY_SETTINGS;
}
