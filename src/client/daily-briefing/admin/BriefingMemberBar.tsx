import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { MemberPills } from "@/components/MemberPills";
import type { MemberDTO } from "../../../shared";

/** One member choice for Blocks and Briefings (spec D5) plus the opted-out gate notice (D9). */
export function BriefingMemberBar({
  members,
  optIns,
  selectedId,
  onSelect,
  turnOnPending,
  onTurnOn,
}: {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  selectedId: string;
  onSelect: (memberId: string) => void;
  turnOnPending: boolean;
  onTurnOn: (memberId: string) => void;
}) {
  const t = useT();
  const selected = members.find((member) => member.id === selectedId);
  const off = t("dailyBriefing.admin.offMarker");
  return (
    <div className="flex flex-col gap-4">
      <MemberPills
        mode="single"
        members={members.map((member) => ({
          ...member,
          inactiveLabel: optIns[member.id] ? undefined : off,
        }))}
        value={selectedId || null}
        onChange={onSelect}
        groupLabel={t("dailyBriefing.admin.memberLabel")}
        testIdPrefix="daily-briefing-member-pill"
      />
      {selected && !optIns[selected.id] && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted px-4 py-3 text-control"
          data-testid="daily-briefing-opted-out"
        >
          <p>{t("dailyBriefing.admin.optedOutNotice").replace("{name}", selected.displayName)}</p>
          <Button
            type="button"
            data-testid="daily-briefing-turn-on"
            disabled={turnOnPending}
            onClick={() => onTurnOn(selected.id)}
          >
            {t("dailyBriefing.admin.turnOn")}
          </Button>
        </div>
      )}
    </div>
  );
}
