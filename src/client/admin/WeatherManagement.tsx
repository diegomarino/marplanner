import { useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { LABEL_INLINE_CLASSES } from "@/lib/recipes";
import type { WeatherSettingsObject } from "../../shared";

/**
 * The household weather location, as a controlled panel: the Settings page owns the values and
 * the single Save. Geolocation only prefills the fields (FR-010); Clear empties them locally and
 * Save persists the result. Unavailable geolocation disables Locate.
 */

export interface WeatherFormState {
  lat: string;
  lon: string;
  label: string;
}

export const EMPTY_WEATHER_FORM: WeatherFormState = { lat: "", lon: "", label: "" };

function formatGeolocationCoordinate(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

export function toWeatherFormState(weather: WeatherSettingsObject): WeatherFormState {
  return {
    lat: weather.lat === null ? "" : String(weather.lat),
    lon: weather.lon === null ? "" : String(weather.lon),
    label: weather.label ?? "",
  };
}

// Plain decimals only: `Number()` would also accept `0x10`, `0b10` or `1e3` and save a
// location other than the one typed.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Why the pair cannot be written: only one coordinate filled, or a non-decimal one. */
export function weatherFormProblem(form: WeatherFormState): "partial" | "invalid" | null {
  const lat = form.lat.trim();
  const lon = form.lon.trim();
  if ((lat === "") !== (lon === "")) return "partial";
  if ((lat !== "" && !DECIMAL.test(lat)) || (lon !== "" && !DECIMAL.test(lon))) {
    return "invalid";
  }
  return null;
}

export function weatherFormDirty(a: WeatherFormState, b: WeatherFormState): boolean {
  return a.lat !== b.lat || a.lon !== b.lon || a.label !== b.label;
}

/**
 * The `weather` settings object to write. The object is replaced as a whole, so a blank label
 * is left out and thereby cleared.
 */
export function weatherPayload(form: WeatherFormState): Record<string, unknown> {
  const lat = form.lat.trim();
  const lon = form.lon.trim();
  const label = form.label.trim();
  const settings: Record<string, unknown> = {
    lat: lat === "" ? null : Number(lat),
    lon: lon === "" ? null : Number(lon),
  };
  if (label !== "") settings.label = label;
  return settings;
}

function hasGeolocation(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

export interface WeatherManagementProps {
  value: WeatherFormState;
  onChange: (patch: Partial<WeatherFormState>) => void;
  disabled?: boolean;
}

export function WeatherManagement({ value, onChange, disabled = false }: WeatherManagementProps) {
  const t = useT();
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function locate() {
    if (!hasGeolocation() || locating) return;
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onChange({
          lat: formatGeolocationCoordinate(position.coords.latitude),
          lon: formatGeolocationCoordinate(position.coords.longitude),
        });
        setLocating(false);
      },
      () => {
        setError(t("weather.management.geolocationError"));
        setLocating(false);
      }
    );
  }

  const problem = weatherFormProblem(value);
  const blank = value.lat === "" && value.lon === "" && value.label === "";

  return (
    <AdminPanel
      title={t("weather.management.title")}
      description={t("weather.management.description")}
      data-testid="weather-management"
    >
      <ErrorNotice message={error} data-testid="weather-error" />

      <div className="bg-card flex flex-col gap-2 rounded-lg p-4 shadow">
        <label className={LABEL_INLINE_CLASSES}>
          {t("weather.management.latLabel")}
          <Input
            type="text"
            inputMode="decimal"
            data-testid="weather-lat-input"
            value={value.lat}
            disabled={disabled}
            onChange={(e) => onChange({ lat: e.target.value })}
            className="w-auto"
          />
        </label>
        <label className={LABEL_INLINE_CLASSES}>
          {t("weather.management.lonLabel")}
          <Input
            type="text"
            inputMode="decimal"
            data-testid="weather-lon-input"
            value={value.lon}
            disabled={disabled}
            onChange={(e) => onChange({ lon: e.target.value })}
            className="w-auto"
          />
        </label>
        <label className={LABEL_INLINE_CLASSES}>
          {t("weather.management.labelLabel")}
          <Input
            type="text"
            data-testid="weather-label-input"
            value={value.label}
            disabled={disabled}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder={t("weather.management.labelPlaceholder")}
            className="w-auto"
          />
        </label>

        {problem !== null && (
          <p data-testid="weather-hint" className="text-muted-foreground text-control">
            {problem === "invalid"
              ? t("admin.settings.weatherInvalid")
              : t("admin.settings.weatherIncomplete")}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="weather-locate"
            disabled={!hasGeolocation() || locating || disabled}
            onClick={locate}
          >
            {locating ? t("weather.management.locating") : t("weather.management.locate")}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="weather-clear"
            disabled={disabled || blank}
            onClick={() => onChange({ lat: "", lon: "", label: "" })}
          >
            {t("weather.management.clear")}
          </Button>
        </div>
      </div>
    </AdminPanel>
  );
}
