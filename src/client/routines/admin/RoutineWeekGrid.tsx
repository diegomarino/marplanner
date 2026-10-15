import type { Assignment, Member, Weekday } from "../../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { weekdayDisplayOrder, type WeekdayLabels } from "@/components/WeekdayPicker";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { MemberChip } from "./MemberChip";

export const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "routines.assignments.weekday.mon",
  tue: "routines.assignments.weekday.tue",
  wed: "routines.assignments.weekday.wed",
  thu: "routines.assignments.weekday.thu",
  fri: "routines.assignments.weekday.fri",
  sat: "routines.assignments.weekday.sat",
  sun: "routines.assignments.weekday.sun",
};

/** `WeekdayPicker` labels from this surface's own `routines.assignments.weekday.*` keys. */
export function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
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

/** Seven columns of the children actively assigned on each weekday. The whole grid opens the
 * assignment dialog, where the same information is editable. */
export function RoutineWeekGrid({
  assignments,
  members,
  onOpen,
}: {
  assignments: Assignment[];
  members: Member[];
  onOpen: () => void;
}) {
  const t = useT();
  const { weekStartDay } = useHouseholdSettings();
  const byId = new Map(members.map((member) => [member.id, member]));
  const active = assignments.filter((assignment) => assignment.active);

  return (
    <Button
      type="button"
      variant="ghost"
      wrap
      className="w-full rounded-2xl border p-2"
      aria-label={t("routines.admin.manageAssignments")}
      data-testid="routine-week-grid"
      onClick={onOpen}
    >
      <span className="grid w-full grid-cols-7 gap-1">
        {weekdayDisplayOrder(weekStartDay).map((day) => (
          <span
            key={day}
            className="flex min-w-0 flex-col items-center gap-1"
            data-testid={`routine-week-day-${day}`}
          >
            <span className="text-muted-foreground text-sm font-bold uppercase">
              {t(WEEKDAY_LABEL_KEYS[day])}
            </span>
            {active
              .filter((assignment) => assignment.weekdays.includes(day))
              .map((assignment) => byId.get(assignment.memberId))
              .filter((member): member is Member => member !== undefined)
              .map((member) => (
                <MemberChip key={member.id} member={member} className="w-full text-center" />
              ))}
          </span>
        ))}
      </span>
    </Button>
  );
}
