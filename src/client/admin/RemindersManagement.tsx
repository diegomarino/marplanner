import { useState, useEffect, useRef } from "react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import {
  Reminder,
  ReminderInput,
  ReminderEditInput,
  ReminderAssignment,
  ReminderAssignmentInput,
  ReminderAssignmentSetInput,
  ReminderKind,
  ReminderQueryField,
  DryRunResult,
  DryRunReason,
  TargetingMode,
  Member,
  Weekday,
} from "../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useTranslation } from "@/i18n";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  WeekdayPicker,
  CANONICAL_WEEKDAY_ORDER,
  type WeekdayLabels,
} from "@/components/WeekdayPicker";
import { CheckboxField } from "@/components/CheckboxField";
import { RadioField } from "@/components/RadioField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NATIVE_SELECT_CLASSES, BARE_CHECKBOX_INPUT_CLASSES } from "@/lib/recipes";

/* ------------------------------------------------------------------ */
/* RemindersManagement — CRUD UI for reminders: scheduled (006, */
/* apply_to_all rule-level weekdays or specific per-member assignment */
/* matrix) and calendar_gated (009, query/queryFields-driven, */
/* membership-only targeting, no weekdays) + a dry-run/explain view. */
/* */
/* (token dialect, FR-005/FR-009): migrated to the */
/* shared L2 components. SC-009: the local `WEEKDAYS` constant */
/* this file used to declare is replaced by `WeekdayPicker`'s */
/* canonical order in every render site EXCEPT `AssignmentMatrixGrid` */
/* — that one is `WeekdayPicker`'s own documented deliberate */
/* exception (a member × weekday table with label-less cells and a */
/* `memberId` dimension the component's signature has no room for), */
/* so it imports `CANONICAL_WEEKDAY_ORDER` directly instead. Deleting */
/* a reminder now opens a themed `ConfirmDialog` instead of */
/* `window.confirm`, mirroring `RoutinesManagement.tsx`'s */
/* precedent (FR-005) — `deleteReminder` performs the */
/* DELETE unconditionally once the caller has already confirmed. */
/* ------------------------------------------------------------------ */

export const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "reminders.weekday.mon",
  tue: "reminders.weekday.tue",
  wed: "reminders.weekday.wed",
  thu: "reminders.weekday.thu",
  fri: "reminders.weekday.fri",
  sat: "reminders.weekday.sat",
  sun: "reminders.weekday.sun",
};

export const QUERY_FIELD_LABEL_KEYS: Record<ReminderQueryField, MessageKey> = {
  title: "reminders.calendarGated.queryField.title",
  description: "reminders.calendarGated.queryField.description",
  location: "reminders.calendarGated.queryField.location",
};

export const DRY_RUN_REASON_LABEL_KEYS: Record<DryRunReason, MessageKey> = {
  no_assigned_events: "reminders.dryRun.reason.no_assigned_events",
  matched_but_unassigned: "reminders.dryRun.reason.matched_but_unassigned",
  query_miss: "reminders.dryRun.reason.query_miss",
};

/** Builds `WeekdayPicker`'s localized label map from this surface's own translation namespace
 * (`reminders.weekday.*`) — call-site-owned, per the component's own doc comment. */
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

const QUERY_FIELDS: ReminderQueryField[] = ["title", "description", "location"];
const DEFAULT_QUERY_FIELDS: ReminderQueryField[] = ["title", "description"];

/** Build the `assignments` array the server expects from a per-member draft — members with no weekdays selected are omitted (and so deactivated by the full-set replace). */
function draftToAssignments(draft: Record<string, Weekday[]>): ReminderAssignmentInput[] {
  return Object.entries(draft)
    .filter(([, weekdays]) => weekdays.length > 0)
    .map(([memberId, weekdays]) => ({ memberId, weekdays }));
}

/** Build the membership-only `assignments` array a calendar_gated rule expects (no weekdays, AC-05). */
function membershipToAssignments(memberIds: string[]): ReminderAssignmentInput[] {
  return memberIds.map((memberId) => ({ memberId, weekdays: [] as Weekday[] }));
}

export function RemindersManagement() {
  const { t } = useTranslation();
  // US0 hoist: household timezone from the shared `useHouseholdSettings` context
  // (one `/api/settings` fetch per boot) instead of an ad-hoc GET here. `loadData` (the
  // reminders/members fetch, independent endpoints) stays gated behind the timezone
  // resolving, mirroring the original settings-then-data ordering exactly — the dry-run
  // date default below depends on `householdToday` already being set BEFORE any
  // `ReminderCard` mounts and captures it as its initial state.
  const { timezone: householdTimezone } = useHouseholdSettings();

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [activeMembers, setActiveMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [householdToday, setHouseholdToday] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (householdTimezone === null) return;
    setHouseholdToday(todayInHouseholdTimezone(householdTimezone));
    void loadData();
  }, [householdTimezone]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [remindersRes, membersRes] = await Promise.all([
        authFetch("/api/reminders", { credentials: "include" }),
        authFetch("/api/members", { credentials: "include" }),
      ]);
      if (!remindersRes.ok) throw new Error("Failed to load reminders");
      if (!membersRes.ok) throw new Error("Failed to load members");

      const [remindersData, membersData] = (await Promise.all([
        remindersRes.json(),
        membersRes.json(),
      ])) as [Reminder[], Member[]];

      setReminders(remindersData);
      setActiveMembers(membersData.filter((m) => m.lifecycle === "active"));
    } catch {
      setError(t("reminders.management.error"));
    } finally {
      setLoading(false);
    }
  }

  async function createReminder(input: ReminderInput): Promise<boolean> {
    try {
      const res = await authFetch("/api/reminders", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to create reminder");
      await loadData();
      return true;
    } catch {
      setError(t("reminders.management.error"));
      return false;
    }
  }

  async function saveAssignments(
    reminderId: string,
    assignments: ReminderAssignmentInput[]
  ): Promise<boolean> {
    try {
      const input: ReminderAssignmentSetInput = { assignments };
      const res = await authFetch(`/api/reminders/${reminderId}/assignments`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to save assignments");
      await loadData();
      return true;
    } catch {
      setError(t("reminders.matrix.error"));
      return false;
    }
  }

  async function editReminder(id: string, updates: ReminderEditInput): Promise<boolean> {
    try {
      const res = await authFetch(`/api/reminders/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update reminder");
      await loadData();
      return true;
    } catch {
      setError(t("reminders.management.error"));
      return false;
    }
  }

  async function toggleActive(reminder: Reminder) {
    await editReminder(reminder.id, { active: !reminder.active });
  }

  /** Confirmation now lives at the UI layer (`ReminderCard`'s `ConfirmDialog`) — this performs the
   * delete unconditionally once the caller has already confirmed (FR-005). */
  async function deleteReminder(id: string) {
    try {
      const res = await authFetch(`/api/reminders/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete reminder");
      await loadData();
    } catch {
      setError(t("reminders.management.error"));
    }
  }

  async function dryRunReminder(
    reminderId: string,
    memberId: string,
    date: string
  ): Promise<DryRunResult> {
    const res = await authFetch(`/api/reminders/${reminderId}/dry-run`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, date }),
    });
    if (!res.ok) throw new Error("Dry-run failed");
    return (await res.json()) as DryRunResult;
  }

  if (loading) {
    return (
      <AdminPanel title={t("reminders.management.title")}>
        <p>{t("reminders.management.loading")}</p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("reminders.management.title")}
      description={t("reminders.management.description")}
    >
      <ErrorNotice message={error} />

      <ReminderCreateForm
        t={t}
        activeMembers={activeMembers}
        onCreate={(input) => createReminder(input)}
      />

      <div>
        <h3 className="text-lg font-semibold mb-2">{t("reminders.management.list")}</h3>
        {reminders.length === 0 && (
          <p className="text-muted-foreground">{t("reminders.management.noReminders")}</p>
        )}
        <div className="space-y-4">
          {reminders.map((reminder) => (
            <ReminderCard
              key={reminder.id}
              reminder={reminder}
              t={t}
              activeMembers={activeMembers}
              onSave={(updates) => editReminder(reminder.id, updates)}
              onToggleActive={() => void toggleActive(reminder)}
              onDelete={() => void deleteReminder(reminder.id)}
              onSaveAssignments={(assignments) => saveAssignments(reminder.id, assignments)}
              onDryRun={(memberId, date) => dryRunReminder(reminder.id, memberId, date)}
              householdToday={householdToday}
            />
          ))}
        </div>
      </div>
    </AdminPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components */
/* ------------------------------------------------------------------ */

interface ReminderCreateFormProps {
  t: (key: MessageKey) => string;
  activeMembers: Member[];
  onCreate: (input: ReminderInput) => Promise<boolean>;
}

function ReminderCreateForm({ t, activeMembers, onCreate }: ReminderCreateFormProps) {
  const [kind, setKind] = useState<ReminderKind>("scheduled");
  const [text, setText] = useState("");
  const [targetingMode, setTargetingMode] = useState<TargetingMode>("apply_to_all");
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, Weekday[]>>({});
  const [query, setQuery] = useState("");
  const [queryFields, setQueryFields] = useState<ReminderQueryField[]>(DEFAULT_QUERY_FIELDS);
  const [cgMemberIds, setCgMemberIds] = useState<string[]>([]);

  const toggleAssignmentDay = (memberId: string, day: Weekday) => {
    setAssignmentDraft((prev) => {
      const current = prev[memberId] ?? [];
      const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
      return { ...prev, [memberId]: next };
    });
  };

  const toggleQueryField = (field: ReminderQueryField) => {
    setQueryFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  const toggleCgMember = (memberId: string) => {
    setCgMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    );
  };

  const assignments = draftToAssignments(assignmentDraft);
  const canSubmit =
    !!text.trim() &&
    (kind === "scheduled"
      ? targetingMode === "apply_to_all"
        ? weekdays.length > 0
        : assignments.length > 0
      : query.trim().length > 0 &&
        queryFields.length > 0 &&
        (targetingMode === "apply_to_all" || cgMemberIds.length > 0));

  const reset = () => {
    setText("");
    setWeekdays([]);
    setAssignmentDraft({});
    setQuery("");
    setQueryFields(DEFAULT_QUERY_FIELDS);
    setCgMemberIds([]);
  };

  const buildInput = (): ReminderInput => {
    const trimmedText = text.trim();
    if (kind === "scheduled") {
      return targetingMode === "apply_to_all"
        ? { kind: "scheduled", targetingMode: "apply_to_all", text: trimmedText, weekdays }
        : { kind: "scheduled", targetingMode: "specific", text: trimmedText, assignments };
    }
    const trimmedQuery = query.trim();
    return targetingMode === "apply_to_all"
      ? {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: trimmedText,
          query: trimmedQuery,
          queryFields,
        }
      : {
          kind: "calendar_gated",
          targetingMode: "specific",
          text: trimmedText,
          query: trimmedQuery,
          queryFields,
          assignments: membershipToAssignments(cgMemberIds),
        };
  };

  return (
    <div className="bg-card p-4 rounded-lg shadow mb-6" data-testid="reminder-create-form">
      <h3 className="text-md font-semibold mb-2">{t("reminders.management.createTitle")}</h3>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2 items-center flex-wrap">
          <span className="text-muted-foreground text-[length:var(--control-font-size)]">
            {t("reminders.management.kindLabel")}
          </span>
          <RadioField
            name="reminder-kind"
            value="scheduled"
            checked={kind === "scheduled"}
            onChange={() => setKind("scheduled")}
            label={t("reminders.kind.scheduled")}
          />
          <RadioField
            name="reminder-kind"
            value="calendar_gated"
            checked={kind === "calendar_gated"}
            onChange={() => setKind("calendar_gated")}
            label={t("reminders.kind.calendarGated")}
          />
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <Input
            type="text"
            placeholder={t("reminders.management.textPlaceholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={t("reminders.management.textPlaceholder")}
            className="w-auto"
          />
          <RadioField
            name="reminder-targeting-mode"
            value="apply_to_all"
            checked={targetingMode === "apply_to_all"}
            onChange={() => setTargetingMode("apply_to_all")}
            label={t("reminders.management.targetingApplyToAll")}
          />
          <RadioField
            name="reminder-targeting-mode"
            value="specific"
            checked={targetingMode === "specific"}
            onChange={() => setTargetingMode("specific")}
            label={t("reminders.management.targetingSpecific")}
          />
        </div>

        {kind === "scheduled" ? (
          targetingMode === "apply_to_all" ? (
            <WeekdayPicker
              mode="multi"
              value={weekdays}
              onChange={(next) => setWeekdays([...next])}
              labels={weekdayLabels(t)}
              groupLabel={t("reminders.management.weekdaysLabel")}
              testIdPrefix="reminders-weekday-create"
            />
          ) : (
            <AssignmentMatrixGrid
              t={t}
              members={activeMembers}
              weekdaysByMember={assignmentDraft}
              onToggle={toggleAssignmentDay}
            />
          )
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1 text-sm">
              {t("reminders.calendarGated.queryLabel")}
              <Input
                type="text"
                placeholder={t("reminders.calendarGated.queryPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-auto"
              />
            </label>
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-muted-foreground text-[length:var(--control-font-size)]">
                {t("reminders.calendarGated.queryFieldsLabel")}
              </span>
              <QueryFieldsPicker t={t} selected={queryFields} onToggle={toggleQueryField} />
            </div>
            {targetingMode === "specific" && (
              <div>
                <span className="text-muted-foreground text-[length:var(--control-font-size)]">
                  {t("reminders.calendarGated.membershipTitle")}
                </span>
                <MembershipChecklist
                  members={activeMembers}
                  emptyMessage={t("reminders.calendarGated.noActiveMembers")}
                  selectedMemberIds={cgMemberIds}
                  onToggle={toggleCgMember}
                />
              </div>
            )}
          </div>
        )}

        <Button
          type="button"
          onClick={() => {
            if (!canSubmit) return;
            void (async () => {
              const succeeded = await onCreate(buildInput());
              if (succeeded) reset();
            })();
          }}
          disabled={!canSubmit}
          className="self-start"
        >
          {t("reminders.action.create")}
        </Button>
      </div>
    </div>
  );
}

interface ReminderCardProps {
  reminder: Reminder;
  t: (key: MessageKey) => string;
  activeMembers: Member[];
  onSave: (updates: ReminderEditInput) => Promise<boolean>;
  onToggleActive: () => void;
  onDelete: () => void;
  onSaveAssignments: (assignments: ReminderAssignmentInput[]) => Promise<boolean>;
  onDryRun: (memberId: string, date: string) => Promise<DryRunResult>;
  householdToday: string;
}

function ReminderCard({
  reminder,
  t,
  activeMembers,
  onSave,
  onToggleActive,
  onDelete,
  onSaveAssignments,
  onDryRun,
  householdToday,
}: ReminderCardProps) {
  const isSpecific = reminder.targetingMode === "specific";
  const isCalendarGated = reminder.kind === "calendar_gated";

  const [editing, setEditing] = useState(false);
  const [textDraft, setTextDraft] = useState(reminder.text);
  const [weekdaysDraft, setWeekdaysDraft] = useState<Weekday[]>(reminder.weekdays ?? []);
  const [queryDraft, setQueryDraft] = useState(reminder.query ?? "");
  const [queryFieldsDraft, setQueryFieldsDraft] = useState<ReminderQueryField[]>(
    reminder.queryFields ?? DEFAULT_QUERY_FIELDS
  );

  const [showMatrix, setShowMatrix] = useState(false);
  // specific: one weekday set per member. apply_to_all: a single shared set, mirrored across
  // every active member's row (the rule is rule-level, not per-member — REMINDERS spec).
  const [matrixDraft, setMatrixDraft] = useState<Record<string, Weekday[]>>({});
  const [sharedWeekdaysDraft, setSharedWeekdaysDraft] = useState<Weekday[]>([]);
  const [cgMemberIdsDraft, setCgMemberIdsDraft] = useState<string[]>([]);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  const [showDryRun, setShowDryRun] = useState(false);
  const [dryRunMemberId, setDryRunMemberId] = useState("");
  const [dryRunDate, setDryRunDate] = useState(householdToday);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const dryRunRequestIdRef = useRef(0);

  // FR-014-style guard (mirrors RoutinesManagement.tsx/ChoresBoard.tsx): deleting a reminder
  // now goes through a themed `ConfirmDialog` instead of `window.confirm` (FR-005).
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // The verdict (or error) describes the PREVIOUS member/date once either changes — clear it and
  // invalidate any in-flight request so a slow response for stale inputs can't publish over it.
  useEffect(() => {
    dryRunRequestIdRef.current++;
    setDryRunResult(null);
    setDryRunError(null);
  }, [dryRunMemberId, dryRunDate]);

  const toggleQueryField = (field: ReminderQueryField) => {
    setQueryFieldsDraft((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  const startEdit = () => {
    setTextDraft(reminder.text);
    setWeekdaysDraft(reminder.weekdays ?? []);
    setQueryDraft(reminder.query ?? "");
    setQueryFieldsDraft(reminder.queryFields ?? DEFAULT_QUERY_FIELDS);
    setEditing(true);
  };

  const draftFromAssignments = (assignments: ReminderAssignment[]): Record<string, Weekday[]> =>
    Object.fromEntries(assignments.map((a) => [a.memberId, a.weekdays]));

  const openMatrix = () => {
    if (isCalendarGated) {
      setCgMemberIdsDraft(reminder.assignments.map((a) => a.memberId));
    } else if (isSpecific) {
      setMatrixDraft(draftFromAssignments(reminder.assignments));
    } else {
      setSharedWeekdaysDraft(reminder.weekdays ?? []);
    }
    setMatrixError(null);
    setShowMatrix(true);
  };

  // apply_to_all shares ONE weekday set across every member row — toggling any row's cell for a
  // day toggles that day for the whole rule (there is no independent per-member edit).
  const toggleMatrixDay = (memberId: string, day: Weekday) => {
    if (!isSpecific) {
      setSharedWeekdaysDraft((prev) =>
        prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
      );
      return;
    }
    setMatrixDraft((prev) => {
      const current = prev[memberId] ?? [];
      const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
      return { ...prev, [memberId]: next };
    });
  };

  const toggleCgMemberDraft = (memberId: string) => {
    setCgMemberIdsDraft((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    );
  };

  const matrixWeekdaysByMember = isSpecific
    ? matrixDraft
    : Object.fromEntries(activeMembers.map((m) => [m.id, sharedWeekdaysDraft]));

  const runDryRun = () => {
    if (!dryRunMemberId) return;
    const requestId = ++dryRunRequestIdRef.current;
    setDryRunLoading(true);
    setDryRunError(null);
    void (async () => {
      try {
        const result = await onDryRun(dryRunMemberId, dryRunDate);
        if (requestId !== dryRunRequestIdRef.current) return;
        setDryRunResult(result);
      } catch {
        if (requestId !== dryRunRequestIdRef.current) return;
        setDryRunResult(null);
        setDryRunError(t("reminders.dryRun.error"));
      } finally {
        if (requestId === dryRunRequestIdRef.current) {
          setDryRunLoading(false);
        }
      }
    })();
  };

  const editSaveDisabled = isCalendarGated
    ? !textDraft.trim() || !queryDraft.trim() || queryFieldsDraft.length === 0
    : !textDraft.trim() || (!isSpecific && weekdaysDraft.length === 0);

  return (
    <div className="border rounded-lg p-4 mb-4" data-testid={`reminder-${reminder.id}`}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Input
            type="text"
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            aria-label={t("reminders.management.textPlaceholder")}
            className="w-auto"
          />
          {!isCalendarGated && !isSpecific && (
            <WeekdayPicker
              mode="multi"
              value={weekdaysDraft}
              onChange={(next) => setWeekdaysDraft([...next])}
              labels={weekdayLabels(t)}
              groupLabel={t("reminders.management.weekdaysLabel")}
              testIdPrefix={`reminders-weekday-edit-${reminder.id}`}
            />
          )}
          {isCalendarGated && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-1 text-sm">
                {t("reminders.calendarGated.queryLabel")}
                <Input
                  type="text"
                  value={queryDraft}
                  onChange={(e) => setQueryDraft(e.target.value)}
                  className="w-auto"
                />
              </label>
              <div className="flex gap-2 items-center flex-wrap">
                <span className="text-muted-foreground text-[length:var(--control-font-size)]">
                  {t("reminders.calendarGated.queryFieldsLabel")}
                </span>
                <QueryFieldsPicker t={t} selected={queryFieldsDraft} onToggle={toggleQueryField} />
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="link"
              onClick={() => {
                if (editSaveDisabled) return;
                void (async () => {
                  const updates: ReminderEditInput = isCalendarGated
                    ? {
                        text: textDraft.trim(),
                        query: queryDraft.trim(),
                        queryFields: queryFieldsDraft,
                      }
                    : isSpecific
                      ? { text: textDraft.trim() }
                      : { text: textDraft.trim(), weekdays: weekdaysDraft };
                  const succeeded = await onSave(updates);
                  if (succeeded) {
                    setEditing(false);
                  }
                })();
              }}
              disabled={editSaveDisabled}
            >
              {t("reminders.action.save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(false)}
            >
              {t("reminders.action.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between items-start">
          <div>
            <h4 className="text-md font-semibold">{reminder.text}</h4>
            <p className="text-muted-foreground text-[length:var(--control-font-size)]">
              {isCalendarGated ? t("reminders.kind.calendarGated") : t("reminders.kind.scheduled")}
            </p>
            <p className="text-muted-foreground text-[length:var(--control-font-size)]">
              {isCalendarGated
                ? reminder.query
                : isSpecific
                  ? t("reminders.management.targetingSpecific")
                  : (reminder.weekdays ?? []).map((day) => t(WEEKDAY_LABEL_KEYS[day])).join(", ")}
            </p>
            <p className="text-muted-foreground text-[length:var(--control-font-size)]">
              {reminder.active ? t("reminders.status.active") : t("reminders.status.inactive")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="link" onClick={startEdit}>
              {t("reminders.action.edit")}
            </Button>
            {(!isCalendarGated || isSpecific) && (
              <Button
                type="button"
                variant="link"
                onClick={() => (showMatrix ? setShowMatrix(false) : openMatrix())}
              >
                {showMatrix ? t("reminders.matrix.close") : t("reminders.matrix.toggleShow")}
              </Button>
            )}
            {isCalendarGated && (
              <Button type="button" variant="link" onClick={() => setShowDryRun((prev) => !prev)}>
                {showDryRun ? t("reminders.dryRun.close") : t("reminders.dryRun.toggleShow")}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onToggleActive}>
              {reminder.active ? t("reminders.action.deactivate") : t("reminders.action.activate")}
            </Button>
            <Button
              type="button"
              variant="link"
              className="text-destructive hover:text-destructive/80"
              onClick={() => setShowDeleteConfirm(true)}
            >
              {t("reminders.action.delete")}
            </Button>
          </div>
        </div>
      )}

      {showMatrix &&
        (isCalendarGated ? (
          <div className="mt-4 border-t pt-4">
            <h5 className="text-sm font-semibold mb-2">
              {t("reminders.calendarGated.membershipTitle")}
            </h5>
            <MembershipChecklist
              members={activeMembers}
              emptyMessage={t("reminders.calendarGated.noActiveMembers")}
              selectedMemberIds={cgMemberIdsDraft}
              onToggle={toggleCgMemberDraft}
            />
            <ErrorNotice message={matrixError} className="mt-2" />
            <Button
              type="button"
              size="sm"
              className="mt-2"
              onClick={() => {
                if (cgMemberIdsDraft.length === 0) {
                  setMatrixError(t("reminders.calendarGated.membersRequiredError"));
                  return;
                }
                setMatrixError(null);
                void (async () => {
                  const succeeded = await onSaveAssignments(
                    membershipToAssignments(cgMemberIdsDraft)
                  );
                  if (succeeded) setShowMatrix(false);
                })();
              }}
            >
              {t("reminders.matrix.save")}
            </Button>
          </div>
        ) : (
          <div className="mt-4 border-t pt-4">
            <h5 className="text-sm font-semibold mb-2">{t("reminders.matrix.title")}</h5>
            <AssignmentMatrixGrid
              t={t}
              members={activeMembers}
              weekdaysByMember={matrixWeekdaysByMember}
              onToggle={toggleMatrixDay}
            />
            <ErrorNotice message={matrixError} className="mt-2" />
            <Button
              type="button"
              size="sm"
              className="mt-2"
              onClick={() => {
                if (isSpecific) {
                  const assignments = draftToAssignments(matrixDraft);
                  if (assignments.length === 0) {
                    setMatrixError(t("reminders.matrix.emptySetError"));
                    return;
                  }
                  setMatrixError(null);
                  void (async () => {
                    const succeeded = await onSaveAssignments(assignments);
                    if (succeeded) setShowMatrix(false);
                  })();
                  return;
                }
                if (sharedWeekdaysDraft.length === 0) {
                  setMatrixError(t("reminders.matrix.weekdaysRequiredError"));
                  return;
                }
                setMatrixError(null);
                void (async () => {
                  const succeeded = await onSave({ weekdays: sharedWeekdaysDraft });
                  if (succeeded) setShowMatrix(false);
                })();
              }}
            >
              {t("reminders.matrix.save")}
            </Button>
          </div>
        ))}

      {isCalendarGated && showDryRun && (
        <div className="mt-4 border-t pt-4">
          <h5 className="text-sm font-semibold mb-2">{t("reminders.dryRun.title")}</h5>
          <div className="flex gap-2 items-center flex-wrap">
            <label className="flex items-center gap-1 text-sm">
              {t("reminders.dryRun.memberLabel")}
              <select
                value={dryRunMemberId}
                onChange={(e) => setDryRunMemberId(e.target.value)}
                className={NATIVE_SELECT_CLASSES}
              >
                <option value="">{t("reminders.dryRun.selectMember")}</option>
                {activeMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm">
              {t("reminders.dryRun.dateLabel")}
              <Input
                type="date"
                value={dryRunDate}
                onChange={(e) => setDryRunDate(e.target.value)}
                className="w-auto"
              />
            </label>
            <Button type="button" onClick={runDryRun} disabled={!dryRunMemberId || dryRunLoading}>
              {dryRunLoading ? t("reminders.dryRun.running") : t("reminders.dryRun.run")}
            </Button>
          </div>
          <ErrorNotice message={dryRunError} className="mt-2" />
          {dryRunResult && (
            <p className="text-sm mt-2">
              <span className="font-semibold">
                {dryRunResult.wouldEmit
                  ? t("reminders.dryRun.wouldEmit")
                  : t("reminders.dryRun.wouldNotEmit")}
              </span>
              {!dryRunResult.wouldEmit && dryRunResult.reason && (
                <span className="text-muted-foreground">
                  {" — "}
                  {t(DRY_RUN_REASON_LABEL_KEYS[dryRunResult.reason])}
                </span>
              )}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={(open) => {
          if (!open) setShowDeleteConfirm(false);
        }}
        title={t("reminders.action.delete")}
        description={t("reminders.action.deleteConfirm")}
        confirmLabel={t("reminders.action.delete")}
        cancelLabel={t("reminders.action.cancel")}
        onConfirm={onDelete}
        confirmTestId={`reminder-delete-confirm-${reminder.id}`}
        cancelTestId={`reminder-delete-cancel-${reminder.id}`}
      />
    </div>
  );
}

interface QueryFieldsPickerProps {
  t: (key: MessageKey) => string;
  selected: ReminderQueryField[];
  onToggle: (field: ReminderQueryField) => void;
}

function QueryFieldsPicker({ t, selected, onToggle }: QueryFieldsPickerProps) {
  return (
    <div className="flex gap-2 items-center flex-wrap">
      {QUERY_FIELDS.map((field) => (
        <CheckboxField
          key={field}
          checked={selected.includes(field)}
          onChange={() => onToggle(field)}
          label={t(QUERY_FIELD_LABEL_KEYS[field])}
        />
      ))}
    </div>
  );
}

interface MembershipChecklistProps {
  members: Member[];
  emptyMessage: string;
  selectedMemberIds: string[];
  onToggle: (memberId: string) => void;
}

function MembershipChecklist({
  members,
  emptyMessage,
  selectedMemberIds,
  onToggle,
}: MembershipChecklistProps) {
  if (members.length === 0) {
    return (
      <p className="text-muted-foreground text-[length:var(--control-font-size)]">{emptyMessage}</p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {members.map((member) => (
        <CheckboxField
          key={member.id}
          checked={selectedMemberIds.includes(member.id)}
          onChange={() => onToggle(member.id)}
          label={member.displayName}
        />
      ))}
    </div>
  );
}

interface AssignmentMatrixGridProps {
  t: (key: MessageKey) => string;
  members: Member[];
  weekdaysByMember: Record<string, Weekday[]>;
  onToggle: (memberId: string, day: Weekday) => void;
}

/** The ONE render site `WeekdayPicker`'s own file header names as its deliberate exception: a
 * member × weekday table, not an independently-toggled set — day labels appear once in
 * `<thead>`, and each `<td>` holds a bare checkbox whose `onChange` carries a `memberId`
 * dimension `WeekdayPicker`'s signature has no room for. Imports `CANONICAL_WEEKDAY_ORDER`
 * directly (SC-009's "one canonical order, not five" still holds without migrating the markup),
 * and styles each cell's checkbox via the `BARE_CHECKBOX_INPUT_CLASSES` recipe (—
 * see the style guide) rather than `CheckboxField`, which would render a visible day label in
 * every cell instead of the one already in the column header.
 */
function AssignmentMatrixGrid({
  t,
  members,
  weekdaysByMember,
  onToggle,
}: AssignmentMatrixGridProps) {
  if (members.length === 0) {
    return (
      <p className="text-muted-foreground text-[length:var(--control-font-size)]">
        {t("reminders.matrix.noActiveMembers")}
      </p>
    );
  }

  return (
    <table className="text-sm">
      <thead>
        <tr>
          <th className="text-left pr-2">{t("reminders.matrix.member")}</th>
          {CANONICAL_WEEKDAY_ORDER.map((day) => (
            <th key={day} className="px-1 text-xs font-normal">
              {t(WEEKDAY_LABEL_KEYS[day])}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {members.map((member) => {
          const days = weekdaysByMember[member.id] ?? [];
          return (
            <tr key={member.id}>
              <td className="pr-2">{member.displayName}</td>
              {CANONICAL_WEEKDAY_ORDER.map((day) => (
                <td key={day} className="text-center">
                  <input
                    type="checkbox"
                    checked={days.includes(day)}
                    onChange={() => onToggle(member.id, day)}
                    aria-label={`${member.displayName} — ${t(WEEKDAY_LABEL_KEYS[day])}`}
                    className={BARE_CHECKBOX_INPUT_CLASSES}
                  />
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
