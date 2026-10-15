import { useEffect, useState } from "react";
import type { DayPeriodDTO, Routine, RoutineInput } from "../../../shared";
import { useT } from "@/i18n";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface RoutineFormDialogProps {
  open: boolean;
  /** The routine being edited; null creates a new one. */
  routine: Routine | null;
  dayPeriods: DayPeriodDTO[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: RoutineInput) => void;
}

export function RoutineFormDialog({
  open,
  routine,
  dayPeriods,
  saving,
  error,
  onClose,
  onSubmit,
}: RoutineFormDialogProps) {
  const t = useT();
  const ordered = [...dayPeriods].sort((a, b) => a.start.localeCompare(b.start));
  const firstPeriodId = ordered[0]?.id ?? "";
  const [name, setName] = useState("");
  const [dayPeriodId, setDayPeriodId] = useState("");
  const [confirmMove, setConfirmMove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(routine?.name ?? "");
    setDayPeriodId(routine?.dayPeriodId ?? firstPeriodId);
    setConfirmMove(false);
  }, [open, routine, firstPeriodId]);

  const input: RoutineInput = { name: name.trim(), dayPeriodId };
  const valid = input.name.length > 0 && dayPeriodId !== "";

  function submit() {
    if (!valid || saving) return;
    // Moving a routine changes the live streak (FR-009/FR-015): confirm first.
    if (routine && dayPeriodId !== routine.dayPeriodId) setConfirmMove(true);
    else onSubmit(input);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !saving) onClose();
        }}
      >
        <DialogContent closeLabel={t("routines.action.cancel")} data-testid="routine-form-dialog">
          <DialogHeader>
            <DialogTitle>
              {routine ? t("routines.admin.editRoutine") : t("routines.admin.new")}
            </DialogTitle>
            <DialogDescription>{t("routines.admin.routineFormDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-form-name">{t("routines.admin.nameLabel")}</Label>
              <Input
                id="routine-form-name"
                data-testid="routine-form-name"
                value={name}
                placeholder={t("routines.management.createNamePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-form-period">{t("routines.admin.dayPeriodLabel")}</Label>
              <Select value={dayPeriodId} onValueChange={setDayPeriodId}>
                <SelectTrigger
                  id="routine-form-period"
                  aria-label={t("routines.admin.dayPeriodLabel")}
                  data-testid="routine-form-period"
                >
                  <SelectValue placeholder={t("routines.management.selectDayPeriod")} />
                </SelectTrigger>
                <SelectContent>
                  {ordered.map((period) => (
                    <SelectItem key={period.id} value={period.id}>
                      {t(DAY_PERIOD_LABEL_KEYS[period.id])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ErrorNotice message={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {t("routines.action.cancel")}
              </Button>
              <Button type="submit" disabled={saving || !valid} data-testid="routine-form-submit">
                {routine ? t("routines.admin.saveChanges") : t("routines.action.create")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmMove}
        onOpenChange={setConfirmMove}
        title={t("routines.admin.movePeriodTitle")}
        description={t("routines.action.streakWarning")}
        confirmLabel={t("routines.admin.movePeriodConfirm")}
        cancelLabel={t("routines.action.cancel")}
        destructive={false}
        onConfirm={() => onSubmit(input)}
        confirmTestId="routine-period-confirm"
        cancelTestId="routine-period-cancel"
      />
    </>
  );
}
