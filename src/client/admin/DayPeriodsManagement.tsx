import { useState, useEffect } from "react";
import { useAdminUnlock } from "@/lib/adminUnlock";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DayPeriodDTO, type PeriodId } from "../../shared";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import {
  derivedEndMinutes,
  minutesToHhmm,
  PeriodOrderError,
  PeriodUniquenessError,
  resolveActivePeriod,
  validateStartOrdering,
} from "../../shared/dayPeriods";

/* ------------------------------------------------------------------ */
/* DayPeriodsManagement — admin day-period edit UI (FR-012, FR-003) */
/* */
/* (token dialect, FR-009): migrated to the shared L2 */
/* components — AdminPanel for the panel frame, ErrorNotice */
/* for the load/save error (SC-011), Field for the start-time editor */
/* (this file's own accessible-name baseline row, / — */
/* DayPeriodsManagement.tsx:256 had no programmatic label at all). */
/* */
/* `ConfirmDialog`/`WeekdayPicker`/`StatusToggle`/`CheckboxField`/ */
/* `RadioField` do not apply — this surface has no destructive */
/* action, weekday list, toggle, checkbox or radio control (it only */
/* edits a period's start time in place). */
/* */
/* `DAY_PERIOD_LABEL_KEYS` (below) mirrors `ChoresBoard.tsx`'s */
/* `DAY_PERIOD_LABEL_KEYS` — `period.id` is the DB-schema-enforced */
/* `PeriodId` union, so a label is looked up through a typed */
/* `Record<PeriodId, MessageKey>` instead of casting the server- */
/* supplied `labelKey` string with `as MessageKey` (SC-007 — this */
/* removes all 5 of this file's translation-key casts). */
/* ------------------------------------------------------------------ */

/** Maps each of the four fixed day periods to its own translation key — see file header. Also
 * used to resolve the two ordering-error messages below, which previously cast the OTHER
 * period's id the same way. Exported so the migration spec can pin every entry by ITERATING
 * this map, per the verification policy (verification policy, SC-007). */
export const DAY_PERIOD_LABEL_KEYS: Record<PeriodId, MessageKey> = {
  morning: "dayPeriod.morning",
  afternoon: "dayPeriod.afternoon",
  evening: "dayPeriod.evening",
  night: "dayPeriod.night",
};

function DayPeriodsManagementContent() {
  const { t, language } = useTranslation();
  // US0 hoist: household timezone from the shared `useHouseholdSettings` context
  // (one `/api/settings` fetch per boot) instead of an ad-hoc GET here. Until the context
  // resolves (or if it never does), keep the same "Europe/Madrid" fallback this panel's own
  // failed-fetch catch used to fall back to (silent, no error surfaced).
  const { timezone: householdTimezone } = useHouseholdSettings();

  const [periods, setPeriods] = useState<DayPeriodDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPeriodId, setEditingPeriodId] = useState<PeriodId | null>(null);
  const [editingStart, setEditingStart] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [activePeriodId, setActivePeriodId] = useState<PeriodId | null>(null);
  const [timezone, setTimezone] = useState<string>("Europe/Madrid");

  const languageToLocale: Record<string, string> = {
    es: "es-ES",
    en: "en-GB",
  };

  const refreshPeriods = () => {
    setLoading(true);
    setError(null);

    authFetch("/api/day-periods", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`list day-periods: ${res.status}`);
        return res.json() as Promise<DayPeriodDTO[]>;
      })
      .then((data) => {
        setPeriods(data);
      })
      .catch(() => {
        setError(t("dayPeriods.management.error"));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    refreshPeriods();
  }, []);

  useEffect(() => {
    if (householdTimezone !== null) setTimezone(householdTimezone);
  }, [householdTimezone]);

  useEffect(() => {
    const computeActivePeriod = () => {
      if (periods.length === 0) {
        setActivePeriodId(null);
        return;
      }

      const nowFormatter = new Intl.DateTimeFormat(languageToLocale[language] || "en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const parts = nowFormatter.formatToParts(new Date());
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const nowMinutes = hour * 60 + minute;

      try {
        const active = resolveActivePeriod(periods, nowMinutes);
        setActivePeriodId(active);
      } catch {
        setActivePeriodId(null);
      }
    };

    computeActivePeriod();

    const now = new Date();
    const msToNext = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      computeActivePeriod();
      interval = setInterval(computeActivePeriod, 60 * 1000);
    }, msToNext);

    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [periods, timezone]);

  const handleStartEdit = (period: DayPeriodDTO) => {
    setEditingPeriodId(period.id);
    setEditingStart(period.start);
  };

  const handleCancelEdit = () => {
    setEditingPeriodId(null);
    setEditingStart("");
  };

  const handleSaveEdit = () => {
    if (!editingPeriodId) return;

    setSavingEdit(true);
    setError(null);

    const proposed = periods.map((p) =>
      p.id === editingPeriodId ? { ...p, start: editingStart.trim() } : p
    );

    try {
      validateStartOrdering(proposed);
    } catch (err) {
      let message = t("dayPeriods.action.saveError");

      if (err instanceof PeriodOrderError) {
        const thisLabel = t(DAY_PERIOD_LABEL_KEYS[err.periodId]);
        const prevLabel = t(DAY_PERIOD_LABEL_KEYS[err.prevPeriodId]);
        message = t("dayPeriods.action.orderError")
          .replace("{period}", thisLabel)
          .replace("{previous}", prevLabel);
      } else if (err instanceof PeriodUniquenessError) {
        const id1Label = t(DAY_PERIOD_LABEL_KEYS[err.periodId1]);
        const id2Label = t(DAY_PERIOD_LABEL_KEYS[err.periodId2]);
        message = t("dayPeriods.action.sameTimeError")
          .replace("{first}", id1Label)
          .replace("{second}", id2Label);
      }

      setError(message);
      setSavingEdit(false);
      return;
    }

    authFetch(`/api/day-periods/${editingPeriodId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: editingStart.trim() }),
    })
      .then((res) => {
        if (!res.ok)
          return res
            .json()
            .catch(() => ({ message: undefined }))
            .then((data: { error?: string; message?: string }) => {
              throw new Error(data.message ?? `update day-period: ${res.status}`);
            });
        return res.json() as Promise<DayPeriodDTO>;
      })
      .then(() => {
        refreshPeriods();
        handleCancelEdit();
      })
      .catch(() => {
        setError(t("dayPeriods.action.saveError"));
      })
      .finally(() => {
        setSavingEdit(false);
      });
  };

  return (
    <AdminPanel
      title={t("dayPeriods.management.title")}
      description={t("dayPeriods.management.description")}
      data-testid="day-periods-management"
    >
      {loading && <p className="text-muted-foreground">{t("dayPeriods.management.loading")}</p>}

      <ErrorNotice message={error} data-testid="day-periods-error" />

      {!loading && periods.length === 0 ? (
        <p className="text-muted-foreground" data-testid="day-periods-empty">
          {t("dayPeriods.management.noPeriods")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {periods.map((period) => {
            try {
              const derivedEnd = derivedEndMinutes(periods, period.id);
              const derivedEndTimeStr = minutesToHhmm(derivedEnd);
              const isActive = activePeriodId === period.id;
              const isEditing = editingPeriodId === period.id;

              return (
                <div
                  key={period.id}
                  data-testid={`day-period-${period.id}`}
                  className={cn(
                    "flex flex-col gap-2 rounded-md border p-3",
                    isActive && "border-primary bg-primary/5"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{t(DAY_PERIOD_LABEL_KEYS[period.id])}</strong>
                    {isActive && (
                      <span className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs">
                        {t("dayPeriods.activeNow")}
                      </span>
                    )}
                    {!isEditing && (
                      <span className="text-muted-foreground text-control">
                        {period.start} – {derivedEndTimeStr}
                      </span>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <Field label={t("dayPeriods.action.editStartLabel")}>
                        <Input
                          type="time"
                          value={editingStart}
                          data-testid={`day-periods-start-input-${period.id}`}
                          onChange={(e) => setEditingStart(e.target.value)}
                        />
                      </Field>
                      <Button
                        type="button"
                        size="sm"
                        data-testid={`day-periods-save-${period.id}`}
                        onClick={handleSaveEdit}
                        disabled={savingEdit || !editingStart}
                      >
                        {savingEdit
                          ? t("dayPeriods.management.saving")
                          : t("dayPeriods.action.save")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`day-periods-cancel-${period.id}`}
                        onClick={handleCancelEdit}
                      >
                        {t("dayPeriods.action.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        data-testid={`day-periods-edit-${period.id}`}
                        onClick={() => handleStartEdit(period)}
                      >
                        {t("dayPeriods.action.edit")}
                      </Button>
                    </div>
                  )}
                </div>
              );
            } catch {
              return null;
            }
          })}
        </div>
      )}
    </AdminPanel>
  );
}

export function DayPeriodsManagement() {
  const { unlocked } = useAdminUnlock();

  if (!unlocked) {
    return null;
  }

  return <DayPeriodsManagementContent />;
}
