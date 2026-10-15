import { MemberPills } from "@/components/MemberPills";
import type { MemberDTO } from "../../../shared";

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

/** The briefing's member choice, drawn with the shared single-select `MemberPills`. */
export function BriefingMemberPills({
  members,
  selectedId,
  onSelect,
  testIdPrefix,
  label,
}: BriefingMemberPillsProps) {
  return (
    <MemberPills
      mode="single"
      members={members}
      value={selectedId}
      onChange={onSelect}
      testIdPrefix={testIdPrefix}
      groupLabel={label}
    />
  );
}
