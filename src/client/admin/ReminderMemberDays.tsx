import { MemberPills } from "@/components/MemberPills";
import { WeekdayPicker, type WeekdayLabels } from "@/components/WeekdayPicker";
import type { Member, Weekday } from "../../shared";

/** Per-member weekday selection for a "specific members" scheduled rule. Every active member gets a
 * pill in their own colour (selected = takes part) and, while selected, a compact weekday-pill row
 * beneath. The value is `Record<memberId, Weekday[]>`; a key's presence means the member takes part,
 * so deselecting drops their days. Members with no days are omitted by the caller on submit. */
export interface ReminderMemberDaysProps {
  members: readonly Member[];
  value: Record<string, Weekday[]>;
  onChange: (next: Record<string, Weekday[]>) => void;
  labels: WeekdayLabels;
  /** Localized "Weekdays"; each day row is named "<member> — <weekdaysLabel>". */
  weekdaysLabel: string;
  emptyMessage: string;
  /** Shown under a selected member that has no days yet. */
  hint: string;
  /** Overrides the household week start (tests only). */
  weekStartDay?: 0 | 1;
}

export function ReminderMemberDays({
  members,
  value,
  onChange,
  labels,
  weekdaysLabel,
  emptyMessage,
  hint,
  weekStartDay,
}: ReminderMemberDaysProps) {
  if (members.length === 0) {
    return <p className="text-muted-foreground text-control">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {members.map((member) => {
        const included = member.id in value;
        const days = value[member.id] ?? [];
        return (
          <div
            key={member.id}
            data-testid={`reminders-member-row-${member.id}`}
            className="flex flex-col gap-2"
          >
            <MemberPills
              members={[member]}
              value={included ? [member.id] : []}
              groupLabel={member.displayName}
              testIdPrefix="reminders-member"
              onChange={(next) => {
                const draft = { ...value };
                if (next.includes(member.id)) draft[member.id] = days;
                else delete draft[member.id];
                onChange(draft);
              }}
            />
            {included && (
              <WeekdayPicker
                mode="multi"
                value={days}
                onChange={(next) => onChange({ ...value, [member.id]: [...next] })}
                labels={labels}
                groupLabel={`${member.displayName} — ${weekdaysLabel}`}
                testIdPrefix={`reminders-weekday-${member.id}`}
                weekStartDay={weekStartDay}
              />
            )}
            {included && days.length === 0 && (
              <p
                data-testid={`reminders-member-hint-${member.id}`}
                className="text-muted-foreground text-sm"
              >
                {hint}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
