import { useEffect, useMemo, useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/i18n";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettingsContext } from "@/lib/householdSettings";
import { PluginContribution } from "@/plugins/contributions";
import type { EffectiveSettings, LocaleObject } from "../../shared";
import { DayPeriodsManagement } from "./DayPeriodsManagement";
import { WeatherManagement } from "./WeatherManagement";

/**
 * The household-wide settings on one page: language, time zone and week start, then the day
 * periods and the weather location. The first three are read on each mount, because the
 * household context does not refresh after a write; saving asks it to reload so the rest of the
 * app follows.
 */

function timeZones(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return known.includes(current) ? known : [current, ...known];
}

export function SettingsManagement() {
  const t = useT();
  const household = useHouseholdSettingsContext();

  const [form, setForm] = useState<LocaleObject | null>(null);
  const [persisted, setPersisted] = useState<LocaleObject | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/settings", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const data = (await response.json()) as EffectiveSettings;
        if (cancelled) return;
        setForm(data.locale);
        setPersisted(data.locale);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const zones = useMemo(() => (form ? timeZones(form.timezone) : []), [form]);

  function change(patch: Partial<LocaleObject>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  }

  async function save() {
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch("/api/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ object: "locale", settings: form }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(await responseMessage(response, t("admin.settings.saveError")));
      }
      const data = (await response.json()) as EffectiveSettings;
      setForm(data.locale);
      setPersisted(data.locale);
      setSaved(true);
      household?.retry();
    } catch (cause) {
      setError(cause instanceof LocalizedApiError ? cause.message : t("admin.settings.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    form !== null &&
    persisted !== null &&
    (form.language !== persisted.language ||
      form.timezone !== persisted.timezone ||
      form.weekStartDay !== persisted.weekStartDay);

  return (
    <div className="flex flex-col gap-8" data-testid="settings-management">
      <AdminPanel title={t("admin.settings.title")} description={t("admin.settings.description")}>
        <ErrorNotice
          message={loadFailed ? t("admin.settings.loadError") : error}
          data-testid="settings-error"
        />
        {form ? (
          <div className="bg-card flex flex-wrap items-end gap-4 rounded-lg p-4 shadow">
            <Select
              value={form.language}
              onValueChange={(language) => change({ language: language as "en" | "es" })}
            >
              <Field label={t("admin.settings.language")} className="w-40">
                <SelectTrigger data-testid="settings-language">
                  <SelectValue />
                </SelectTrigger>
              </Field>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Español</SelectItem>
              </SelectContent>
            </Select>
            <Select value={form.timezone} onValueChange={(timezone) => change({ timezone })}>
              <Field label={t("admin.settings.timezone")} className="w-64">
                <SelectTrigger data-testid="settings-timezone">
                  <SelectValue />
                </SelectTrigger>
              </Field>
              <SelectContent>
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(form.weekStartDay)}
              onValueChange={(day) => change({ weekStartDay: Number(day) })}
            >
              <Field label={t("admin.settings.weekStart")} className="w-40">
                <SelectTrigger data-testid="settings-week-start">
                  <SelectValue />
                </SelectTrigger>
              </Field>
              <SelectContent>
                <SelectItem value="1">{t("admin.settings.monday")}</SelectItem>
                <SelectItem value="0">{t("admin.settings.sunday")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              data-testid="settings-save"
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saved ? `✓ ${t("admin.settings.save")}` : t("admin.settings.save")}
            </Button>
          </div>
        ) : (
          !loadFailed && <p className="text-muted-foreground text-control">…</p>
        )}
      </AdminPanel>

      <DayPeriodsManagement />

      <PluginContribution pluginId="weather" group="admin" contributionId="weather">
        <WeatherManagement />
      </PluginContribution>
    </div>
  );
}
