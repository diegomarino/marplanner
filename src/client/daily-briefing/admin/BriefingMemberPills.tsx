import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MemberColorKey, MemberDTO } from "../../../shared";

/** Static class map so Tailwind sees every class and no inline style is needed
 * (the `TodayAgenda.tsx` precedent). */
const MEMBER_DOT_CLASS: Record<MemberColorKey, string> = {
  blue: "bg-member-blue-500",
  sky: "bg-member-sky-500",
  teal: "bg-member-teal-500",
  green: "bg-member-green-500",
  lime: "bg-member-lime-500",
  amber: "bg-member-amber-500",
  orange: "bg-member-orange-500",
  red: "bg-member-red-500",
  pink: "bg-member-pink-500",
  violet: "bg-member-violet-500",
};

/** Briefing members: active children, plus any adult who has the briefing turned on (spec D8). */
export function pillMembers(members: MemberDTO[], optIns: Record<string, boolean>): MemberDTO[] {
  return members.filter((member) => member.role === "child" || optIns[member.id] === true);
}

interface BriefingMemberPillsProps {
  members: MemberDTO[];
  selectedId: string;
  onSelect: (memberId: string) => void;
  /** `${testIdPrefix}-${member.id}` on each pill. */
  testIdPrefix: string;
  /** Accessible name of the pill group. */
  label: string;
}

export function BriefingMemberPills({
  members,
  selectedId,
  onSelect,
  testIdPrefix,
  label,
}: BriefingMemberPillsProps) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {members.map((member) => {
        const selected = member.id === selectedId;
        return (
          <Button
            key={member.id}
            type="button"
            role="tab"
            variant={selected ? "default" : "outline"}
            aria-selected={selected}
            data-testid={`${testIdPrefix}-${member.id}`}
            onClick={() => onSelect(member.id)}
            className="rounded-full"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 rounded-full border border-background",
                MEMBER_DOT_CLASS[member.colorKey]
              )}
            />
            {member.displayName}
          </Button>
        );
      })}
    </div>
  );
}
