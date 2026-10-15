import { useState } from "react";
import type { Assignment, Member, Weekday } from "../../../shared";
import { useT } from "@/i18n";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { WeekdayPicker } from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemberChip } from "./MemberChip";
import { weekdayLabels } from "./RoutineWeekGrid";

export interface AssignmentDialogProps {
  open: boolean;
  /** Active children, the only members a routine can be assigned to. */
  childMembers: Member[];
  assignments: Assignment[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (memberId: string, weekdays: Weekday[]) => void;
  onDeactivate: (memberId: string) => void;
}

export function AssignmentDialog({
  open,
  childMembers,
  assignments,
  busy,
  error,
  onClose,
  onSave,
  onDeactivate,
}: AssignmentDialogProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
        closeLabel={t("routines.action.cancel")}
        data-testid="assignment-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("routines.admin.assignTitle")}</DialogTitle>
          <DialogDescription>{t("routines.admin.assignDescription")}</DialogDescription>
        </DialogHeader>
        <ErrorNotice message={error} />
        {childMembers.length === 0 ? (
          <p className="text-muted-foreground text-control">{t("routines.admin.noChildren")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {childMembers.map((child) => {
              const assignment = assignments.find((a) => a.memberId === child.id);
              return (
                <AssignmentRow
                  // Remount when the saved state changes so the draft starts from it again.
                  key={`${child.id}:${assignment?.active ? assignment.weekdays.join(",") : "-"}`}
                  child={child}
                  assignment={assignment}
                  busy={busy}
                  onSave={(weekdays) => onSave(child.id, weekdays)}
                  onDeactivate={() => onDeactivate(child.id)}
                />
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignmentRow({
  child,
  assignment,
  busy,
  onSave,
  onDeactivate,
}: {
  child: Member;
  assignment: Assignment | undefined;
  busy: boolean;
  onSave: (weekdays: Weekday[]) => void;
  onDeactivate: () => void;
}) {
  const t = useT();
  const saved: Weekday[] = assignment?.active ? assignment.weekdays : [];
  const [weekdays, setWeekdays] = useState<Weekday[]>(saved);
  const [confirm, setConfirm] = useState<"save" | "deactivate" | null>(null);
  const unchanged = weekdays.length === saved.length && saved.every((d) => weekdays.includes(d));

  function requestSave() {
    // Any existing row (active or deactivated) carries streak history (FR-009); a brand-new
    // assignment has none, so it saves at once.
    if (assignment !== undefined) setConfirm("save");
    else onSave(weekdays);
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border p-4"
      data-testid={`routine-assignment-${child.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MemberChip member={child} className="self-start text-base" />
        {assignment !== undefined && !assignment.active && (
          <span
            className="text-muted-foreground text-sm"
            data-testid={`routine-assignment-${child.id}-inactive`}
          >
            {t("routines.assignments.statusInactive")}
          </span>
        )}
      </div>
      <WeekdayPicker
        mode="multi"
        value={weekdays}
        onChange={(next) => setWeekdays([...next])}
        labels={weekdayLabels(t)}
        groupLabel={`${t("routines.assignments.weekdaysLabel")} — ${child.displayName}`}
        testIdPrefix={`routines-weekday-${child.id}`}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={requestSave}
          disabled={busy || weekdays.length === 0 || unchanged}
          data-testid={`routines-assignment-${child.id}-save`}
        >
          {t("routines.assignments.save")}
        </Button>
        {assignment?.active && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirm("deactivate")}
            disabled={busy}
            data-testid={`routines-assignment-${child.id}-deactivate`}
          >
            {t("routines.assignments.deactivate")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm === "save"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("routines.assignments.save")}
        description={t("routines.action.streakWarning")}
        confirmLabel={t("routines.assignments.save")}
        cancelLabel={t("routines.action.cancel")}
        destructive={false}
        onConfirm={() => onSave(weekdays)}
        confirmTestId={`routines-assignment-${child.id}-save-confirm`}
        cancelTestId={`routines-assignment-${child.id}-save-cancel`}
      />
      <ConfirmDialog
        open={confirm === "deactivate"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
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
