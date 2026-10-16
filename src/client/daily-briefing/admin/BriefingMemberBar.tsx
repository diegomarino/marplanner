import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { MemberPills } from "@/components/MemberPills";
import type { MemberDTO } from "../../../shared";

/** One member choice for Blocks and Briefings (spec D5). An opted-out member is an off pill that
 * cannot be picked (opt-in lives in the Schedule tab's members table); with nobody opted in, one
 * line points to Schedule instead. */
export function BriefingMemberBar({
  members,
  optIns,
  selectedId,
  onSelect,
  onOpenSchedule,
}: {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  selectedId: string;
  onSelect: (memberId: string) => void;
  onOpenSchedule: () => void;
}) {
  const t = useT();
  const off = t("dailyBriefing.admin.offMarker");
  const anyOn = members.some((member) => optIns[member.id]);
  return (
    <div className="flex flex-col gap-4">
      <MemberPills
        mode="single"
        members={members.map((member) => ({
          ...member,
          offLabel: optIns[member.id] ? undefined : off,
        }))}
        value={selectedId || null}
        onChange={onSelect}
        groupLabel={t("dailyBriefing.admin.memberLabel")}
        testIdPrefix="daily-briefing-member-pill"
      />
      {!anyOn && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted px-4 py-3 text-control"
          data-testid="daily-briefing-none-opted-in"
        >
          <p>{t("dailyBriefing.admin.noneOptedIn")}</p>
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-open-schedule"
            onClick={onOpenSchedule}
          >
            {t("dailyBriefing.admin.openSchedule")}
          </Button>
        </div>
      )}
    </div>
  );
}
