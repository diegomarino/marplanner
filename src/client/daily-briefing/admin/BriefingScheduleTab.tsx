import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { weekdayDisplayOrder, type WeekdayCode } from "@/components/WeekdayPicker";
import { BriefingAutomationCard, type AutomationSettings } from "./BriefingAutomationCard";
import { MEMBER_DOT_CLASS } from "@/components/MemberPills";
import { WEEKDAY_LABEL_KEYS, type MemberResult } from "./briefingBlocks";
import type { MemberDTO } from "../../../shared";

export type BriefingTab = "schedule" | "blocks" | "preview";
export interface ScheduleResults {
  date: string | null;
  statuses: Record<string, MemberResult>;
}
export interface BriefingScheduleTabProps {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  pendingOptInIds: ReadonlySet<string>;
  optInLocked: boolean;
  onOptInChange: (memberId: string, enabled: boolean) => void;
  schedules: Record<string, WeekdayCode[]> | null;
  automation: AutomationSettings | null;
  onAutomationSaved: (next: AutomationSettings) => void;
  date: string | null;
  today: string | null;
  onDateChange: (date: string) => void;
  generatingAll: boolean;
  canGenerateAll: boolean;
  generateAllInfo: string | null;
  onGenerateAll: () => void;
  results: ScheduleResults | null;
  onOpen: (memberId: string, tab: Exclude<BriefingTab, "schedule">) => void;
  weekStartDay?: 0 | 1;
}

const RESULT_KEYS: Record<MemberResult, MessageKey> = {
  ready: "dailyBriefing.status.ready",
  partial: "dailyBriefing.status.partial",
  pending: "dailyBriefing.status.pending",
  failed: "dailyBriefing.status.failed",
  "render-failed": "dailyBriefing.status.render-failed",
  paused: "dailyBriefing.admin.resultPaused",
  notGenerated: "dailyBriefing.admin.resultNotGenerated",
};

/** "Every day" | "Paused every day" | the days in display order (spec D8). */
export function scheduleSummary(
  days: readonly WeekdayCode[] | undefined,
  order: readonly WeekdayCode[],
  t: (key: MessageKey) => string
): string {
  if (days === undefined || days.length === order.length) return t("dailyBriefing.admin.daysEvery");
  if (days.length === 0) return t("dailyBriefing.admin.daysNone");
  return order
    .filter((day) => days.includes(day))
    .map((day) => t(WEEKDAY_LABEL_KEYS[day]))
    .join(", ");
}

/** Household scope (spec D1/D8/D10): automatic generation, generate for a date, who receives it. */
export function BriefingScheduleTab(props: BriefingScheduleTabProps) {
  const t = useT();
  const household = useHouseholdSettings();
  const order = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);
  const shownDate = props.date ?? props.today;
  const results = props.results && props.results.date === shownDate ? props.results.statuses : null;
  const anyOn = props.members.some((member) => props.optIns[member.id]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {props.automation && (
          <BriefingAutomationCard stored={props.automation} onSaved={props.onAutomationSaved} />
        )}
        <Card>
          <CardHeader>
            <CardTitle>{t("dailyBriefing.admin.generateTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Label className="flex flex-col items-start gap-1">
                {t("dailyBriefing.admin.previewDateLabel")}
                <Input
                  type="date"
                  data-testid="daily-briefing-generate-date"
                  value={shownDate ?? ""}
                  onChange={(event) => event.target.value && props.onDateChange(event.target.value)}
                  className="w-44"
                />
              </Label>
              <Button
                type="button"
                data-testid="daily-briefing-generate-all"
                disabled={!props.canGenerateAll || props.generatingAll}
                onClick={props.onGenerateAll}
              >
                {props.generatingAll
                  ? t("dailyBriefing.management.generating")
                  : t("dailyBriefing.admin.generateAllButton")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {anyOn
                ? t("dailyBriefing.admin.generateAllHint")
                : t("dailyBriefing.management.noOptedInMembers")}
            </p>
            {props.generateAllInfo && (
              <p
                className="text-control text-muted-foreground"
                data-testid="daily-briefing-generate-all-info"
                role="status"
                aria-live="polite"
              >
                {props.generateAllInfo}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("dailyBriefing.admin.membersTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {props.members.length === 0 ? (
            <p className="text-control text-muted-foreground">
              {t("dailyBriefing.management.noActiveMembers")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full border-collapse text-sm"
                data-testid="daily-briefing-members-table"
              >
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.memberLabel")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnBriefing")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnDays")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {shownDate
                        ? t("dailyBriefing.admin.columnResult").replace("{date}", shownDate)
                        : t("dailyBriefing.admin.columnResultNoDate")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnOpen")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {props.members.map((member) => {
                    const on = Boolean(props.optIns[member.id]);
                    const pending = props.pendingOptInIds.has(member.id);
                    const result = results?.[member.id];
                    const enabledText = pending
                      ? t("dailyBriefing.management.optInSaving")
                      : t("dailyBriefing.management.optIn");
                    return (
                      <tr key={member.id} data-testid={`daily-briefing-member-row-${member.id}`}>
                        <th scope="row" className="border-b px-2 py-2 text-left font-medium">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={cn(
                                "size-3 rounded-full border border-background",
                                MEMBER_DOT_CLASS[member.colorKey]
                              )}
                            />
                            {member.displayName}
                          </span>
                        </th>
                        <td className="border-b px-2 py-2">
                          <CheckboxField
                            checked={on}
                            disabled={pending || props.optInLocked}
                            data-testid={`daily-briefing-opt-in-${member.id}`}
                            onChange={(checked) => props.onOptInChange(member.id, checked)}
                            label={enabledText}
                            aria-label={`${member.displayName}: ${enabledText}`}
                          />
                        </td>
                        <td
                          className="border-b px-2 py-2"
                          data-testid={`daily-briefing-member-days-${member.id}`}
                        >
                          {on && props.schedules
                            ? scheduleSummary(props.schedules[member.id], order, t)
                            : "—"}
                        </td>
                        <td
                          className="border-b px-2 py-2"
                          data-testid={`daily-briefing-member-status-${member.id}`}
                        >
                          {result ? t(RESULT_KEYS[result]) : "—"}
                        </td>
                        <td className="border-b px-2 py-2">
                          <span className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-testid={`daily-briefing-open-blocks-${member.id}`}
                              aria-label={t("dailyBriefing.admin.openBlocksAria").replace(
                                "{name}",
                                member.displayName
                              )}
                              onClick={() => props.onOpen(member.id, "blocks")}
                            >
                              {t("dailyBriefing.admin.tabBlocks")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-testid={`daily-briefing-open-briefings-${member.id}`}
                              aria-label={t("dailyBriefing.admin.openBriefingsAria").replace(
                                "{name}",
                                member.displayName
                              )}
                              onClick={() => props.onOpen(member.id, "preview")}
                            >
                              {t("dailyBriefing.admin.tabBriefings")}
                            </Button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
