import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import {
  Role,
  type Assignment,
  type Chore,
  type ChoreInput,
  type DayPeriodDTO,
  type Member,
  type Routine,
  type RoutineInput,
  type Weekday,
} from "../../shared";
import { useT } from "@/i18n";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { AssignmentDialog } from "@/routines/admin/AssignmentDialog";
import { ChoreFormDialog } from "@/routines/admin/ChoreFormDialog";
import { RoutineDetail } from "@/routines/admin/RoutineDetail";
import { RoutineFormDialog } from "@/routines/admin/RoutineFormDialog";
import { RoutineList } from "@/routines/admin/RoutineList";

/* ------------------------------------------------------------------ */
/* RoutinesManagement — master/detail admin page for routines, chores */
/* and weekday assignments. Loads data, owns the selection and runs   */
/* every mutation; the panes and dialogs in src/client/routines/admin */
/* only render. Every streak-affecting action is confirmed in those   */
/* components through ConfirmDialog before it reaches this file.      */
/* ------------------------------------------------------------------ */

/** Detail of one routine. `routineId` ties it to the routine it was loaded for, so a detail
 * left over from the previous selection is never rendered under another routine's header. */
type DetailState =
  | { status: "idle" }
  | { status: "loading" | "error"; routineId: string }
  | { status: "ready"; routineId: string; chores: Chore[]; assignments: Assignment[] };

async function getJson<T>(url: string): Promise<T> {
  const response = await authFetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return (await response.json()) as T;
}

async function send(url: string, method: string, body?: unknown): Promise<Response> {
  const response = await authFetch(url, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status}`);
  return response;
}

export function RoutinesManagement() {
  const t = useT();
  const [dayPeriods, setDayPeriods] = useState<DayPeriodDTO[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [routineForm, setRoutineForm] = useState<{ routine: Routine | null } | null>(null);
  const [choreForm, setChoreForm] = useState<{ chore: Chore | null } | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);

  async function loadBase() {
    setLoading(true);
    setLoadError(false);
    try {
      const [periods, list, people] = await Promise.all([
        getJson<DayPeriodDTO[]>("/api/day-periods"),
        getJson<Routine[]>("/api/routines"),
        getJson<Member[]>("/api/members"),
      ]);
      setDayPeriods(periods);
      setRoutines(list);
      setMembers(people);
      setSelectedId((current) => (current && list.some((r) => r.id === current) ? current : null));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function refreshRoutines() {
    const list = await getJson<Routine[]>("/api/routines");
    setRoutines(list);
    setSelectedId((current) => (current && list.some((r) => r.id === current) ? current : null));
  }

  /** Loads the selected routine's chores and assignments. A response for a routine that is no
   * longer selected is dropped. `quiet` keeps the current detail on screen while refreshing. */
  async function loadDetail(routineId: string, quiet = false) {
    if (!quiet) setDetail({ status: "loading", routineId });
    try {
      const [chores, assignments] = await Promise.all([
        getJson<Chore[]>(`/api/routines/${routineId}/chores`),
        getJson<Assignment[]>(`/api/routines/${routineId}/assignments`),
      ]);
      if (selectedRef.current === routineId) {
        setDetail({ status: "ready", routineId, chores, assignments });
      }
    } catch {
      if (selectedRef.current === routineId) setDetail({ status: "error", routineId });
    }
  }

  useEffect(() => {
    void loadBase();
  }, []);

  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId) void loadDetail(selectedId);
    else setDetail({ status: "idle" });
  }, [selectedId]);

  /** Runs one write with the page busy; `fail` reports the error where the user is looking. */
  async function mutate(work: () => Promise<void>, fail: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  }

  const selected = routines.find((routine) => routine.id === selectedId) ?? null;
  // A detail loaded for another routine is shown as loading until this one's arrives.
  const shownDetail: DetailState =
    selected === null
      ? { status: "idle" }
      : detail.status !== "idle" && detail.routineId === selected.id
        ? detail
        : { status: "loading", routineId: selected.id };
  const childMembers = members.filter((m) => m.role === Role.child);
  const periodLabel = (id: string) => {
    const period = dayPeriods.find((p) => p.id === id);
    return period ? t(DAY_PERIOD_LABEL_KEYS[period.id]) : "";
  };

  function saveRoutine(input: RoutineInput) {
    const editing = routineForm?.routine ?? null;
    setFormError(null);
    void mutate(
      async () => {
        const response = editing
          ? await send(`/api/routines/${editing.id}`, "PATCH", input)
          : await send("/api/routines", "POST", input);
        const saved = (await response.json()) as Routine;
        setRoutineForm(null);
        try {
          await refreshRoutines();
        } catch {
          // Saved, but the list is stale: the dialog is closed, so report it on the page.
          setActionError(t("routines.management.error"));
          return;
        }
        setSelectedId(saved.id);
      },
      () => setFormError(t("routines.admin.saveError"))
    );
  }

  function deleteRoutine(routineId: string) {
    void mutate(
      async () => {
        await send(`/api/routines/${routineId}`, "DELETE");
        setSelectedId(null);
        await refreshRoutines();
      },
      () => setActionError(t("routines.management.error"))
    );
  }

  function saveChore(input: ChoreInput) {
    if (!selected) return;
    const routineId = selected.id;
    const editing = choreForm?.chore ?? null;
    setFormError(null);
    void mutate(
      async () => {
        if (editing) await send(`/api/chores/${editing.id}`, "PATCH", input);
        else await send(`/api/routines/${routineId}/chores`, "POST", input);
        setChoreForm(null);
        await loadDetail(routineId, true);
      },
      () => setFormError(t("routines.admin.choreSaveError"))
    );
  }

  function deleteChore(chore: Chore) {
    void mutate(
      async () => {
        await send(`/api/chores/${chore.id}`, "DELETE");
        await loadDetail(chore.routineId, true);
      },
      () => setActionError(t("routines.chores.error"))
    );
  }

  function reorderChores(next: Chore[]) {
    if (!selected || shownDetail.status !== "ready" || busy) return;
    const routineId = selected.id;
    const previous = shownDetail.chores;
    setDetail({ ...shownDetail, chores: next });
    void mutate(
      async () => {
        const response = await send(`/api/routines/${routineId}/chores/order`, "PUT", {
          choreIds: next.map((chore) => chore.id),
        });
        const saved = (await response.json()) as Chore[];
        setDetail((current) =>
          current.status === "ready" && current.routineId === routineId
            ? { ...current, chores: saved }
            : current
        );
      },
      () => {
        setDetail((current) =>
          current.status === "ready" && current.routineId === routineId
            ? { ...current, chores: previous }
            : current
        );
        setActionError(t("routines.chores.reorderError"));
        void loadDetail(routineId, true);
      }
    );
  }

  function saveAssignment(memberId: string, weekdays: Weekday[]) {
    if (!selected) return;
    const routineId = selected.id;
    void mutate(
      async () => {
        await send(`/api/routines/${routineId}/assignments/${memberId}`, "PUT", {
          weekdays,
          active: true,
        });
        await loadDetail(routineId, true);
      },
      () => setActionError(t("routines.assignments.error"))
    );
  }

  function deactivateAssignment(memberId: string) {
    if (!selected) return;
    const routineId = selected.id;
    void mutate(
      async () => {
        await send(`/api/routines/${routineId}/assignments/${memberId}`, "DELETE");
        await loadDetail(routineId, true);
      },
      () => setActionError(t("routines.assignments.error"))
    );
  }

  return (
    <AdminPanel
      title={t("routines.management.title")}
      description={t("routines.management.description")}
      className="w-full"
      data-testid="routines-management"
    >
      {loading ? (
        <p role="status" className="text-muted-foreground text-control">
          {t("routines.management.loading")}
        </p>
      ) : loadError ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorNotice message={t("routines.management.error")} />
          <Button variant="outline" onClick={() => void loadBase()} data-testid="routines-retry">
            {t("routines.admin.retry")}
          </Button>
        </div>
      ) : (
        <>
          {/* While the assignment dialog is open the page behind it is inert; its errors show inside it. */}
          {!assignOpen && <ErrorNotice message={actionError} />}
          <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <RoutineList
              routines={routines}
              dayPeriods={dayPeriods}
              selectedId={selectedId}
              onSelect={(id) => {
                setActionError(null);
                setSelectedId(id);
              }}
              onNew={() => {
                setFormError(null);
                setRoutineForm({ routine: null });
              }}
            />
            {selected === null ? (
              <p
                className="bg-card text-muted-foreground text-control rounded-3xl border p-6 text-center"
                data-testid="routines-select-prompt"
              >
                {t("routines.admin.selectPrompt")}
              </p>
            ) : shownDetail.status === "ready" ? (
              <RoutineDetail
                routine={selected}
                periodLabel={periodLabel(selected.dayPeriodId)}
                chores={shownDetail.chores}
                assignments={shownDetail.assignments}
                members={childMembers}
                busy={busy}
                onEdit={() => {
                  setFormError(null);
                  setRoutineForm({ routine: selected });
                }}
                onAssign={() => {
                  setActionError(null);
                  setAssignOpen(true);
                }}
                onAddChore={() => {
                  setFormError(null);
                  setChoreForm({ chore: null });
                }}
                onEditChore={(chore) => {
                  setFormError(null);
                  setChoreForm({ chore });
                }}
                onDelete={() => deleteRoutine(selected.id)}
                onDeleteChore={deleteChore}
                onReorder={reorderChores}
              />
            ) : shownDetail.status === "error" ? (
              <div className="bg-card flex flex-col items-start gap-2 rounded-3xl border p-4">
                <ErrorNotice message={t("routines.admin.detailError")} />
                <Button
                  variant="outline"
                  onClick={() => void loadDetail(selected.id)}
                  data-testid="routine-detail-retry"
                >
                  {t("routines.admin.retry")}
                </Button>
              </div>
            ) : (
              <p role="status" className="text-muted-foreground text-control">
                {t("routines.management.loading")}
              </p>
            )}
          </div>
        </>
      )}

      <RoutineFormDialog
        open={routineForm !== null}
        routine={routineForm?.routine ?? null}
        dayPeriods={dayPeriods}
        saving={busy}
        error={formError}
        onClose={() => setRoutineForm(null)}
        onSubmit={saveRoutine}
      />
      <ChoreFormDialog
        open={choreForm !== null}
        chore={choreForm?.chore ?? null}
        saving={busy}
        error={formError}
        onClose={() => setChoreForm(null)}
        onSubmit={saveChore}
      />
      <AssignmentDialog
        open={assignOpen && shownDetail.status === "ready"}
        childMembers={childMembers}
        assignments={shownDetail.status === "ready" ? shownDetail.assignments : []}
        busy={busy}
        error={actionError}
        onClose={() => {
          setAssignOpen(false);
          setActionError(null);
        }}
        onSave={saveAssignment}
        onDeactivate={deactivateAssignment}
      />
    </AdminPanel>
  );
}
