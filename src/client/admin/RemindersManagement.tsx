import { useState, useEffect, useRef } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import {
  Reminder,
  ReminderInput,
  ReminderEditInput,
  ReminderAssignmentInput,
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
import { WeekdayPicker, type WeekdayLabels } from "@/components/WeekdayPicker";
import { ChoicePills } from "@/components/ChoicePills";
import { MemberPills } from "@/components/MemberPills";
import { PillToggle } from "@/components/PillToggle";
import { ReminderMemberDays } from "./ReminderMemberDays";
import { MemberChip } from "@/routines/admin/MemberChip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";

/* RemindersManagement — the reminders admin page: a list of rules, one add/edit Dialog
 * (scheduled all/specific with per-member weekday pills, calendar_gated with query and
 * members), a per-row dry-run panel for calendar_gated rules, and a themed delete ConfirmDialog.
 * Only the first load and an explicit Retry show the loading state; later refreshes are silent so
 * open dialogs and panels survive. Each row names who it reaches as member-colour pills
 * (`MemberChip`), or a neutral "All members" label. The dialog's choices are shared pills (`ChoicePills`,
 * `WeekdayPicker`, `ReminderMemberDays`, `MemberPills`, `PillToggle`). */

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

type FormState = { kind: "create" } | { kind: "edit"; reminder: Reminder } | null;

type Translate = (key: MessageKey) => string;

export function RemindersManagement() {
  const { t } = useTranslation();
  // The household timezone comes from the shared `useHouseholdSettings` context. The first load
  // stays gated behind it so the dry-run date default (`householdToday`) is set before any row
  // mounts and captures it.
  const { timezone: householdTimezone } = useHouseholdSettings();

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [householdToday, setHouseholdToday] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [deleteTarget, setDeleteTarget] = useState<Reminder | null>(null);

  const activeMembers = allMembers.filter((m) => m.lifecycle === "active");
  const memberById = new Map(allMembers.map((m) => [m.id, m]));

  useEffect(() => {
    if (householdTimezone === null) return;
    setHouseholdToday(todayInHouseholdTimezone(householdTimezone));
    void loadData();
  }, [householdTimezone]);

  async function fetchAll(): Promise<void> {
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
    setAllMembers(membersData);
  }

  /** First load and Retry: shows the loading state. */
  async function loadData() {
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    try {
      await fetchAll();
    } catch {
      setLoadFailed(true);
      setError(t("reminders.management.error"));
    } finally {
      setLoading(false);
    }
  }

  /** After a mutation: no loading state, so an open dialog or dry-run panel is never unmounted. */
  async function refresh() {
    try {
      await fetchAll();
    } catch {
      setLoadFailed(true);
      setError(t("reminders.management.error"));
    }
  }

  async function send(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown
  ): Promise<boolean> {
    try {
      const res = await authFetch(url, {
        method,
        credentials: "include",
        ...(body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (!res.ok) return false;
    } catch {
      return false;
    }
    await refresh();
    return true;
  }

  async function saveReminder(
    target: Reminder | null,
    body: ReminderInput | ReminderEditInput
  ): Promise<boolean> {
    return target
      ? send(`/api/reminders/${target.id}`, "PATCH", body)
      : send("/api/reminders", "POST", body);
  }

  async function toggleActive(reminder: Reminder) {
    setError(null);
    const ok = await send(`/api/reminders/${reminder.id}`, "PATCH", { active: !reminder.active });
    if (!ok) setError(t("reminders.management.actionError"));
  }

  /** Confirmation lives in the ConfirmDialog below; this deletes unconditionally (FR-005). */
  async function deleteReminder(reminder: Reminder) {
    setError(null);
    const ok = await send(`/api/reminders/${reminder.id}`, "DELETE");
    if (!ok) setError(t("reminders.management.actionError"));
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
    <>
      <AdminPanel
        title={t("reminders.management.title")}
        description={t("reminders.management.description")}
        actions={
          loadFailed ? undefined : (
            <Button
              type="button"
              data-testid="reminders-add-rule"
              onClick={() => setForm({ kind: "create" })}
            >
              <Plus aria-hidden="true" />
              {t("reminders.action.addRule")}
            </Button>
          )
        }
      >
        <ErrorNotice message={error} />

        {loadFailed && (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            data-testid="reminders-retry"
            onClick={() => void loadData()}
          >
            {t("reminders.management.retry")}
          </Button>
        )}

        {!loadFailed && reminders.length === 0 && (
          <p className="text-muted-foreground">{t("reminders.management.noReminders")}</p>
        )}

        {reminders.length > 0 && (
          <ul
            aria-label={t("reminders.management.list")}
            className="m-0 flex list-none flex-col divide-y rounded-lg border p-0"
          >
            {reminders.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                t={t}
                memberById={memberById}
                activeMembers={activeMembers}
                householdToday={householdToday}
                onEdit={() => setForm({ kind: "edit", reminder })}
                onDelete={() => setDeleteTarget(reminder)}
                onToggleActive={() => void toggleActive(reminder)}
                onDryRun={(memberId, date) => dryRunReminder(reminder.id, memberId, date)}
              />
            ))}
          </ul>
        )}
      </AdminPanel>

      {form && (
        <ReminderFormDialog
          key={form.kind === "edit" ? form.reminder.id : "create"}
          t={t}
          reminder={form.kind === "edit" ? form.reminder : null}
          activeMembers={activeMembers}
          onSubmit={(body) => saveReminder(form.kind === "edit" ? form.reminder : null, body)}
          onClose={() => setForm(null)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("reminders.action.delete")}
        description={t("reminders.action.deleteConfirm")}
        confirmLabel={t("reminders.action.delete")}
        cancelLabel={t("reminders.action.cancel")}
        onConfirm={() => {
          if (deleteTarget) void deleteReminder(deleteTarget);
        }}
        confirmTestId={deleteTarget ? `reminder-delete-confirm-${deleteTarget.id}` : undefined}
        cancelTestId={deleteTarget ? `reminder-delete-cancel-${deleteTarget.id}` : undefined}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components */
/* ------------------------------------------------------------------ */

function weekdayList(t: Translate, days: Weekday[]): string {
  return days.map((day) => t(WEEKDAY_LABEL_KEYS[day])).join(", ");
}

/** The rule's targeted members that can still be shown: its assignments in order, keeping only
 * known, active members (an archived member drops from emission, FR-002). */
function targetedMembers(reminder: Reminder, memberById: Map<string, Member>): Member[] {
  return reminder.assignments.flatMap((a) => {
    const member = memberById.get(a.memberId);
    return member && member.lifecycle === "active" ? [member] : [];
  });
}

/** The neutral "All members" label: a muted pill, never a member colour. */
function EveryoneLabel({ t }: { t: Translate }) {
  return (
    <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-sm font-medium">
      {t("reminders.management.targetingApplyToAll")}
    </span>
  );
}

/** The muted "who and when" line of a row: member-colour pills for specific rules, the neutral
 * label for all-members rules, plus the weekdays (scheduled) or the match text (calendar-gated). */
function ReminderWho({
  reminder,
  t,
  memberById,
}: {
  reminder: Reminder;
  t: Translate;
  memberById: Map<string, Member>;
}) {
  const everyone = reminder.targetingMode === "apply_to_all";
  const members = targetedMembers(reminder, memberById);
  const weekdaysOf = new Map(reminder.assignments.map((a) => [a.memberId, a.weekdays]));
  return (
    <p
      data-testid={`reminder-who-${reminder.id}`}
      className="text-muted-foreground text-control flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      {reminder.kind === "calendar_gated" ? (
        <>
          <span>{`${t("reminders.calendarGated.queryLabel")}: ${reminder.query ?? ""}`}</span>
          {everyone ? (
            <EveryoneLabel t={t} />
          ) : (
            members.map((member) => <MemberChip key={member.id} member={member} />)
          )}
        </>
      ) : everyone ? (
        <>
          <EveryoneLabel t={t} />
          <span>{weekdayList(t, reminder.weekdays ?? [])}</span>
        </>
      ) : (
        members.map((member) => (
          <span key={member.id} className="inline-flex items-center gap-1.5">
            <MemberChip member={member} />
            <span>{weekdayList(t, weekdaysOf.get(member.id) ?? [])}</span>
          </span>
        ))
      )}
    </p>
  );
}

interface ReminderRowProps {
  reminder: Reminder;
  t: Translate;
  memberById: Map<string, Member>;
  activeMembers: Member[];
  householdToday: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
  onDryRun: (memberId: string, date: string) => Promise<DryRunResult>;
}

function ReminderRow({
  reminder,
  t,
  memberById,
  activeMembers,
  householdToday,
  onEdit,
  onDelete,
  onToggleActive,
  onDryRun,
}: ReminderRowProps) {
  const isCalendarGated = reminder.kind === "calendar_gated";
  const [showDryRun, setShowDryRun] = useState(false);

  return (
    <li data-testid={`reminder-${reminder.id}`} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="truncate">{reminder.text}</span>
            <span className="bg-muted rounded-full px-2.5 py-0.5 text-sm font-medium">
              {isCalendarGated ? t("reminders.kind.calendarGated") : t("reminders.kind.scheduled")}
            </span>
          </p>
          <ReminderWho reminder={reminder} t={t} memberById={memberById} />
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-sm font-medium",
            reminder.active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          {reminder.active ? t("reminders.status.active") : t("reminders.status.off")}
        </span>
        {isCalendarGated && (
          <Button type="button" variant="link" onClick={() => setShowDryRun((prev) => !prev)}>
            {showDryRun ? t("reminders.dryRun.close") : t("reminders.dryRun.toggleShow")}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          data-testid={`reminder-toggle-${reminder.id}`}
          onClick={onToggleActive}
        >
          {reminder.active ? t("reminders.action.deactivate") : t("reminders.action.activate")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={`reminder-edit-${reminder.id}`}
          aria-label={`${t("reminders.action.edit")}: ${reminder.text}`}
          onClick={onEdit}
        >
          <Pencil className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive"
          data-testid={`reminder-delete-${reminder.id}`}
          aria-label={`${t("reminders.action.delete")}: ${reminder.text}`}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {isCalendarGated && showDryRun && (
        <DryRunPanel
          t={t}
          members={
            reminder.targetingMode === "specific"
              ? targetedMembers(reminder, memberById)
              : activeMembers
          }
          householdToday={householdToday}
          onDryRun={onDryRun}
        />
      )}
    </li>
  );
}

interface DryRunPanelProps {
  t: Translate;
  /** Who the rule can reach: its own active members (`specific`) or every active member. */
  members: Member[];
  householdToday: string;
  onDryRun: (memberId: string, date: string) => Promise<DryRunResult>;
}

/** The dry-run / explain panel of a calendar_gated row. It only offers members the rule targets:
 * the server explains the gate for any member, so asking about one the rule does not reach would
 * report a misleading "would emit". */
function DryRunPanel({ t, members, householdToday, onDryRun }: DryRunPanelProps) {
  const [dryRunMemberId, setDryRunMemberId] = useState("");
  const [dryRunDate, setDryRunDate] = useState(householdToday);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const dryRunRequestIdRef = useRef(0);

  // The verdict (or error) describes the PREVIOUS member/date once either changes — clear it and
  // invalidate any in-flight request so a slow response for stale inputs can't publish over it.
  useEffect(() => {
    dryRunRequestIdRef.current++;
    setDryRunResult(null);
    setDryRunError(null);
  }, [dryRunMemberId, dryRunDate]);

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

  return (
    <div className="border-t pt-3">
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
            {members.map((member) => (
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
  );
}

interface ReminderFormDialogProps {
  t: Translate;
  /** `null` = create. */
  reminder: Reminder | null;
  activeMembers: Member[];
  /** Resolves `true` when the request succeeded (the page has already refreshed). */
  onSubmit: (body: ReminderInput | ReminderEditInput) => Promise<boolean>;
  onClose: () => void;
}

/** One dialog for create and edit. Mounted only while open (keyed by reminder id), so its drafts
 * start fresh from the rule every time. The weekday, matrix and members drafts are separate state
 * so switching All/Specific back and forth keeps what was entered. */
function ReminderFormDialog({
  t,
  reminder,
  activeMembers,
  onSubmit,
  onClose,
}: ReminderFormDialogProps) {
  const editing = reminder !== null;
  const [kind, setKind] = useState<ReminderKind>(reminder?.kind ?? "scheduled");
  const [text, setText] = useState(reminder?.text ?? "");
  const [targetingMode, setTargetingMode] = useState<TargetingMode>(
    reminder?.targetingMode ?? "apply_to_all"
  );
  const [weekdays, setWeekdays] = useState<Weekday[]>(reminder?.weekdays ?? []);
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, Weekday[]>>(() =>
    reminder && reminder.kind === "scheduled" && reminder.targetingMode === "specific"
      ? Object.fromEntries(reminder.assignments.map((a) => [a.memberId, a.weekdays]))
      : {}
  );
  const [query, setQuery] = useState(reminder?.query ?? "");
  const [queryFields, setQueryFields] = useState<ReminderQueryField[]>(
    reminder?.queryFields ?? DEFAULT_QUERY_FIELDS
  );
  const [cgMemberIds, setCgMemberIds] = useState<string[]>(() =>
    reminder && reminder.kind === "calendar_gated"
      ? reminder.assignments.map((a) => a.memberId)
      : []
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const toggleQueryField = (field: ReminderQueryField) => {
    setQueryFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
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

  const buildBody = (): ReminderInput | ReminderEditInput => {
    const trimmedText = text.trim();
    if (kind === "scheduled") {
      if (targetingMode === "apply_to_all") {
        return editing
          ? { text: trimmedText, targetingMode: "apply_to_all", weekdays }
          : { kind: "scheduled", targetingMode: "apply_to_all", text: trimmedText, weekdays };
      }
      return editing
        ? { text: trimmedText, targetingMode: "specific", assignments }
        : { kind: "scheduled", targetingMode: "specific", text: trimmedText, assignments };
    }
    const trimmedQuery = query.trim();
    if (targetingMode === "apply_to_all") {
      return editing
        ? {
            text: trimmedText,
            targetingMode: "apply_to_all",
            query: trimmedQuery,
            queryFields,
          }
        : {
            kind: "calendar_gated",
            targetingMode: "apply_to_all",
            text: trimmedText,
            query: trimmedQuery,
            queryFields,
          };
    }
    const memberAssignments = membershipToAssignments(cgMemberIds);
    return editing
      ? {
          text: trimmedText,
          targetingMode: "specific",
          query: trimmedQuery,
          queryFields,
          assignments: memberAssignments,
        }
      : {
          kind: "calendar_gated",
          targetingMode: "specific",
          text: trimmedText,
          query: trimmedQuery,
          queryFields,
          assignments: memberAssignments,
        };
  };

  const submit = () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setFormError(null);
    void (async () => {
      const ok = await onSubmit(buildBody());
      if (ok) {
        onClose();
      } else {
        setFormError(t("reminders.management.saveError"));
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
        closeLabel={t("reminders.action.cancel")}
        data-testid="reminder-form-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? t("reminders.management.editTitle") : t("reminders.management.createTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("reminders.management.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex gap-2 items-center flex-wrap">
            <span className="text-muted-foreground text-control">
              {t("reminders.management.kindLabel")}
            </span>
            {editing ? (
              <span className="text-control font-medium">
                {kind === "calendar_gated"
                  ? t("reminders.kind.calendarGated")
                  : t("reminders.kind.scheduled")}
              </span>
            ) : (
              <ChoicePills<ReminderKind>
                value={kind}
                onChange={setKind}
                groupLabel={t("reminders.management.kindLabel")}
                options={[
                  {
                    value: "scheduled",
                    label: t("reminders.kind.scheduled"),
                    "data-testid": "reminder-kind-scheduled",
                  },
                  {
                    value: "calendar_gated",
                    label: t("reminders.kind.calendarGated"),
                    "data-testid": "reminder-kind-calendar_gated",
                  },
                ]}
              />
            )}
          </div>

          <Input
            type="text"
            placeholder={t("reminders.management.textPlaceholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={t("reminders.management.textPlaceholder")}
          />

          <div className="flex gap-2 items-center flex-wrap">
            <span className="text-muted-foreground text-control">
              {t("reminders.management.targetingLabel")}
            </span>
            <ChoicePills<TargetingMode>
              value={targetingMode}
              onChange={setTargetingMode}
              groupLabel={t("reminders.management.targetingLabel")}
              options={[
                {
                  value: "apply_to_all",
                  label: t("reminders.management.targetingApplyToAll"),
                  "data-testid": "reminder-targeting-apply_to_all",
                },
                {
                  value: "specific",
                  label: t("reminders.management.targetingSpecific"),
                  "data-testid": "reminder-targeting-specific",
                },
              ]}
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
                testIdPrefix="reminders-weekday-form"
              />
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-muted-foreground text-control">
                  {t("reminders.specific.membersLabel")}
                </span>
                <ReminderMemberDays
                  members={activeMembers}
                  value={assignmentDraft}
                  onChange={setAssignmentDraft}
                  labels={weekdayLabels(t)}
                  weekdaysLabel={t("reminders.management.weekdaysLabel")}
                  emptyMessage={t("reminders.matrix.noActiveMembers")}
                  hint={t("reminders.specific.membersHint")}
                />
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm">
                {t("reminders.calendarGated.queryLabel")}
                <Input
                  type="text"
                  placeholder={t("reminders.calendarGated.queryPlaceholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="flex gap-2 items-center flex-wrap">
                <span className="text-muted-foreground text-control">
                  {t("reminders.calendarGated.queryFieldsLabel")}
                </span>
                <div
                  role="group"
                  aria-label={t("reminders.calendarGated.queryFieldsLabel")}
                  className="flex flex-wrap gap-2"
                >
                  {QUERY_FIELDS.map((field) => (
                    <PillToggle
                      key={field}
                      checked={queryFields.includes(field)}
                      onChange={() => toggleQueryField(field)}
                      label={t(QUERY_FIELD_LABEL_KEYS[field])}
                      data-testid={`reminders-query-field-${field}`}
                    />
                  ))}
                </div>
              </div>
              {targetingMode === "specific" && (
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-control">
                    {t("reminders.calendarGated.membershipTitle")}
                  </span>
                  {activeMembers.length === 0 ? (
                    <p className="text-muted-foreground text-control">
                      {t("reminders.calendarGated.noActiveMembers")}
                    </p>
                  ) : (
                    <MemberPills
                      members={activeMembers}
                      value={cgMemberIds}
                      onChange={setCgMemberIds}
                      groupLabel={t("reminders.calendarGated.membershipTitle")}
                      testIdPrefix="reminders-cg-member"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          <ErrorNotice message={formError} />

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t("reminders.action.cancel")}
            </Button>
            <Button type="submit" data-testid="reminder-save" disabled={!canSubmit || saving}>
              {editing ? t("reminders.action.save") : t("reminders.action.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
