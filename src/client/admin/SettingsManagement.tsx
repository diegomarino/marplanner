import { useEffect, useMemo, useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ChoicePills } from "@/components/ChoicePills";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettingsContext } from "@/lib/householdSettings";
import { PluginContribution } from "@/plugins/contributions";
import type { EffectiveSettings, LocaleObject } from "../../shared";
import { DayPeriodsManagement } from "./DayPeriodsManagement";
import { timeZoneGroups } from "./timezones";
import {
  WeatherManagement,
  toWeatherFormState,
  weatherFormDirty,
  weatherFormProblem,
  weatherPayload,
  type WeatherFormState,
} from "./WeatherManagement";

/**
 * The household-wide settings on one page: language, week start and time zone, the weather
 * location, then the day periods. One Save writes the first two groups (up to two requests, the
 * settings API takes one object per write); the day periods keep their own save. Settings are
 * read on each mount, because the household context does not refresh after a write; saving asks
 * it to reload so the rest of the app follows.
 */

const SAVED_VISIBLE_MS = 3000;

interface SettingsFormState {
  locale: LocaleObject;
  /** null: the weather plugin contributes no settings, so none are shown or written. */
  weather: WeatherFormState | null;
}

function fromSettings(data: EffectiveSettings): SettingsFormState {
  return { locale: data.locale, weather: data.weather ? toWeatherFormState(data.weather) : null };
}

/** A setting drawn as a caption, a description and a one-of-few choice. */
function ChoiceRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: T;
  options: { value: T; label: string; testId: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-control font-semibold">{label}</span>
      <p className="text-muted-foreground text-control">{description}</p>
      <ChoicePills
        value={value}
        onChange={onChange}
        groupLabel={label}
        disabled={disabled}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          "data-testid": option.testId,
        }))}
      />
    </div>
  );
}

export function SettingsManagement() {
  const t = useT();
  const household = useHouseholdSettingsContext();

  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [persisted, setPersisted] = useState<SettingsFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/settings", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const data = fromSettings((await response.json()) as EffectiveSettings);
        if (cancelled) return;
        setForm(data);
        setPersisted(data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // "Saved" goes away by itself; an edit or unmounting cancels the timer.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  // Built from the stored zone, so a zone outside the curated list stays offered until Save even
  // after another one is picked.
  const zoneGroups = useMemo(
    () => timeZoneGroups(persisted?.locale.timezone ?? ""),
    [persisted?.locale.timezone]
  );

  function changeLocale(patch: Partial<LocaleObject>) {
    setForm((current) =>
      current ? { ...current, locale: { ...current.locale, ...patch } } : current
    );
    setSaved(false);
  }

  function changeWeather(patch: Partial<WeatherFormState>) {
    setForm((current) =>
      current && current.weather
        ? { ...current, weather: { ...current.weather, ...patch } }
        : current
    );
    setSaved(false);
  }

  function retryLoad() {
    setLoadFailed(false);
    setError(null);
    setAttempt((value) => value + 1);
  }

  async function putObject(
    object: "locale" | "weather",
    settings: unknown
  ): Promise<EffectiveSettings> {
    const response = await authFetch("/api/settings", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object, settings }),
    });
    if (!response.ok) {
      throw new LocalizedApiError(await responseMessage(response, t("admin.settings.saveError")));
    }
    return (await response.json()) as EffectiveSettings;
  }

  const localeDirty =
    form !== null &&
    persisted !== null &&
    (form.locale.language !== persisted.locale.language ||
      form.locale.timezone !== persisted.locale.timezone ||
      form.locale.weekStartDay !== persisted.locale.weekStartDay);
  const weatherDirty =
    form?.weather != null &&
    persisted?.weather != null &&
    weatherFormDirty(form.weather, persisted.weather);
  const problem = form?.weather ? weatherFormProblem(form.weather) : null;
  const canSave = !saving && (localeDirty || weatherDirty) && problem === null;

  async function save() {
    if (!form || !persisted || !canSave) return;
    setSaving(true);
    setError(null);
    let wrote = false;
    try {
      if (localeDirty) {
        const data = await putObject("locale", form.locale);
        wrote = true;
        setPersisted((p) => p && { ...p, locale: data.locale });
        setForm((f) => f && { ...f, locale: data.locale });
      }
      if (weatherDirty && form.weather) {
        const data = await putObject("weather", weatherPayload(form.weather));
        wrote = true;
        const next = data.weather ? toWeatherFormState(data.weather) : form.weather;
        setPersisted((p) => p && { ...p, weather: next });
        setForm((f) => f && { ...f, weather: next });
      }
      setSaved(true);
    } catch (cause) {
      const reason =
        cause instanceof LocalizedApiError ? cause.message : t("admin.settings.saveError");
      // Locale is written first, so a failure after a write means only the weather failed:
      // say what was kept rather than suggesting nothing was saved.
      setError(wrote ? `${t("admin.settings.partialSaved")} ${reason}` : reason);
    } finally {
      setSaving(false);
      if (wrote) household?.retry();
    }
  }

  return (
    <div className="@container flex flex-col gap-8" data-testid="settings-management">
      <div className="grid items-start gap-6 @2xl:grid-cols-2" data-testid="settings-columns">
        <AdminPanel title={t("admin.settings.title")} description={t("admin.settings.description")}>
          <ErrorNotice
            message={loadFailed ? t("admin.settings.loadError") : error}
            data-testid="settings-error"
          />
          {loadFailed && (
            <div>
              <Button
                type="button"
                variant="outline"
                data-testid="settings-retry"
                onClick={retryLoad}
              >
                {t("admin.settings.retry")}
              </Button>
            </div>
          )}
          {form ? (
            <div className="bg-card flex flex-col gap-6 rounded-lg p-4 shadow">
              <ChoiceRow
                label={t("admin.settings.language")}
                description={t("admin.settings.languageDescription")}
                value={form.locale.language}
                disabled={saving}
                onChange={(language) => changeLocale({ language })}
                options={[
                  { value: "en", label: "English", testId: "settings-language-en" },
                  { value: "es", label: "Español", testId: "settings-language-es" },
                ]}
              />
              <ChoiceRow
                label={t("admin.settings.weekStart")}
                description={t("admin.settings.weekStartDescription")}
                value={String(form.locale.weekStartDay)}
                disabled={saving}
                onChange={(day) => changeLocale({ weekStartDay: Number(day) })}
                options={[
                  {
                    value: "1",
                    label: t("admin.settings.monday"),
                    testId: "settings-week-start-1",
                  },
                  {
                    value: "0",
                    label: t("admin.settings.sunday"),
                    testId: "settings-week-start-0",
                  },
                ]}
              />
              <div className="flex flex-col gap-1">
                <Select
                  value={form.locale.timezone}
                  onValueChange={(timezone) => changeLocale({ timezone })}
                  disabled={saving}
                >
                  <Field label={t("admin.settings.timezone")} className="w-full">
                    <SelectTrigger data-testid="settings-timezone">
                      <SelectValue />
                    </SelectTrigger>
                  </Field>
                  <SelectContent>
                    {zoneGroups.map((group) => (
                      <SelectGroup key={group.id}>
                        <SelectLabel>
                          {t(`admin.settings.tzGroup.${group.id}` as MessageKey)}
                        </SelectLabel>
                        {group.options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-control">
                  {t("admin.settings.timezoneDescription")}
                </p>
              </div>
            </div>
          ) : (
            !loadFailed && <p className="text-muted-foreground text-control">…</p>
          )}
        </AdminPanel>

        {form && (
          <PluginContribution pluginId="weather" group="admin" contributionId="weather">
            {form.weather && (
              <WeatherManagement value={form.weather} onChange={changeWeather} disabled={saving} />
            )}
          </PluginContribution>
        )}
      </div>

      {form && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              data-testid="settings-save"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? t("admin.settings.saving") : t("admin.settings.save")}
            </Button>
            {saved && (
              <span role="status" data-testid="settings-saved" className="text-control">
                {t("admin.settings.saved")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-control">{t("admin.settings.scopeNote")}</p>
        </div>
      )}

      <DayPeriodsManagement />
    </div>
  );
}
