import { arrayMove } from "@dnd-kit/sortable";
import type { Chore, DayPeriodDTO, Routine } from "../../../shared";

export interface RoutineGroup {
  period: DayPeriodDTO;
  routines: Routine[];
}

/** Groups routines under their day period. Periods follow their start time; routines keep the
 * order they arrived in (the server already sorts by period start, then name). Periods with no
 * routines are left out. */
export function groupRoutinesByPeriod(
  routines: readonly Routine[],
  dayPeriods: readonly DayPeriodDTO[]
): RoutineGroup[] {
  return [...dayPeriods]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((period) => ({
      period,
      routines: routines.filter((routine) => routine.dayPeriodId === period.id),
    }))
    .filter((group) => group.routines.length > 0);
}

/** Moves one chore onto another's slot and renumbers `sortOrder`. Null when nothing moves. */
export function moveChore(
  chores: readonly Chore[],
  activeId: string,
  overId: string
): Chore[] | null {
  const from = chores.findIndex((chore) => chore.id === activeId);
  const to = chores.findIndex((chore) => chore.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove([...chores], from, to).map((chore, sortOrder) => ({ ...chore, sortOrder }));
}
