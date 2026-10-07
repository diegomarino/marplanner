import { useEffect, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import type { EffectiveSettings, WeatherSettingsObject } from "../../shared";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_INLINE_CLASSES } from "@/lib/recipes";

/**
 * Edit the household weather location. Geolocation only prefills inputs; Save persists them.
 * Fetch settings on each mount because the household context does not refresh after writes.
 * A stale context would seed an empty form and could overwrite the saved location.
 * Clear is immediate; unavailable geolocation disables Locate.
 */

type ApiErrorBody = { message?: unknown };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
  return typeof data?.message === "string" ? data.message : fallback;
}

/** Thrown ONLY after a non-ok response body has been parsed (P2): its
 * `.message` is either the server's own parsed error message, or an already-localized
 * fallback (`t(fallbackErrorKey)`) when the body carried none — either way, safe to render
 * verbatim. Any OTHER exception reaching `writeWeather`'s catch — most notably `authFetch`
 * itself REJECTING before a response exists (offline/transport failure, a native
 * `TypeError` with the browser's own English message) — is distinguished structurally by
 * NOT being this type, so it always renders the localized fallback key instead of a raw,
 * unlocalized `TypeError` message.
 */
class WeatherSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherSaveError";
  }
}

interface WeatherFormState {
  lat: string;
  lon: string;
  label: string;
}

const EMPTY_FORM: WeatherFormState = { lat: "", lon: "", label: "" };

function formatGeolocationCoordinate(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function toFormState(weather: WeatherSettingsObject | undefined): WeatherFormState {
  if (!weather) throw new Error("Weather settings are unavailable");
  return {
    lat: weather.lat === null ? "" : String(weather.lat),
    lon: weather.lon === null ? "" : String(weather.lon),
    label: weather.label ?? "",
  };
}

function hasGeolocation(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

export function WeatherManagement() {
  const t = useT();

  const [form, setForm] = useState<WeatherFormState>(EMPTY_FORM);
  const [persistedForm, setPersistedForm] = useState<WeatherFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/settings", { credentials: "include" });
      if (!response.ok) throw new Error("load failed");
      const data = (await response.json()) as EffectiveSettings;
      const nextForm = toFormState(data.weather);
      setForm(nextForm);
      setPersistedForm(nextForm);
      setSaved(false);
    } catch {
      setError(t("weather.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  function locate() {
    if (!hasGeolocation() || locating) return;
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // Prefill only — NEVER persisted until Save is explicitly clicked (FR-010).
        setForm((prev) => ({
          ...prev,
          lat: formatGeolocationCoordinate(position.coords.latitude),
          lon: formatGeolocationCoordinate(position.coords.longitude),
        }));
        setSaved(false);
        setLocating(false);
      },
      () => {
        setError(t("weather.management.geolocationError"));
        setLocating(false);
      }
    );
  }

  async function writeWeather(
    settings: Record<string, unknown>,
    fallbackErrorKey: MessageKey
  ): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch("/api/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ object: "weather", settings }),
      });
      if (!response.ok) {
        throw new WeatherSaveError(await responseMessage(response, t(fallbackErrorKey)));
      }
      const data = (await response.json()) as EffectiveSettings;
      const nextForm = toFormState(data.weather);
      setForm(nextForm);
      setPersistedForm(nextForm);
      return true;
    } catch (cause) {
      // Only a WeatherSaveError's message is a deliberately parsed/localized string safe to
      // show verbatim — anything else (e.g. authFetch REJECTING pre-response on a transport
      // failure) falls back to the localized key, never a raw native exception message.
      setError(cause instanceof WeatherSaveError ? cause.message : t(fallbackErrorKey));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (saving || saveDisabled) return;
    const latTrim = form.lat.trim();
    const lonTrim = form.lon.trim();
    const labelTrim = form.label.trim();
    const settings: Record<string, unknown> = {
      lat: latTrim === "" ? null : Number(latTrim),
      lon: lonTrim === "" ? null : Number(lonTrim),
    };
    if (labelTrim !== "") settings.label = labelTrim;
    if (await writeWeather(settings, "weather.management.saveError")) {
      setSaved(true);
    }
  }

  async function clearLocation() {
    if (saving) return;
    if (await writeWeather({ lat: null, lon: null }, "weather.management.clearError")) {
      setSaved(false);
    }
  }

  const latTrim = form.lat.trim();
  const lonTrim = form.lon.trim();
  const latEmpty = latTrim === "";
  const lonEmpty = lonTrim === "";
  const partial = latEmpty !== lonEmpty;
  const latInvalid = !latEmpty && !Number.isFinite(Number(latTrim));
  const lonInvalid = !lonEmpty && !Number.isFinite(Number(lonTrim));
  const dirty =
    form.lat !== persistedForm.lat ||
    form.lon !== persistedForm.lon ||
    form.label !== persistedForm.label;
  const saveDisabled = saving || !dirty || partial || latInvalid || lonInvalid;

  if (loading) {
    return (
      <AdminPanel title={t("weather.management.title")}>
        <p className="text-muted-foreground text-control">{t("weather.management.loading")}</p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("weather.management.title")}
      description={t("weather.management.description")}
      data-testid="weather-management"
    >
      <ErrorNotice message={error} data-testid="weather-error" />

      <div className="bg-card p-4 rounded-lg shadow flex flex-col gap-2">
        <label className={LABEL_INLINE_CLASSES}>
          {t("weather.management.latLabel")}
          <Input
            type="number"
            step="any"
            data-testid="weather-lat-input"
            value={form.lat}
            onChange={(e) => {
              setForm({ ...form, lat: e.target.value });
              setSaved(false);
            }}
            className="w-auto"
          />
        </label>
        <label className={LABEL_INLINE_CLASSES}>
          {t("weather.management.lonLabel")}
          <Input
            type="number"
            step="any"
            data-testid="weather-lon-input"
            value={form.lon}
            onChange={(e) => {
              setForm({ ...form, lon: e.target.value });
              setSaved(false);
            }}
            className="w-auto"
          />
        </label>
        <label className={LABEL_INLINE_CLASSES}>
          {t("weather.management.labelLabel")}
          <Input
            type="text"
            data-testid="weather-label-input"
            value={form.label}
            onChange={(e) => {
              setForm({ ...form, label: e.target.value });
              setSaved(false);
            }}
            placeholder={t("weather.management.labelPlaceholder")}
            className="w-auto"
          />
        </label>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="weather-locate"
            disabled={!hasGeolocation() || locating || saving}
            onClick={locate}
          >
            {locating ? t("weather.management.locating") : t("weather.management.locate")}
          </Button>
          <Button
            type="button"
            data-testid="weather-save"
            disabled={saveDisabled}
            onClick={() => void save()}
          >
            {saving
              ? t("weather.management.saving")
              : saved
                ? `✓ ${t("weather.management.save")}`
                : t("weather.management.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="weather-clear"
            disabled={saving}
            onClick={() => void clearLocation()}
          >
            {t("weather.management.clear")}
          </Button>
        </div>
      </div>
    </AdminPanel>
  );
}
