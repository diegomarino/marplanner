import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { weekdayDisplayOrder, type WeekdayCode } from "@/components/WeekdayPicker";
import { BriefingAutomationCard, type AutomationSettings } from "./BriefingAutomationCard";
import { MemberChip } from "@/routines/admin/MemberChip";
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
  /** Members could not be loaded: the page's error and Retry explain the empty lists. */
  membersLoadFailed?: boolean;
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

/** Below `sm` each member row stacks as a card: cells become label/value lines, the label coming
 * from the cell's `data-label` (the column header text, which is visually hidden there). */
const STACKED_CELL =
  "border-b px-2 py-2 max-sm:flex max-sm:items-center max-sm:justify-between max-sm:gap-4 max-sm:border-0 max-sm:py-1 max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]";

/** Household scope (spec D1/D8/D10): automatic generation, generate for a date, who receives it. */
export function BriefingScheduleTab(props: BriefingScheduleTabProps) {
  const t = useT();
  const household = useHouseholdSettings();
  const order = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);
  const shownDate = props.date ?? props.today;
  const results = props.results && props.results.date === shownDate ? props.results.statuses : null;
  const anyOn = props.members.some((member) => props.optIns[member.id]);
  // The date is shared with Briefings, so browsing an old briefing moves it too: say so on the
  // button and offer the way back.
  const notToday = Boolean(props.today && shownDate && shownDate !== props.today);
  const columnBriefing = t("dailyBriefing.admin.columnBriefing");
  const columnDays = t("dailyBriefing.admin.columnDays");
  const columnResult = shownDate
    ? t("dailyBriefing.admin.columnResult").replace("{date}", shownDate)
    : t("dailyBriefing.admin.columnResultNoDate");

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
              {notToday && (
                <Button
                  type="button"
                  variant="outline"
                  data-testid="daily-briefing-generate-today"
                  onClick={() => props.today && props.onDateChange(props.today)}
                >
                  {t("dailyBriefing.admin.today")}
                </Button>
              )}
              <Button
                type="button"
                data-testid="daily-briefing-generate-all"
                disabled={!props.canGenerateAll || props.generatingAll}
                onClick={props.onGenerateAll}
              >
                {props.generatingAll
                  ? t("dailyBriefing.management.generating")
                  : notToday && shownDate
                    ? t("dailyBriefing.admin.generateAllOnDate").replace("{date}", shownDate)
                    : t("dailyBriefing.admin.generateAllButton")}
              </Button>
            </div>
            {!props.membersLoadFailed && (
              <p className="text-sm text-muted-foreground">
                {anyOn
                  ? t("dailyBriefing.admin.generateAllHint")
                  : t("dailyBriefing.management.noOptedInMembers")}
              </p>
            )}
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
            !props.membersLoadFailed && (
              <p className="text-control text-muted-foreground">
                {t("dailyBriefing.management.noActiveMembers")}
              </p>
            )
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full border-collapse text-sm max-sm:block"
                data-testid="daily-briefing-members-table"
              >
                <thead className="max-sm:sr-only">
                  <tr className="text-left">
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.memberLabel")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {columnBriefing}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {columnDays}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {columnResult}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnOpen")}
                    </th>
                  </tr>
                </thead>
                <tbody className="max-sm:block">
                  {props.members.map((member) => {
                    const on = Boolean(props.optIns[member.id]);
                    const pending = props.pendingOptInIds.has(member.id);
                    const result = results?.[member.id];
                    const enabledText = pending
                      ? t("dailyBriefing.management.optInSaving")
                      : t("dailyBriefing.management.optIn");
                    return (
                      <tr
                        key={member.id}
                        data-testid={`daily-briefing-member-row-${member.id}`}
                        className="max-sm:block max-sm:border-b max-sm:py-2"
                      >
                        <th
                          scope="row"
                          className="border-b px-2 py-2 text-left font-medium max-sm:block max-sm:border-0"
                        >
                          <MemberChip member={member} className="inline-block align-middle" />
                        </th>
                        <td className={STACKED_CELL} data-label={columnBriefing}>
                          <CheckboxField
                            checked={on}
                            disabled={pending || props.optInLocked}
                            data-testid={`daily-briefing-opt-in-${member.id}`}
                            onChange={(checked) => props.onOptInChange(member.id, checked)}
                            label={enabledText}
                            labelHidden
                            aria-label={`${member.displayName}: ${enabledText}`}
                          />
                        </td>
                        <td
                          className={STACKED_CELL}
                          data-label={columnDays}
                          data-testid={`daily-briefing-member-days-${member.id}`}
                        >
                          {on && props.schedules
                            ? scheduleSummary(props.schedules[member.id], order, t)
                            : "—"}
                        </td>
                        <td
                          className={STACKED_CELL}
                          data-label={columnResult}
                          data-testid={`daily-briefing-member-status-${member.id}`}
                        >
                          {result ? t(RESULT_KEYS[result]) : "—"}
                        </td>
                        <td className="border-b px-2 py-2 max-sm:block max-sm:border-0">
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
