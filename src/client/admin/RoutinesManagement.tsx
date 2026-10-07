import { useState, useEffect } from "react";
import { authFetch } from "@/lib/credential";
import {
  DayPeriodDTO,
  Routine,
  RoutineInput,
  RoutineEditInput,
  Chore,
  ChoreInput,
  ChoreEditInput,
  Assignment,
  Member,
  Role,
  Weekday,
} from "../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useTranslation } from "@/i18n";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { ChoreOrderControls } from "./ChoreOrderControls";
import { EmojiPicker } from "@/chores/EmojiPicker";
import { NotoEmoji } from "@/chores/noto-emoji";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { WeekdayPicker, type WeekdayLabels } from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ------------------------------------------------------------------ */
/* RoutinesManagement — CRUD UI for routines, chores and assignments */
/* */
/* (token dialect, FR-005/FR-009): migrated to the */
/* shared L2 components. SC-009: the local `WEEKDAYS` constant */
/* this file used to declare is replaced by `WeekdayPicker`'s */
/* canonical order (names this file as one of the five */
/* call sites carrying its own weekday literal). Every destructive/ */
/* streak-affecting action (routine delete, chore delete, assignment */
/* deactivate, and reassigning an already-active assignment) now */
/* opens a themed `ConfirmDialog` instead of `window.confirm`, */
/* mirroring `MealsManagement.tsx`'s precedent (*/
/* FR-005) — the confirmation decision moves to the UI layer, and */
/* each mutation function below performs its write unconditionally */
/* once the caller has already confirmed. */
/* ------------------------------------------------------------------ */

const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "routines.assignments.weekday.mon",
  tue: "routines.assignments.weekday.tue",
  wed: "routines.assignments.weekday.wed",
  thu: "routines.assignments.weekday.thu",
  fri: "routines.assignments.weekday.fri",
  sat: "routines.assignments.weekday.sat",
  sun: "routines.assignments.weekday.sun",
};

/** Builds `WeekdayPicker`'s localized label map from this surface's own translation namespace
 * (`routines.assignments.weekday.*`) — call-site-owned, per the component's own doc comment. */
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

export function RoutinesManagement() {
  const { t } = useTranslation();

  const [dayPeriods, setDayPeriods] = useState<DayPeriodDTO[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [choresByRoutine, setChoresByRoutine] = useState<Record<string, Chore[]>>({});
  const [assignmentsByRoutine, setAssignmentsByRoutine] = useState<Record<string, Assignment[]>>(
    {}
  );
  const [activeChildren, setActiveChildren] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [dayPeriodsRes, routinesRes, membersRes] = await Promise.all([
        authFetch("/api/day-periods", { credentials: "include" }),
        authFetch("/api/routines", { credentials: "include" }),
        authFetch("/api/members", { credentials: "include" }),
      ]);

      if (!dayPeriodsRes.ok) throw new Error("Failed to load day periods");
      if (!routinesRes.ok) throw new Error("Failed to load routines");
      if (!membersRes.ok) throw new Error("Failed to load members");

      const [dayPeriodsData, routinesData, membersData] = (await Promise.all([
        dayPeriodsRes.json(),
        routinesRes.json(),
        membersRes.json(),
      ])) as [DayPeriodDTO[], Routine[], Member[]];

      const choresEntries = await Promise.all(
        routinesData.map(async (routine): Promise<[string, Chore[]]> => {
          const res = await authFetch(`/api/routines/${routine.id}/chores`, {
            credentials: "include",
          });
          if (!res.ok) throw new Error("Failed to load chores");
          return [routine.id, (await res.json()) as Chore[]];
        })
      );

      const assignmentsEntries = await Promise.all(
        routinesData.map(async (routine): Promise<[string, Assignment[]]> => {
          const res = await authFetch(`/api/routines/${routine.id}/assignments`, {
            credentials: "include",
          });
          if (!res.ok) throw new Error("Failed to load assignments");
          return [routine.id, (await res.json()) as Assignment[]];
        })
      );

      setDayPeriods(dayPeriodsData);
      setRoutines(routinesData);
      setActiveChildren(membersData.filter((m) => m.role === Role.child));
      setChoresByRoutine(Object.fromEntries(choresEntries));
      setAssignmentsByRoutine(Object.fromEntries(assignmentsEntries));
    } catch {
      setError(t("routines.management.error"));
    } finally {
      setLoading(false);
    }
  }

  async function createRoutine(name: string, dayPeriodId: string) {
    try {
      const input: RoutineInput = { name, dayPeriodId };
      const res = await authFetch("/api/routines", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to create routine");
      await loadData();
    } catch {
      setError(t("routines.management.error"));
    }
  }

  async function editRoutine(id: string, updates: RoutineEditInput) {
    try {
      const res = await authFetch(`/api/routines/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update routine");
      await loadData();
    } catch {
      setError(t("routines.management.error"));
    }
  }

  /** Confirmation now lives at the UI layer (`RoutineCard`'s `ConfirmDialog`) — this performs the
   * delete unconditionally once the caller has already confirmed (FR-005). */
  async function deleteRoutine(id: string) {
    try {
      const res = await authFetch(`/api/routines/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete routine");
      await loadData();
    } catch {
      setError(t("routines.management.error"));
    }
  }

  async function createChore(routineId: string, name: string, icon: string | null) {
    try {
      const input: ChoreInput = { name, icon };
      const res = await authFetch(`/api/routines/${routineId}/chores`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to create chore");
      await loadData();
    } catch {
      setError(t("routines.chores.error"));
    }
  }

  async function editChore(id: string, updates: ChoreEditInput) {
    try {
      const res = await authFetch(`/api/chores/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update chore");
      await loadData();
    } catch {
      setError(t("routines.chores.error"));
    }
  }

  /** See `deleteRoutine` above — confirmation moved to `RoutineCard`'s `ConfirmDialog`. */
  async function deleteChore(id: string) {
    try {
      const res = await authFetch(`/api/chores/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete chore");
      await loadData();
    } catch {
      setError(t("routines.chores.error"));
    }
  }

  async function refreshAfterReorder() {
    // ChoreOrderControls already persisted the new order via PUT
    // /api/routines/:id/chores/order — this only refreshes local state.
    await loadData();
  }

  async function saveAssignment(
    routineId: string,
    memberId: string,
    weekdays: Weekday[],
    active: boolean
  ) {
    try {
      const res = await authFetch(`/api/routines/${routineId}/assignments/${memberId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekdays, active }),
      });
      if (!res.ok) throw new Error("Failed to save assignment");
      await loadData();
    } catch {
      setError(t("routines.assignments.error"));
    }
  }

  /** See `deleteRoutine` above — confirmation moved to `AssignmentRow`'s `ConfirmDialog`. */
  async function deactivateAssignment(routineId: string, memberId: string) {
    try {
      const res = await authFetch(`/api/routines/${routineId}/assignments/${memberId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to deactivate assignment");
      await loadData();
    } catch {
      setError(t("routines.assignments.error"));
    }
  }

  // Indexes the closed `PeriodId` union (`dp.id`, `shared/index.ts`'s `DayPeriodDTO`) through the
  // shared `DAY_PERIOD_LABEL_KEYS` map (`DailyBriefingView.tsx`, precedent) instead of
  // casting the server-supplied `labelKey` string to `MessageKey` — the last two SC-007 casts
  // this file carried.
  const dayPeriodLabel = (id: string): string => {
    const dp = dayPeriods.find((d) => d.id === id);
    return dp ? t(DAY_PERIOD_LABEL_KEYS[dp.id]) : "";
  };

  if (loading) {
    return (
      <AdminPanel title={t("routines.management.title")}>
        <p>{t("routines.management.loading")}</p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("routines.management.title")}
      description={t("routines.management.description")}
    >
      <ErrorNotice message={error} />

      <RoutineCreateForm
        dayPeriods={dayPeriods}
        t={t}
        onCreate={(name, dayPeriodId) => void createRoutine(name, dayPeriodId)}
      />

      <div>
        <h3 className="text-lg font-semibold mb-2">{t("routines.management.routines")}</h3>
        {routines.length === 0 && (
          <p className="text-muted-foreground">{t("routines.management.noRoutines")}</p>
        )}
        <div className="space-y-4">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              dayPeriodName={dayPeriodLabel(routine.dayPeriodId)}
              t={t}
              chores={choresByRoutine[routine.id] ?? []}
              assignments={assignmentsByRoutine[routine.id] ?? []}
              activeChildren={activeChildren}
              onRename={(name) => void editRoutine(routine.id, { name })}
              onDelete={() => void deleteRoutine(routine.id)}
              onAddChore={(name, icon) => void createChore(routine.id, name, icon)}
              onEditChore={(choreId, updates) => void editChore(choreId, updates)}
              onDeleteChore={(id) => void deleteChore(id)}
              onReorder={() => void refreshAfterReorder()}
              onSaveAssignment={(memberId, weekdays, active) =>
                void saveAssignment(routine.id, memberId, weekdays, active)
              }
              onDeactivateAssignment={(memberId) => void deactivateAssignment(routine.id, memberId)}
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

interface RoutineCreateFormProps {
  dayPeriods: DayPeriodDTO[];
  t: (key: MessageKey) => string;
  onCreate: (name: string, dayPeriodId: string) => void;
}

function RoutineCreateForm({ dayPeriods, t, onCreate }: RoutineCreateFormProps) {
  const [name, setName] = useState("");
  const [dayPeriodId, setDayPeriodId] = useState("");

  return (
    <div className="bg-card p-4 rounded-lg shadow mb-6">
      <h3 className="text-md font-semibold mb-2">{t("routines.management.createTitle")}</h3>
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder={t("routines.management.createNamePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("routines.management.createNamePlaceholder")}
        />
        <Select value={dayPeriodId} onValueChange={setDayPeriodId}>
          <SelectTrigger aria-label={t("routines.management.selectDayPeriod")}>
            <SelectValue placeholder={t("routines.management.selectDayPeriod")} />
          </SelectTrigger>
          <SelectContent>
            {dayPeriods.map((dp) => (
              <SelectItem key={dp.id} value={dp.id}>
                {t(DAY_PERIOD_LABEL_KEYS[dp.id])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          onClick={() => {
            if (name.trim() && dayPeriodId) {
              onCreate(name.trim(), dayPeriodId);
              setName("");
              setDayPeriodId("");
            }
          }}
        >
          {t("routines.action.create")}
        </Button>
      </div>
    </div>
  );
}

interface RoutineCardProps {
  routine: Routine;
  dayPeriodName: string;
  t: (key: MessageKey) => string;
  chores: Chore[];
  assignments: Assignment[];
  activeChildren: Member[];
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddChore: (name: string, icon: string | null) => void;
  onEditChore: (choreId: string, updates: ChoreEditInput) => void;
  onDeleteChore: (id: string) => void;
  onReorder: (choreIds: string[]) => void;
  onSaveAssignment: (memberId: string, weekdays: Weekday[], active: boolean) => void;
  onDeactivateAssignment: (memberId: string) => void;
}

function RoutineCard({
  routine,
  dayPeriodName,
  t,
  chores,
  assignments,
  activeChildren,
  onRename,
  onDelete,
  onAddChore,
  onEditChore,
  onDeleteChore,
  onReorder,
  onSaveAssignment,
  onDeactivateAssignment,
}: RoutineCardProps) {
  const [newChoreName, setNewChoreName] = useState("");
  const [newChoreIcon, setNewChoreIcon] = useState<string | null>(null);
  const [showChores, setShowChores] = useState(false);
  const [showAssignments, setShowAssignments] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(routine.name);
  const [editingChoreId, setEditingChoreId] = useState<string | null>(null);
  const [choreNameDraft, setChoreNameDraft] = useState("");
  const [choreIconDraft, setChoreIconDraft] = useState<string | null>(null);
  // FR-014 (docs/features/routines-chores.md): deleting a routine or a chore changes the live
  // streak — both directions now go through a themed `ConfirmDialog` instead of `window.confirm`
  // (FR-005), mirroring `MealsManagement.tsx`'s delete-confirmation split.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [choreDeleteTarget, setChoreDeleteTarget] = useState<Chore | null>(null);

  const startEditChore = (chore: Chore) => {
    setEditingChoreId(chore.id);
    setChoreNameDraft(chore.name);
    setChoreIconDraft(chore.icon);
  };

  return (
    <div className="border rounded-lg p-4 mb-4" data-testid={`routine-${routine.id}`}>
      <div className="flex justify-between items-start">
        <div>
          {editingName ? (
            <div className="flex gap-2 items-center">
              <Input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                aria-label={t("routines.management.createNamePlaceholder")}
              />
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  if (nameDraft.trim()) {
                    onRename(nameDraft.trim());
                    setEditingName(false);
                  }
                }}
                disabled={!nameDraft.trim()}
              >
                {t("routines.action.save")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setNameDraft(routine.name);
                  setEditingName(false);
                }}
              >
                {t("routines.action.cancel")}
              </Button>
            </div>
          ) : (
            <h4 className="text-md font-semibold flex items-center gap-2">
              {routine.name}
              <Button type="button" variant="link" onClick={() => setEditingName(true)}>
                {t("routines.action.edit")}
              </Button>
            </h4>
          )}
          <p className="text-muted-foreground text-sm">{dayPeriodName}</p>
        </div>
        <Button
          type="button"
          variant="link"
          className="text-destructive hover:text-destructive/80"
          onClick={() => setShowDeleteConfirm(true)}
        >
          {t("routines.action.delete")}
        </Button>
      </div>

      <div className="mt-4 flex gap-4">
        <Button type="button" variant="link" onClick={() => setShowChores(!showChores)}>
          {showChores ? t("routines.action.close") : t("routines.action.viewChores")}
        </Button>
        <Button type="button" variant="link" onClick={() => setShowAssignments(!showAssignments)}>
          {showAssignments
            ? t("routines.action.close")
            : t("routines.management.membersWithAssignments")}
        </Button>
      </div>

      {showChores && (
        <div className="mt-2">
          <div className="flex gap-2 mb-2">
            <EmojiPicker value={newChoreIcon} onChange={setNewChoreIcon} />
            <Input
              type="text"
              placeholder={t("routines.chores.placeholder")}
              value={newChoreName}
              onChange={(e) => setNewChoreName(e.target.value)}
              aria-label={t("routines.chores.placeholder")}
            />
            <Button
              type="button"
              onClick={() => {
                if (newChoreName.trim()) {
                  onAddChore(newChoreName.trim(), newChoreIcon);
                  setNewChoreName("");
                  setNewChoreIcon(null);
                }
              }}
            >
              {t("routines.action.createChore")}
            </Button>
          </div>
          <ul className="space-y-1">
            {chores.map((chore) => (
              <li
                key={chore.id}
                className="flex justify-between items-center"
                data-testid={`chore-${chore.id}`}
              >
                {editingChoreId === chore.id ? (
                  <div className="flex gap-2 items-center flex-1">
                    <EmojiPicker value={choreIconDraft} onChange={setChoreIconDraft} />
                    <Input
                      type="text"
                      value={choreNameDraft}
                      onChange={(e) => setChoreNameDraft(e.target.value)}
                      aria-label={t("routines.chores.placeholder")}
                    />
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => {
                        if (choreNameDraft.trim()) {
                          onEditChore(chore.id, {
                            name: choreNameDraft.trim(),
                            icon: choreIconDraft,
                          });
                          setEditingChoreId(null);
                        }
                      }}
                      disabled={!choreNameDraft.trim()}
                    >
                      {t("routines.action.save")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setEditingChoreId(null);
                        setChoreIconDraft(null);
                      }}
                    >
                      {t("routines.action.cancel")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="flex items-center gap-2">
                      <NotoEmoji emoji={chore.icon ?? "📋"} size={20} className="text-xl" />
                      {chore.name}
                    </span>
                    <div className="flex gap-2">
                      <Button type="button" variant="link" onClick={() => startEditChore(chore)}>
                        {t("routines.action.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="link"
                        className="text-destructive hover:text-destructive/80"
                        onClick={() => setChoreDeleteTarget(chore)}
                      >
                        {t("routines.action.delete")}
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2">
            <ChoreOrderControls
              routineId={routine.id}
              chores={chores.map((c) => ({ id: c.id, name: c.name }))}
              onReorder={onReorder}
            />
          </div>
        </div>
      )}

      {showAssignments && (
        <div className="mt-2">
          {activeChildren.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("routines.assignments.noAssignment")}
            </p>
          ) : (
            <div className="space-y-2">
              {activeChildren.map((child) => (
                <AssignmentRow
                  key={child.id}
                  child={child}
                  assignment={assignments.find((a) => a.memberId === child.id)}
                  t={t}
                  onSave={(weekdays, active) => onSaveAssignment(child.id, weekdays, active)}
                  onDeactivate={() => onDeactivateAssignment(child.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={(open) => {
          if (!open) setShowDeleteConfirm(false);
        }}
        title={t("routines.action.delete")}
        description={`${t("routines.action.deleteConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.action.delete")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={onDelete}
        confirmTestId={`routine-delete-confirm-${routine.id}`}
        cancelTestId={`routine-delete-cancel-${routine.id}`}
      />
      <ConfirmDialog
        open={choreDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setChoreDeleteTarget(null);
        }}
        title={t("routines.action.delete")}
        description={`${t("routines.chores.deleteConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.action.delete")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={() => {
          if (choreDeleteTarget) onDeleteChore(choreDeleteTarget.id);
        }}
        confirmTestId={`routine-${routine.id}-chore-delete-confirm`}
        cancelTestId={`routine-${routine.id}-chore-delete-cancel`}
      />
    </div>
  );
}

interface AssignmentRowProps {
  child: Member;
  assignment: Assignment | undefined;
  t: (key: MessageKey) => string;
  onSave: (weekdays: Weekday[], active: boolean) => void;
  onDeactivate: () => void;
}

function AssignmentRow({ child, assignment, t, onSave, onDeactivate }: AssignmentRowProps) {
  const [weekdays, setWeekdays] = useState<Weekday[]>(assignment?.weekdays ?? []);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const isActive = assignment?.active ?? false;

  const requestSave = () => {
    // Reassigning an existing row — active or reactivating a deactivated one — changes the
    // live streak (FR-014, docs/features/routines-chores.md); a brand-new assignment has no
    // prior history to affect, so it saves immediately without a confirmation step.
    if (assignment !== undefined) {
      setShowSaveConfirm(true);
    } else {
      onSave(weekdays, true);
    }
  };

  return (
    <div
      className="flex items-center gap-2 py-1 flex-wrap"
      data-testid={`routine-assignment-${child.id}`}
    >
      <span className="w-32">{child.displayName}</span>
      <WeekdayPicker
        mode="multi"
        value={weekdays}
        onChange={(next) => setWeekdays([...next])}
        labels={weekdayLabels(t)}
        groupLabel={t("routines.assignments.weekdaysLabel")}
        testIdPrefix={`routines-weekday-${child.id}`}
      />
      <Button type="button" onClick={requestSave} disabled={weekdays.length === 0}>
        {t("routines.assignments.save")}
      </Button>
      {isActive && (
        <Button type="button" variant="secondary" onClick={() => setShowDeactivateConfirm(true)}>
          {t("routines.assignments.deactivate")}
        </Button>
      )}
      <ConfirmDialog
        open={showSaveConfirm}
        onOpenChange={(open) => {
          if (!open) setShowSaveConfirm(false);
        }}
        title={t("routines.assignments.save")}
        description={t("routines.action.streakWarning")}
        confirmLabel={t("routines.assignments.save")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={() => onSave(weekdays, true)}
        destructive={false}
        confirmTestId={`routines-assignment-${child.id}-save-confirm`}
        cancelTestId={`routines-assignment-${child.id}-save-cancel`}
      />
      <ConfirmDialog
        open={showDeactivateConfirm}
        onOpenChange={(open) => {
          if (!open) setShowDeactivateConfirm(false);
        }}
        title={t("routines.assignments.deactivate")}
        description={`${t("routines.assignments.deactivateConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.assignments.deactivate")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={onDeactivate}
        confirmTestId={`routines-assignment-${child.id}-deactivate-confirm`}
        cancelTestId={`routines-assignment-${child.id}-deactivate-cancel`}
      />
    </div>
  );
}
