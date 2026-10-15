import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Volume2 } from "lucide-react";
import { LocalizedApiError, responseMessage as readResponseMessage } from "@/lib/api-error";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { resolveLang, type MessageKey } from "@/i18n/messages";
import { testVoice, voiceNameFor } from "@/time-announcements/speech";
import { RULES_CHANGED_EVENT } from "@/time-announcements/events";
import { cn } from "@/lib/utils";
import { AdminPanel } from "@/components/AdminPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CheckboxField } from "@/components/CheckboxField";
import {
  CANONICAL_WEEKDAY_ORDER,
  WeekdayPicker,
  type WeekdayLabels,
} from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TimeAnnouncementRule, TimeAnnouncementRuleInput, WeekdayCode } from "../../shared";

/* TimeAnnouncementsManagement: list of announcement rules as cards, one Dialog for create and
 * edit, ConfirmDialog for delete. The server returns rules ordered by time (FR-006), so the
 * list is not re-sorted. Test voice speaks the UNSAVED form time locally (no write, FR-014). */

export const WEEKDAY_LABEL_KEYS: Record<WeekdayCode, MessageKey> = {
  mon: "timeAnnouncements.weekday.mon",
  tue: "timeAnnouncements.weekday.tue",
  wed: "timeAnnouncements.weekday.wed",
  thu: "timeAnnouncements.weekday.thu",
  fri: "timeAnnouncements.weekday.fri",
  sat: "timeAnnouncements.weekday.sat",
  sun: "timeAnnouncements.weekday.sun",
};

const WEEKDAY_INITIAL_KEYS: Record<WeekdayCode, MessageKey> = {
  mon: "timeAnnouncements.weekdayInitial.mon",
  tue: "timeAnnouncements.weekdayInitial.tue",
  wed: "timeAnnouncements.weekdayInitial.wed",
  thu: "timeAnnouncements.weekdayInitial.thu",
  fri: "timeAnnouncements.weekdayInitial.fri",
  sat: "timeAnnouncements.weekdayInitial.sat",
  sun: "timeAnnouncements.weekdayInitial.sun",
};

function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
  return {
    mon: t(WEEKDAY_LABEL_KEYS.mon),
    tue: t(WEEKDAY_LABEL_KEYS.tue),
    wed: t(WEEKDAY_LABEL_KEYS.wed),
    thu: t(WEEKDAY_LABEL_KEYS.thu),
    fri: t(WEEKDAY_LABEL_KEYS.fri),
    sat: t(WEEKDAY_LABEL_KEYS.sat),
    sun: t(WEEKDAY_LABEL_KEYS.sun),
  };
}

interface RuleFormState {
  time: string;
  weekDays: WeekdayCode[];
  isActive: boolean;
}

const DEFAULT_TIME = "07:00";
const EMPTY_FORM: RuleFormState = { time: DEFAULT_TIME, weekDays: [], isActive: true };

export function TimeAnnouncementsManagement() {
  const t = useT();
  const responseMessage = (response: Response, fallback: string) =>
    readResponseMessage(response, fallback, {
      active_overlap: t("timeAnnouncements.management.activeOverlap"),
      validation_error: t("timeAnnouncements.management.invalidRule"),
    });
  const { language } = useHouseholdSettings();
  const lang = resolveLang(language ?? undefined);

  const [rules, setRules] = useState<TimeAnnouncementRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dialog: closed = `formOpen` false; `editing` null means create.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TimeAnnouncementRule | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [voiceName, setVoiceName] = useState<string | null>(null);

  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void loadRules(true);
  }, []);

  // Chromium loads voices asynchronously: re-read the voice name while the dialog is open.
  useEffect(() => {
    if (!formOpen) return;
    const update = () => setVoiceName(voiceNameFor(lang));
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [formOpen, lang]);

  /** `showSpinner` is true only for the first load and Retry; reloads after a write refresh in place. */
  async function loadRules(showSpinner: boolean) {
    if (showSpinner) setLoading(true);
    setError(null);
    setLoadFailed(false);
    try {
      const response = await authFetch("/api/time-announcements", { credentials: "include" });
      if (!response.ok) throw new Error("load failed");
      const data = (await response.json()) as TimeAnnouncementRule[];
      setRules(Array.isArray(data) ? data : []);
    } catch {
      setLoadFailed(true);
      setError(t("timeAnnouncements.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(rule: TimeAnnouncementRule) {
    setEditing(rule);
    setForm({ time: rule.time, weekDays: [...rule.weekDays], isActive: rule.isActive });
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
  }

  const canSubmit = form.time !== "" && form.weekDays.length > 0 && !saving;

  async function submitForm() {
    if (!canSubmit) return;
    const rule = editing;
    const failure = t(
      rule ? "timeAnnouncements.management.editError" : "timeAnnouncements.management.createError"
    );
    setSaving(true);
    setFormError(null);
    try {
      const input: TimeAnnouncementRuleInput = {
        time: form.time,
        weekDays: form.weekDays,
        isActive: form.isActive,
      };
      const response = await authFetch(
        rule ? `/api/time-announcements/${rule.id}` : "/api/time-announcements",
        {
          method: rule ? "PATCH" : "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      if (!response.ok) throw new LocalizedApiError(await responseMessage(response, failure));
      setSaving(false);
      setFormOpen(false);
      await loadRules(false);
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setFormError(cause instanceof LocalizedApiError ? cause.message : failure);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rule: TimeAnnouncementRule) {
    setError(null);
    try {
      const response = await authFetch(`/api/time-announcements/${rule.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("timeAnnouncements.management.editError"))
        );
      }
      await loadRules(false);
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("timeAnnouncements.management.editError")
      );
    }
  }

  async function deleteRule(id: string) {
    setError(null);
    try {
      const response = await authFetch(`/api/time-announcements/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("timeAnnouncements.management.deleteError"))
        );
      }
      await loadRules(false);
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("timeAnnouncements.management.deleteError")
      );
    }
  }

  const title = t("timeAnnouncements.management.title");

  if (loading) {
    return (
      <AdminPanel title={title} data-testid="time-announcements-management">
        <div
          role="status"
          className="text-muted-foreground text-control flex items-center justify-center gap-2 py-10"
        >
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          {t("timeAnnouncements.management.loading")}
        </div>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={title}
      description={t("timeAnnouncements.management.description")}
      data-testid="time-announcements-management"
      actions={
        loadFailed ? undefined : (
          <Button type="button" data-testid="time-announcements-create" onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t("timeAnnouncements.management.create")}
          </Button>
        )
      }
    >
      <ErrorNotice message={error} data-testid="time-announcements-error" />
      {loadFailed ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            data-testid="time-announcements-retry"
            onClick={() => void loadRules(true)}
          >
            {t("timeAnnouncements.management.retry")}
          </Button>
        </div>
      ) : rules.length === 0 ? (
        <p className="text-muted-foreground" data-testid="time-announcements-empty">
          {t("timeAnnouncements.management.noRules")}
        </p>
      ) : (
        <ul className="grid gap-3">
          {rules.map((rule) => (
            <li
              key={rule.id}
              data-testid={`time-announcements-rule-${rule.id}`}
              className="bg-card flex flex-col gap-3 rounded-lg border p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3
                  className={cn(
                    "text-3xl font-semibold tabular-nums",
                    !rule.isActive && "opacity-60"
                  )}
                >
                  {rule.time}
                </h3>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("timeAnnouncements.management.edit")} ${rule.time}`}
                    data-testid={`time-announcements-edit-${rule.id}`}
                    onClick={() => openEdit(rule)}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive/80"
                    aria-label={`${t("timeAnnouncements.management.delete")} ${rule.time}`}
                    data-testid={`time-announcements-delete-${rule.id}`}
                    onClick={() => setDeleteId(rule.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={cn("flex items-center gap-2", !rule.isActive && "opacity-60")}>
                  {CANONICAL_WEEKDAY_ORDER.map((day) => {
                    const on = rule.weekDays.includes(day);
                    return (
                      <span
                        key={day}
                        aria-hidden="true"
                        data-testid={`time-announcements-day-${rule.id}-${day}`}
                        data-on={on ? "true" : "false"}
                        className={cn(
                          "flex size-8 items-center justify-center rounded-full text-xs font-bold",
                          on
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {t(WEEKDAY_INITIAL_KEYS[day])}
                      </span>
                    );
                  })}
                  <span className="sr-only">
                    {CANONICAL_WEEKDAY_ORDER.filter((day) => rule.weekDays.includes(day))
                      .map((day) => t(WEEKDAY_LABEL_KEYS[day]))
                      .join(", ")}
                  </span>
                </div>
                {!rule.isActive && (
                  <span className="text-muted-foreground text-xs tracking-wide uppercase">
                    {t("timeAnnouncements.management.statusInactive")}
                  </span>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  className="ml-auto"
                  data-testid={`time-announcements-toggle-${rule.id}`}
                  onClick={() => void toggleActive(rule)}
                >
                  {rule.isActive
                    ? t("timeAnnouncements.management.deactivate")
                    : t("timeAnnouncements.management.activate")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent
          className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
          closeLabel={t("timeAnnouncements.management.cancel")}
          data-testid="time-announcements-form-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("timeAnnouncements.management.dialogEditTitle")
                : t("timeAnnouncements.management.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("timeAnnouncements.management.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitForm();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="time-announcements-time">
                {t("timeAnnouncements.management.timeLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="time-announcements-time"
                  type="time"
                  data-testid="time-announcements-time-input"
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                  className="w-auto flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="time-announcements-test-voice"
                  disabled={!form.time}
                  onClick={() => testVoice(form.time, lang)}
                >
                  <Volume2 aria-hidden="true" />
                  {t("timeAnnouncements.management.testVoice")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs" data-testid="time-announcements-voice">
                {voiceName
                  ? `${t("timeAnnouncements.management.voiceLabel")}: ${voiceName}`
                  : t("timeAnnouncements.management.noVoice")}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {t("timeAnnouncements.management.weekdaysLabel")}
              </span>
              <WeekdayPicker
                mode="multi"
                value={form.weekDays}
                onChange={(next) => setForm({ ...form, weekDays: [...next] })}
                labels={weekdayLabels(t)}
                groupLabel={t("timeAnnouncements.management.weekdaysLabel")}
                testIdPrefix="time-announcements-weekday"
              />
            </div>
            <CheckboxField
              checked={form.isActive}
              onChange={(checked) => setForm({ ...form, isActive: checked })}
              label={t("timeAnnouncements.management.activeLabel")}
              data-testid="time-announcements-active-checkbox"
            />
            <ErrorNotice message={formError} data-testid="time-announcements-form-error" />
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                data-testid="time-announcements-cancel"
                disabled={saving}
                onClick={closeForm}
              >
                {t("timeAnnouncements.management.cancel")}
              </Button>
              <Button type="submit" data-testid="time-announcements-submit" disabled={!canSubmit}>
                {saving
                  ? editing
                    ? t("timeAnnouncements.management.saving")
                    : t("timeAnnouncements.management.creating")
                  : editing
                    ? t("timeAnnouncements.management.save")
                    : t("timeAnnouncements.management.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
        title={t("timeAnnouncements.management.deleteTitle")}
        description={t("timeAnnouncements.management.deleteConfirm")}
        confirmLabel={t("timeAnnouncements.management.delete")}
        cancelLabel={t("timeAnnouncements.management.cancel")}
        confirmTestId="time-announcements-delete-confirm"
        cancelTestId="time-announcements-delete-cancel"
        onConfirm={() => {
          const id = deleteId;
          setDeleteId(null);
          if (id) void deleteRule(id);
        }}
      />
    </AdminPanel>
  );
}
