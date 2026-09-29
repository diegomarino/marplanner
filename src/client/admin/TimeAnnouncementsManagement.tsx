import { useEffect, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { resolveLang, type MessageKey } from "@/i18n/messages";
import { testVoice } from "@/time-announcements/speech";
import { RULES_CHANGED_EVENT } from "@/time-announcements/events";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CheckboxField } from "@/components/CheckboxField";
import { WeekdayPicker, type WeekdayLabels } from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TimeAnnouncementRule, TimeAnnouncementRuleInput, WeekdayCode } from "../../shared";

/* ------------------------------------------------------------------ */
/* TimeAnnouncementsManagement — CRUD UI for announcement rules */
/* (house panel pattern: useT/authFetch/controlled */
/* inputs). The list shows ALL rules (inactive included) ordered by */
/* time — the server already returns them in that order (FR-006), so */
/* this panel does not re-sort. Test-voice speaks the UNSAVED form */
/* time locally (`testVoice`, src/client/time-announcements/speech.ts)*/
/* — no POST, no rule created or fired (FR-014). */
/* */
/* (token dialect, FR-005/FR-009): migrated to the */
/* shared L2 components. SC-009: the local `WEEKDAYS` constant */
/* and hand-rolled `WeekdayPicker` sub-component this file used to */
/* declare are replaced by the shared `WeekdayPicker` in BOTH the */
/* create form and each rule's inline edit form. */
/* */
/* `ConfirmDialog` is DELIBERATELY NOT adopted here: deleting a rule */
/* is pinned by the pre-existing `tests/client/ */
/* time-announcements-management.test.tsx` to go through */
/* `window.confirm` (`vi.spyOn(window, "confirm")`), a file this */
/* batch's allowed-files list does not include — swapping the */
/* confirmation mechanism would break that pre-existing, out-of-scope */
/* coverage for a change this module does not own (mirrors the */
/* documented `BackupsManagement`/`TelemetryManagement` non-adoption */
/* precedent: a pinned pre-existing behaviour outranks a stylistic */
/* adoption this module is not chartered to change). */
/* ------------------------------------------------------------------ */

export const WEEKDAY_LABEL_KEYS: Record<WeekdayCode, MessageKey> = {
  mon: "timeAnnouncements.weekday.mon",
  tue: "timeAnnouncements.weekday.tue",
  wed: "timeAnnouncements.weekday.wed",
  thu: "timeAnnouncements.weekday.thu",
  fri: "timeAnnouncements.weekday.fri",
  sat: "timeAnnouncements.weekday.sat",
  sun: "timeAnnouncements.weekday.sun",
};

/** Builds `WeekdayPicker`'s localized label map from this surface's own translation namespace
 * (`timeAnnouncements.weekday.*`) — call-site-owned, per the component's own doc comment. */
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

type ApiError = { message?: unknown };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as ApiError | null;
  return typeof data?.message === "string" ? data.message : fallback;
}

interface RuleFormState {
  time: string;
  weekDays: WeekdayCode[];
  isActive: boolean;
}

const EMPTY_FORM: RuleFormState = { time: "", weekDays: [], isActive: true };

export function TimeAnnouncementsManagement() {
  const t = useT();
  const { language } = useHouseholdSettings();
  const lang = resolveLang(language ?? undefined);

  const [rules, setRules] = useState<TimeAnnouncementRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<RuleFormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RuleFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadRules();
  }, []);

  async function loadRules() {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/time-announcements", { credentials: "include" });
      if (!response.ok) throw new Error("load failed");
      const data = (await response.json()) as TimeAnnouncementRule[];
      setRules(Array.isArray(data) ? data : []);
    } catch {
      setError(t("timeAnnouncements.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function createRule() {
    if (!createForm.time || createForm.weekDays.length === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const input: TimeAnnouncementRuleInput = {
        time: createForm.time,
        weekDays: createForm.weekDays,
        isActive: createForm.isActive,
      };
      const response = await authFetch("/api/time-announcements", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, t("timeAnnouncements.management.createError"))
        );
      }
      setCreateForm(EMPTY_FORM);
      await loadRules();
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("timeAnnouncements.management.createError")
      );
    } finally {
      setCreating(false);
    }
  }

  function startEdit(rule: TimeAnnouncementRule) {
    setEditingId(rule.id);
    setEditForm({ time: rule.time, weekDays: rule.weekDays, isActive: rule.isActive });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(EMPTY_FORM);
  }

  /** Shared PATCH path for both the inline-edit save and the quick toggle-active action. */
  async function saveRule(id: string, patch: Partial<TimeAnnouncementRuleInput>): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch(`/api/time-announcements/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, t("timeAnnouncements.management.editError"))
        );
      }
      await loadRules();
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("timeAnnouncements.management.editError")
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!editingId || !editForm.time || editForm.weekDays.length === 0 || saving) return;
    const succeeded = await saveRule(editingId, {
      time: editForm.time,
      weekDays: editForm.weekDays,
      isActive: editForm.isActive,
    });
    if (succeeded) cancelEdit();
  }

  async function toggleActive(rule: TimeAnnouncementRule) {
    await saveRule(rule.id, { isActive: !rule.isActive });
  }

  async function deleteRule(id: string) {
    if (!window.confirm(t("timeAnnouncements.management.deleteConfirm"))) return;
    setError(null);
    try {
      const response = await authFetch(`/api/time-announcements/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, t("timeAnnouncements.management.deleteError"))
        );
      }
      if (editingId === id) cancelEdit();
      await loadRules();
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("timeAnnouncements.management.deleteError")
      );
    }
  }

  if (loading) {
    return (
      <AdminPanel
        title={t("timeAnnouncements.management.title")}
        data-testid="time-announcements-management"
      >
        <p className="text-muted-foreground text-[length:var(--control-font-size)]">
          {t("timeAnnouncements.management.loading")}
        </p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("timeAnnouncements.management.title")}
      description={t("timeAnnouncements.management.description")}
      data-testid="time-announcements-management"
    >
      <ErrorNotice message={error} data-testid="time-announcements-error" />

      <div className="bg-card p-4 rounded-lg shadow mb-6">
        <h3 className="text-md font-semibold mb-2">
          {t("timeAnnouncements.management.createTitle")}
        </h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            {t("timeAnnouncements.management.timeLabel")}
            <Input
              type="time"
              data-testid="time-announcements-time-input"
              value={createForm.time}
              onChange={(e) => setCreateForm({ ...createForm, time: e.target.value })}
              className="w-auto"
            />
          </label>
          <span className="text-muted-foreground text-xs">
            {t("timeAnnouncements.management.weekdaysLabel")}
          </span>
          <WeekdayPicker
            mode="multi"
            value={createForm.weekDays}
            onChange={(next) => setCreateForm({ ...createForm, weekDays: [...next] })}
            labels={weekdayLabels(t)}
            groupLabel={t("timeAnnouncements.management.weekdaysLabel")}
            testIdPrefix="time-announcements-weekday"
          />
          <CheckboxField
            checked={createForm.isActive}
            onChange={(checked) => setCreateForm({ ...createForm, isActive: checked })}
            label={t("timeAnnouncements.management.activeLabel")}
            data-testid="time-announcements-active-checkbox"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              data-testid="time-announcements-create"
              disabled={creating || !createForm.time || createForm.weekDays.length === 0}
              onClick={() => void createRule()}
            >
              {creating
                ? t("timeAnnouncements.management.creating")
                : t("timeAnnouncements.management.create")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="time-announcements-test-voice"
              disabled={!createForm.time}
              onClick={() => testVoice(createForm.time, lang)}
            >
              {t("timeAnnouncements.management.testVoice")}
            </Button>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-2">{t("timeAnnouncements.management.list")}</h3>
        {rules.length === 0 ? (
          <p className="text-muted-foreground" data-testid="time-announcements-empty">
            {t("timeAnnouncements.management.noRules")}
          </p>
        ) : (
          <div className="space-y-4">
            {rules.map((rule) => (
              <div
                key={rule.id}
                data-testid={`time-announcements-rule-${rule.id}`}
                className="border rounded-lg p-4"
              >
                {editingId === rule.id ? (
                  <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      {t("timeAnnouncements.management.timeLabel")}
                      <Input
                        type="time"
                        data-testid={`time-announcements-edit-time-${rule.id}`}
                        value={editForm.time}
                        onChange={(e) => setEditForm({ ...editForm, time: e.target.value })}
                        className="w-auto"
                      />
                    </label>
                    <WeekdayPicker
                      mode="multi"
                      value={editForm.weekDays}
                      onChange={(next) => setEditForm({ ...editForm, weekDays: [...next] })}
                      labels={weekdayLabels(t)}
                      groupLabel={t("timeAnnouncements.management.weekdaysLabel")}
                      testIdPrefix={`time-announcements-edit-weekday-${rule.id}`}
                    />
                    <CheckboxField
                      checked={editForm.isActive}
                      onChange={(checked) => setEditForm({ ...editForm, isActive: checked })}
                      label={t("timeAnnouncements.management.activeLabel")}
                      data-testid={`time-announcements-edit-active-${rule.id}`}
                    />
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="link"
                        data-testid={`time-announcements-save-${rule.id}`}
                        disabled={saving || !editForm.time || editForm.weekDays.length === 0}
                        onClick={() => void submitEdit()}
                      >
                        {t("timeAnnouncements.management.save")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-muted-foreground hover:text-foreground"
                        data-testid={`time-announcements-cancel-${rule.id}`}
                        onClick={cancelEdit}
                      >
                        {t("timeAnnouncements.management.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="text-md font-semibold">{rule.time}</h4>
                      <p className="text-muted-foreground text-[length:var(--control-font-size)]">
                        {rule.weekDays.map((day) => t(WEEKDAY_LABEL_KEYS[day])).join(", ")}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {rule.isActive
                          ? t("timeAnnouncements.management.statusActive")
                          : t("timeAnnouncements.management.statusInactive")}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="link"
                        data-testid={`time-announcements-edit-${rule.id}`}
                        onClick={() => startEdit(rule)}
                      >
                        {t("timeAnnouncements.management.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        data-testid={`time-announcements-toggle-${rule.id}`}
                        onClick={() => void toggleActive(rule)}
                      >
                        {rule.isActive
                          ? t("timeAnnouncements.management.deactivate")
                          : t("timeAnnouncements.management.activate")}
                      </Button>
                      <Button
                        type="button"
                        variant="link"
                        className="text-destructive hover:text-destructive/80"
                        data-testid={`time-announcements-delete-${rule.id}`}
                        onClick={() => void deleteRule(rule.id)}
                      >
                        {t("timeAnnouncements.management.delete")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminPanel>
  );
}
