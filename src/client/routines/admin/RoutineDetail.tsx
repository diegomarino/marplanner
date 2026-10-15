import { useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import type { Assignment, Chore, Member, Routine } from "../../../shared";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RoutineWeekGrid } from "./RoutineWeekGrid";
import { SortableChoreRow } from "./SortableChoreRow";
import { moveChore } from "./routineOrder";

export interface RoutineDetailProps {
  routine: Routine;
  periodLabel: string;
  chores: Chore[];
  assignments: Assignment[];
  members: Member[];
  busy: boolean;
  onEdit: () => void;
  onAssign: () => void;
  onAddChore: () => void;
  onEditChore: (chore: Chore) => void;
  /** Called after the user confirmed the streak warning. */
  onDelete: () => void;
  /** Called after the user confirmed the streak warning. */
  onDeleteChore: (chore: Chore) => void;
  onReorder: (next: Chore[]) => void;
}

export function RoutineDetail({
  routine,
  periodLabel,
  chores,
  assignments,
  members,
  busy,
  onEdit,
  onAssign,
  onAddChore,
  onEditChore,
  onDelete,
  onDeleteChore,
  onReorder,
}: RoutineDetailProps) {
  const t = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [choreToDelete, setChoreToDelete] = useState<Chore | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const nameOf = (id: UniqueIdentifier) =>
    chores.find((chore) => chore.id === String(id))?.name ?? "";

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || busy) return;
    const next = moveChore(chores, String(event.active.id), String(event.over.id));
    if (next) onReorder(next);
  }

  return (
    <section
      aria-labelledby="routine-detail-heading"
      className="bg-card flex min-w-0 flex-col gap-4 rounded-3xl border p-4 shadow-sm"
      data-testid="routine-detail"
      data-routine-id={routine.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="routine-detail-heading" className="text-xl font-semibold break-words">
            {routine.name}
          </h3>
          <p className="text-muted-foreground text-control">{periodLabel}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit} data-testid="routine-edit">
            <Pencil aria-hidden="true" />
            {t("routines.admin.editRoutine")}
          </Button>
          <Button variant="outline" size="sm" onClick={onAssign} data-testid="routine-assign">
            <Users aria-hidden="true" />
            {t("routines.admin.assign")}
          </Button>
          <Button size="sm" onClick={onAddChore} data-testid="routine-add-chore">
            <Plus aria-hidden="true" />
            {t("routines.action.createChore")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setConfirmDelete(true)}
            data-testid="routine-delete"
          >
            <Trash2 aria-hidden="true" />
            {t("routines.admin.deleteRoutine")}
          </Button>
        </div>
      </div>

      <RoutineWeekGrid assignments={assignments} members={members} onOpen={onAssign} />

      {chores.length === 0 ? (
        <p className="text-muted-foreground text-control" data-testid="routine-chores-empty">
          {t("routines.admin.noChores")}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={{
            screenReaderInstructions: { draggable: t("routines.admin.dragInstructions") },
            announcements: {
              onDragStart: ({ active }) =>
                t("routines.admin.dragStarted").replace("{name}", nameOf(active.id)),
              onDragOver: ({ active, over }) =>
                over
                  ? t("routines.admin.dragOver")
                      .replace("{name}", nameOf(active.id))
                      .replace(
                        "{position}",
                        String(chores.findIndex((chore) => chore.id === String(over.id)) + 1)
                      )
                  : "",
              onDragEnd: ({ active }) =>
                t("routines.admin.dragEnded").replace("{name}", nameOf(active.id)),
              onDragCancel: () => t("routines.admin.dragCancelled"),
            },
          }}
        >
          <SortableContext
            items={chores.map((chore) => chore.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {chores.map((chore) => (
                <SortableChoreRow
                  key={chore.id}
                  chore={chore}
                  busy={busy}
                  onEdit={onEditChore}
                  onDelete={setChoreToDelete}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("routines.admin.deleteRoutine")}
        description={`${t("routines.action.deleteConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.action.delete")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={onDelete}
        confirmTestId={`routine-delete-confirm-${routine.id}`}
        cancelTestId={`routine-delete-cancel-${routine.id}`}
      />
      <ConfirmDialog
        open={choreToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setChoreToDelete(null);
        }}
        title={t("routines.action.delete")}
        description={`${t("routines.chores.deleteConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.action.delete")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={() => {
          if (choreToDelete) onDeleteChore(choreToDelete);
        }}
        confirmTestId={`routine-${routine.id}-chore-delete-confirm`}
        cancelTestId={`routine-${routine.id}-chore-delete-cancel`}
      />
    </section>
  );
}
