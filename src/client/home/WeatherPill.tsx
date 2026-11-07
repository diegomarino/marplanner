import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/credential";
import { cn } from "@/lib/utils";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ForecastResult, WeatherConditionKey, WeatherResponse } from "../../shared";
import { createWeatherFetchGuard, readWeatherCache, writeWeatherCache } from "./weatherCache";
import { formatDayLabel, formatHourLabel, sliceUpcomingHours } from "./weatherFormat";
import { usePresentationMode } from "@/shell/usePresentationMode";
import { WeatherConditionIcon, WeatherGlyph } from "./WeatherIcon";
import type { WeatherIconName } from "../../shared/weather-icons/paths";

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

/** The hourly strip covers the next day; the daily cards carry the rest of the week. */
const MODAL_HOURS = 24;

/** Below this chance of rain the figure is noise: it stays available to assistive technology
 * but is not drawn.
 */
const RAIN_CHANCE_VISIBLE_FROM_PCT = 20;

function SectionHeading({ id, children }: { id: string; children: string }): React.JSX.Element {
  return (
    <h3
      id={id}
      className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </h3>
  );
}

function RainChance({
  pct,
  testId,
  withIcon = false,
}: {
  pct: number;
  testId?: string;
  withIcon?: boolean;
}): React.JSX.Element {
  const visible = pct >= RAIN_CHANCE_VISIBLE_FROM_PCT;
  return (
    <span
      data-testid={testId}
      className={
        visible
          ? "inline-flex items-center text-sm font-medium text-weather-rain tabular-nums"
          : "sr-only"
      }
    >
      {visible && withIcon && <WeatherGlyph name="wi-raindrop" className="text-lg" />}
      {pct}%
    </span>
  );
}

function WeatherFact({
  icon,
  label,
  children,
}: {
  icon: WeatherIconName;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <dt className="inline-flex items-center gap-1 text-muted-foreground">
        <WeatherGlyph name={icon} className="text-xl text-foreground" />
        {label}
      </dt>
      <dd>{children}</dd>
    </>
  );
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
  const { timezone } = useHouseholdSettings();
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

  const { current } = forecast;
  const conditionLabel = t(WEATHER_CONDITION_LABEL_KEYS[current.conditionKey]);
  const upcomingHours = sliceUpcomingHours(forecast.hourly, Date.now(), timezone).slice(
    0,
    MODAL_HOURS
  );
  // Open-Meteo's daily block starts on the household's current date.
  const today = forecast.daily.at(0);
  const todayRange = today ? `${Math.round(today.tempMinC)}–${Math.round(today.tempMaxC)}°` : null;
  const sunTimes =
    current.sunrise && current.sunset
      ? `${formatHourLabel(current.sunrise, language)} – ${formatHourLabel(current.sunset, language)}`
      : null;

  return (
    <div className="inline-flex items-center gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
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
            className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 h-[var(--control-height)] text-control shadow-xs"
          >
            <span data-testid="weather-pill-condition" className="inline-flex text-2xl">
              <WeatherConditionIcon conditionKey={current.conditionKey} isDay={current.isDay} />
              <span className="sr-only">{conditionLabel}</span>
            </span>
            <span
              data-testid="weather-pill-temp"
              className="font-display font-semibold tabular-nums"
            >
              {Math.round(current.tempC)}°
            </span>
            {todayRange && (
              <span
                data-testid="weather-pill-range"
                title={t("weather.pill.range")}
                className="font-normal text-muted-foreground tabular-nums"
              >
                {todayRange}
              </span>
            )}
            <RainChance pct={current.rainPct} testId="weather-pill-rain" withIcon />
          </Button>
        </DialogTrigger>
        <DialogContent
          data-testid="weather-modal"
          closeLabel={t("weather.modal.close")}
          // Escape and a click outside close the dialog, so the "X" is hidden from view. It stays
          // in the focus order for keyboard, switch and screen-reader users, and shows on focus.
          closeClassName="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:bg-card focus-visible:shadow-xs"
          // Taller than a short landscape viewport: scroll inside rather than run off its edges.
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("weather.modal.title")}</DialogTitle>
            <DialogDescription>{t("weather.modal.description")}</DialogDescription>
          </DialogHeader>
          <section
            aria-labelledby="weather-modal-now"
            className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border bg-muted px-5 py-4"
          >
            <h3 id="weather-modal-now" className="sr-only">
              {t("weather.modal.now")}
            </h3>
            <WeatherConditionIcon
              conditionKey={current.conditionKey}
              isDay={current.isDay}
              className="text-7xl"
            />
            <div>
              <p className="font-display text-5xl leading-none font-bold tabular-nums">
                {Math.round(current.tempC)}°C
              </p>
              <p className="mt-1 text-muted-foreground">
                {conditionLabel}
                {todayRange && <span className="tabular-nums"> · {todayRange}</span>}
              </p>
            </div>
            <dl className="ml-auto grid grid-cols-[auto_auto] items-center gap-x-2 gap-y-1 text-sm tabular-nums">
              <WeatherFact icon="wi-raindrop" label={t("weather.modal.rain")}>
                {current.rainPct}%
              </WeatherFact>
              {current.humidityPct !== undefined && (
                <WeatherFact icon="wi-humidity" label={t("weather.modal.humidity")}>
                  {current.humidityPct}%
                </WeatherFact>
              )}
              {current.windKmh !== undefined && (
                <WeatherFact icon="wi-strong-wind" label={t("weather.modal.wind")}>
                  {Math.round(current.windKmh)} km/h
                </WeatherFact>
              )}
              {sunTimes && (
                <WeatherFact icon="wi-sunrise" label={t("weather.modal.sun")}>
                  {sunTimes}
                </WeatherFact>
              )}
            </dl>
          </section>
          <section aria-labelledby="weather-modal-hourly" className="min-w-0">
            <SectionHeading id="weather-modal-hourly">{t("weather.modal.hourly")}</SectionHeading>
            <ul className="flex gap-1 overflow-x-auto pb-2">
              {upcomingHours.map((hour, index) => {
                // `hour.time` is household wall time, so the date prefix marks the day change.
                const startsDay =
                  index > 0 &&
                  hour.time.slice(0, 10) !== upcomingHours[index - 1].time.slice(0, 10);
                return (
                  <li
                    key={hour.time}
                    data-testid="weather-modal-hour"
                    data-day-start={startsDay || undefined}
                    // `relative` anchors the visually hidden labels to their own entry, so the ones
                    // scrolled out of the strip do not widen the dialog.
                    className={cn(
                      "relative flex w-14 shrink-0 flex-col items-center gap-1 tabular-nums",
                      startsDay && "border-l-2 border-muted-foreground/50"
                    )}
                  >
                    <span className="text-sm text-muted-foreground">
                      {formatHourLabel(hour.time, language)}
                    </span>
                    <WeatherConditionIcon
                      conditionKey={hour.conditionKey}
                      isDay={hour.isDay}
                      className="text-3xl"
                    />
                    <span className="sr-only">
                      {t(WEATHER_CONDITION_LABEL_KEYS[hour.conditionKey])}
                    </span>
                    <span className="font-semibold">{Math.round(hour.tempC)}°</span>
                    <RainChance pct={hour.rainPct} />
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-labelledby="weather-modal-daily">
            <SectionHeading id="weather-modal-daily">{t("weather.modal.daily")}</SectionHeading>
            <ul className="grid grid-cols-4 gap-2 sm:grid-cols-7">
              {forecast.daily.map((day) => (
                <li
                  key={day.date}
                  data-testid="weather-modal-day"
                  className="relative flex flex-col items-center gap-1 rounded-2xl bg-muted px-1 py-3 tabular-nums"
                >
                  <span className="text-sm font-medium text-muted-foreground">
                    {formatDayLabel(day.date, language)}
                  </span>
                  <WeatherConditionIcon conditionKey={day.conditionKey} className="text-4xl" />
                  <span className="sr-only">
                    {t(WEATHER_CONDITION_LABEL_KEYS[day.conditionKey])}
                  </span>
                  <span className="font-semibold">{Math.round(day.tempMaxC)}°</span>
                  <span className="text-sm text-muted-foreground">{Math.round(day.tempMinC)}°</span>
                  <RainChance pct={day.rainPct} />
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
