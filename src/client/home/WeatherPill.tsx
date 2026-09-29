import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";

import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ForecastResult, WeatherConditionKey, WeatherResponse } from "../../shared";
import { createWeatherFetchGuard, readWeatherCache, writeWeatherCache } from "./weatherCache";
import { formatDayLabel, formatHourLabel, sliceUpcomingHours } from "./weatherFormat";
import { usePresentationMode } from "@/shell/usePresentationMode";

/** Typed condition-key -> label-key map (mirrors ChoresBoard.tsx's `DAY_PERIOD_LABEL_KEYS` /
 * MealsBoard.tsx's `SLOT_LABEL_KEYS`) — removes the three `as MessageKey` casts this file needed
 * for a condition key computed at runtime (SC-007).
 * `WeatherConditionKey` is a closed union (`shared/weather.ts`), so this indexes it exhaustively
 * rather than casting a template string. */
export const WEATHER_CONDITION_LABEL_KEYS: Record<WeatherConditionKey, MessageKey> = {
  clear: "weather.condition.clear",
  mostlyClear: "weather.condition.mostlyClear",
  partlyCloudy: "weather.condition.partlyCloudy",
  overcast: "weather.condition.overcast",
  fog: "weather.condition.fog",
  drizzle: "weather.condition.drizzle",
  freezingDrizzle: "weather.condition.freezingDrizzle",
  rain: "weather.condition.rain",
  freezingRain: "weather.condition.freezingRain",
  snow: "weather.condition.snow",
  snowGrains: "weather.condition.snowGrains",
  rainShowers: "weather.condition.rainShowers",
  snowShowers: "weather.condition.snowShowers",
  thunderstorm: "weather.condition.thunderstorm",
  thunderstormHail: "weather.condition.thunderstormHail",
  unknown: "weather.condition.unknown",
};

/** Periodic freshness recheck: a kiosk left parked on the home
 * route never re-runs the effect below (it depends only on `lat`/`lon`), so without this a
 * forecast fetched once could render, unchanged, for days past the 30-minute cache TTL. This
 * interval just re-invokes the SAME resolve logic the mount effect uses — while the cache
 * entry is still fresh that's a cheap no-op re-render (cache hit, same data); once the entry
 * passes its TTL, `readWeatherCache` starts missing and the exact same cache-miss branch
 * that handles a genuine coordinate change (fetch + clear-first) fires again.
 */
const RECHECK_INTERVAL_MS = 60_000;

function useDeviceClock(active: boolean, language: string): string | null {
  const format = () =>
    new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setTime(null);
      return;
    }
    setTime(format());
    const interval = window.setInterval(() => setTime(format()), 1_000);
    return () => window.clearInterval(interval);
  }, [active, language]);

  return time;
}

/** WeatherPillView — the kiosk home screen's weather pill +
 * modal, taking the household coordinates as PROPS rather than reading them from context
 * directly. Split out from the default-exported `WeatherPill` below (which supplies those
 * props from `useHouseholdSettings`) purely for testability: a component-level test can
 * `rerender` with different `lat`/`lon` to simulate a household location change (A -> B -> A)
 * without needing to drive the full `HouseholdSettingsProvider` fetch machinery .
 * Silent absence is the whole posture (FR-022): no location, no cached-or-fetched data, or
 * ANY fetch failure all render the SAME nothing — no error text, no retry control, no stale
 * badge, ever.
 */
export function WeatherPillView({
  lat,
  lon,
}: {
  lat: number | null;
  lon: number | null;
}): React.JSX.Element | null {
  const { t, language } = useTranslation();
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const guardRef = useRef(createWeatherFetchGuard());
  const presentationMode = usePresentationMode();
  const deviceTime = useDeviceClock(presentationMode && forecast !== null, language);

  useEffect(() => {
    function resolve(): void {
      // advance the generation counter FIRST, before
      // EITHER early-return branch below. A prior version called `guardRef.current.next`
      // only on the fetch path — the blank-location AND cache-hit branches both returned
      // without bumping it, so an A -> B -> A coordinate sequence where B's fetch is still in
      // flight when the household returns to A (a cache hit) left B's stale generation
      // looking "current", letting B's late response overwrite A's correctly-rendered state.
      const generation = guardRef.current.next();

      if (lat === null || lon === null) {
        setForecast(null);
        return;
      }

      const cached = readWeatherCache(lat, lon, Date.now());
      if (cached) {
        setForecast(cached.result);
        return;
      }

      // Cache miss — either coordinates just changed to an uncached location, or a
      // previously-fresh entry just passed its TTL. Either way, clear whatever is currently
      // displayed BEFORE issuing the fetch: WEATHER-AC-06 requires
      // zero renders of the PREVIOUS location's data — a prior version kept showing it until
      // the new fetch resolved (or forever, if it hung).
      setForecast(null);

      authFetch("/api/weather", { credentials: "include" })
        .then((res) => {
          if (!res.ok) throw new Error(`weather: ${res.status}`);
          return res.json() as Promise<WeatherResponse>;
        })
        .then((data) => {
          // In-flight reordering guard (D8/AC-06): a response for coordinates the household
          // has since changed away from is discarded — never rendered.
          if (!guardRef.current.isCurrent(generation)) return;
          if (data.forecast)
            writeWeatherCache(lat, lon, { fetchedAt: Date.now(), result: data.forecast });
          setForecast(data.forecast);
        })
        .catch(() => {
          if (!guardRef.current.isCurrent(generation)) return;
          // FR-022: silent absence — the failure is already recorded server-side
          // (WEATHER-AC-05); the client shows nothing, never an error UI or a retry control.
          setForecast(null);
        });
    }

    resolve();
    const interval = setInterval(resolve, RECHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [lat, lon]);

  if (lat === null || lon === null || forecast === null) return null;

  const conditionLabel = t(WEATHER_CONDITION_LABEL_KEYS[forecast.current.conditionKey]);
  const upcomingHours = sliceUpcomingHours(forecast.hourly, Date.now());

  return (
    <div className="inline-flex items-center gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid="weather-pill"
            // (FR-001/FR-002, SC-001/SC-002): the two density tokens added here —
            // every other class is unchanged (same rounded-pill look, same padding, same card
            // background) — are what let this control grow to the kiosk minimum height/text size
            // like every other migrated control, instead of sitting at the browser's implicit
            // ~36px/14px forever. Without them the frozen density helper cannot even MEASURE this
            // control (`getComputedStyle(...).height` reports the literal string `"auto"`, which
            // resolves to `DensityUnresolvableStyleError` — see this module's own spec for the exact
            // finding and how the deliberate negative in `family-surfaces.test.tsx` proves it).
            className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 h-[var(--control-height)] text-[length:var(--control-font-size)] shadow-xs"
          >
            <span data-testid="weather-pill-condition">{conditionLabel}</span>
            <span data-testid="weather-pill-temp">{Math.round(forecast.current.tempC)}°</span>
            <span data-testid="weather-pill-rain">{forecast.current.rainPct}%</span>
          </button>
        </DialogTrigger>
        <DialogContent
          data-testid="weather-modal"
          closeLabel={t("weather.modal.close")}
          //: `ui/dialog.tsx`'s own default close button (an icon-only
          // `DialogPrimitive.Close` with no density-token classes) is an L1 primitive this module
          // must not edit ("Queued shared paths": `components/ui/*` — touched by the
          // L0/L1 batches only). `ConfirmDialog.tsx` already established the call-site fix for
          // exactly this: opt OUT of the primitive's own close button
          // (`showCloseButton={false}`). NOTE: ConfirmDialog establishes the OPT-OUT only — its
          // close affordances are the footer Cancel/Confirm buttons, and it renders no replacement
          // icon button. Rendering one here is this module's own step, not inherited precedent —
          // same content (a
          // close affordance in the same corner), same behaviour, only the implementation is now
          // the shared, density-aware `Button` (`size="icon"` carries both
          // `h-[var(--control-height)]` and `w-[var(--control-height)]`).
          showCloseButton={false}
        >
          <DialogClose asChild>
            {/* Mirrors `ui/dialog.tsx`'s own default close button's content exactly (icon +
 visually-hidden label text) — only the element rendering it changed, from the
 primitive's bare unstyled button to the shared, density-token-compliant `Button`. */}
            <Button type="button" variant="ghost" size="icon" className="absolute top-4 right-4">
              {/* `size-6` is load-bearing: `Button` carries
 `[&_svg:not([class*=the ize-'])]:size-4`, so without it the glyph would render at
 16px instead of the primitive's 24px — measured in Chromium. Doubling the HIT
 AREA to 48px is the density win; shrinking the glyph on a kiosk is the opposite. */}
              <XIcon className="size-6" />
              <span className="sr-only">{t("weather.modal.close")}</span>
            </Button>
          </DialogClose>
          <DialogHeader>
            <DialogTitle>{t("weather.modal.title")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("weather.modal.description")}
            </DialogDescription>
          </DialogHeader>
          <section>
            <h3>{t("weather.modal.now")}</h3>
            <p>
              {conditionLabel} — {Math.round(forecast.current.tempC)}° — {forecast.current.rainPct}%
            </p>
          </section>
          <section>
            <h3>{t("weather.modal.hourly")}</h3>
            <ul>
              {upcomingHours.map((hour) => (
                <li key={hour.time} data-testid="weather-modal-hour">
                  {formatHourLabel(hour.time, language)} —{" "}
                  {t(WEATHER_CONDITION_LABEL_KEYS[hour.conditionKey])} — {Math.round(hour.tempC)}° —{" "}
                  {hour.rainPct}%
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>{t("weather.modal.daily")}</h3>
            <ul>
              {forecast.daily.map((day) => (
                <li key={day.date} data-testid="weather-modal-day">
                  {formatDayLabel(day.date, language)} —{" "}
                  {t(WEATHER_CONDITION_LABEL_KEYS[day.conditionKey])} — {Math.round(day.tempMinC)}°/
                  {Math.round(day.tempMaxC)}° — {day.rainPct}%
                </li>
              ))}
            </ul>
          </section>
        </DialogContent>
      </Dialog>
      {deviceTime && (
        <time aria-label={t("shell.deviceTime.label")} className="font-medium tabular-nums">
          {deviceTime}
        </time>
      )}
    </div>
  );
}

/** Default export used by `HomeSurface` — supplies `WeatherPillView`'s props from the US0
 * hoist's single `/api/settings` fetch (`useHouseholdSettings`, no second settings call). */
export function WeatherPill(): React.JSX.Element | null {
  const { weatherLat, weatherLon } = useHouseholdSettings();
  return <WeatherPillView lat={weatherLat} lon={weatherLon} />;
}
