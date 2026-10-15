import { Plus } from "lucide-react";
import type { DayPeriodDTO, Routine } from "../../../shared";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { groupRoutinesByPeriod } from "./routineOrder";

export interface RoutineListProps {
  routines: Routine[];
  dayPeriods: DayPeriodDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

/** Master list: routines grouped by day period, in period start order. */
export function RoutineList({
  routines,
  dayPeriods,
  selectedId,
  onSelect,
  onNew,
}: RoutineListProps) {
  const t = useT();
  const groups = groupRoutinesByPeriod(routines, dayPeriods);

  return (
    <nav
      aria-labelledby="routine-list-heading"
      className="bg-card flex min-w-0 flex-col gap-4 rounded-3xl border p-4 shadow-sm"
      data-testid="routine-list"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="routine-list-heading" className="text-lg font-semibold">
          {t("routines.management.routines")}
        </h3>
        <Button size="sm" onClick={onNew} data-testid="routines-new">
          <Plus aria-hidden="true" />
          {t("routines.admin.new")}
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-control" data-testid="routines-empty">
          {t("routines.management.noRoutines")}
        </p>
      ) : (
        groups.map(({ period, routines: items }) => (
          <section
            key={period.id}
            aria-labelledby={`routine-group-${period.id}`}
            className="flex flex-col gap-1"
          >
            <h4
              id={`routine-group-${period.id}`}
              className="text-muted-foreground text-sm font-semibold uppercase tracking-wide"
            >
              {t(DAY_PERIOD_LABEL_KEYS[period.id])}
            </h4>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {items.map((routine) => {
                const selected = routine.id === selectedId;
                return (
                  <li key={routine.id}>
                    <Button
                      type="button"
                      variant={selected ? "default" : "ghost"}
                      wrap
                      aria-current={selected ? "true" : undefined}
                      className="w-full justify-start"
                      data-testid={`routine-list-item-${routine.id}`}
                      onClick={() => onSelect(routine.id)}
                    >
                      {routine.name}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </nav>
  );
}
