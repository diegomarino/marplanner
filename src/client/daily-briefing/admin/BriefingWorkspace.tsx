import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { appUrl } from "@/lib/base-path";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNotice } from "@/components/ErrorNotice";
import { usePrintingPluginActive } from "@/printing/pluginStatus";
import { BriefingImage } from "./BriefingImage";
import { BriefingMemberPills } from "./BriefingMemberPills";
import type {
  Briefing,
  BriefingHistoryResponse,
  BriefingPrintResponse,
  BriefingReadResult,
  BriefingStatus,
  GenerateSkippedResponse,
  MemberDTO,
} from "../../../shared";

const STATUS_BADGE_CLASS: Record<BriefingStatus, string> = {
  ready: "bg-success/15 text-success",
  partial: "bg-muted text-muted-foreground",
  pending: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
  "render-failed": "bg-destructive/10 text-destructive",
};

export interface BriefingWorkspaceProps {
  /** Pill members (children + opted-in adults), already filtered by the page. */
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  /** The Preview / Generate tab is visible — nothing is fetched while hidden (spec D16). */
  active: boolean;
  /** Generate all is running or an opt-in write is pending. */
  blocked: boolean;
  onGenerated: (briefing: Briefing) => void;
  onBusyChange: (busy: boolean) => void;
}

type Notice = { testId: string; text: string };

/** Reference `BriefingHistory` port: member pills, history, regenerate/view/print, payload, image. */
export function BriefingWorkspace({
  members,
  optIns,
  active,
  blocked,
  onGenerated,
  onBusyChange,
}: BriefingWorkspaceProps) {
  const t = useT();
  const printingActive = usePrintingPluginActive();
  const [memberId, setMemberId] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState("");
  const [history, setHistory] = useState<BriefingHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [read, setRead] = useState<BriefingReadResult | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const currentMember = useRef("");
  currentMember.current = memberId;

  useEffect(() => {
    if (members.some((member) => member.id === memberId)) return;
    selectMember(members[0]?.id ?? "");
  }, [members]);

  const activeDate = selectedDate ?? history?.today ?? null;

  async function loadHistory(forMember: string) {
    setHistoryError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/history/${forMember}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("history");
      const data = (await response.json()) as BriefingHistoryResponse;
      if (currentMember.current === forMember) setHistory(data);
    } catch {
      if (currentMember.current === forMember) {
        setHistoryError(t("dailyBriefing.admin.historyLoadError"));
      }
    }
  }

  async function loadRead(forMember: string, date: string) {
    setReadError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/${forMember}/${date}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("read");
      const data = (await response.json()) as BriefingReadResult;
      if (currentMember.current === forMember) setRead(data);
    } catch {
      if (currentMember.current === forMember)
        setReadError(t("dailyBriefing.admin.briefingLoadError"));
    }
  }

  useEffect(() => {
    if (active && memberId) void loadHistory(memberId);
  }, [active, memberId]);

  useEffect(() => {
    if (active && memberId && activeDate) void loadRead(memberId, activeDate);
  }, [active, memberId, activeDate, version]);

  function selectMember(id: string) {
    // Re-selecting the current member keeps its state: the load effects key on `memberId` and
    // would not refetch what this function clears.
    if (id === currentMember.current) return;
    setMemberId(id);
    setSelectedDate(null);
    setDateInput("");
    setHistory(null);
    setRead(null);
    setNotice(null);
    setActionError(null);
  }

  function selectDate(date: string) {
    setSelectedDate(date);
    setDateInput(date);
    setRead(null);
    setNotice(null);
  }

  function showTypedDate() {
    const date = dateInput || activeDate;
    if (!date) return;
    selectDate(date);
    setVersion((value) => value + 1);
  }

  const optedIn = Boolean(memberId && optIns[memberId]);
  const generated = read?.generated === true ? read.briefing : null;

  async function generate() {
    if (!optedIn || blocked || generating) return;
    const forMember = memberId;
    setGenerating(true);
    onBusyChange(true);
    setActionError(null);
    setNotice(null);
    try {
      // Spec D10: "today" lets the server resolve the household date.
      const body =
        selectedDate && selectedDate !== history?.today
          ? { memberId: forMember, date: selectedDate }
          : { memberId: forMember };
      const response = await authFetch("/api/daily-briefing/generate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.generateError"))
        );
      }
      const result = (await response.json()) as Briefing | GenerateSkippedResponse;
      if (currentMember.current !== forMember) return;
      if ("skipped" in result) {
        const name = members.find((m) => m.id === result.memberId)?.displayName ?? result.memberId;
        setNotice({
          testId: "daily-briefing-paused-notice",
          text: t("dailyBriefing.admin.pausedNotice")
            .replace("{name}", name)
            .replace("{date}", result.date)
            .replace("{blocks}", t("dailyBriefing.admin.memberBlockSettingsTitle")),
        });
        return;
      }
      if (result.date !== activeDate) selectDate(result.date);
      setVersion((value) => value + 1);
      void loadHistory(forMember);
      onGenerated(result);
    } catch (cause) {
      setActionError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.management.generateError")
      );
    } finally {
      setGenerating(false);
      onBusyChange(false);
    }
  }

  async function print() {
    if (!memberId || !activeDate || printing) return;
    setPrinting(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/daily-briefing/${memberId}/${activeDate}/print`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.printError"), {
            plugin_inactive: t("dailyBriefing.admin.printUnavailable"),
            printable_raster_missing: t("dailyBriefing.admin.printNoRaster"),
            not_found: t("dailyBriefing.admin.noBriefingForDate").replace("{date}", activeDate),
          })
        );
      }
      const result = (await response.json()) as BriefingPrintResponse;
      setNotice({
        testId: "daily-briefing-print-notice",
        text: t(
          result.enqueued
            ? "dailyBriefing.admin.printQueued"
            : "dailyBriefing.admin.printAlreadyQueued"
        ),
      });
    } catch (cause) {
      setActionError(
        cause instanceof LocalizedApiError ? cause.message : t("dailyBriefing.admin.printError")
      );
    } finally {
      setPrinting(false);
    }
  }

  if (members.length === 0) {
    return (
      <p className="text-muted-foreground text-control">{t("dailyBriefing.admin.noPillMembers")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-6 xl:flex-row" data-testid="daily-briefing-workspace">
      <div className="flex w-full flex-col gap-4 xl:w-64 xl:shrink-0">
        <BriefingMemberPills
          members={members}
          selectedId={memberId}
          onSelect={selectMember}
          testIdPrefix="daily-briefing-preview-member"
          label={t("dailyBriefing.management.selectMember")}
        />
        <label className="sr-only">
          {t("dailyBriefing.management.selectMember")}
          <select
            value={memberId}
            data-testid="daily-briefing-member-select"
            onChange={(event) => selectMember(event.target.value)}
            className={NATIVE_SELECT_CLASSES}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>

        <section className="flex flex-col gap-2">
          <h4 className="font-semibold">{t("dailyBriefing.admin.historyTitle")}</h4>
          {historyError ? (
            <div className="flex flex-col items-start gap-2">
              <ErrorNotice message={historyError} data-testid="daily-briefing-history-error" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="daily-briefing-history-retry"
                onClick={() => void loadHistory(memberId)}
              >
                {t("dailyBriefing.admin.retry")}
              </Button>
            </div>
          ) : history && history.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="daily-briefing-history-empty">
              {t("dailyBriefing.admin.historyEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="daily-briefing-history-list">
              {history?.entries.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant={entry.date === activeDate ? "secondary" : "ghost"}
                    aria-pressed={entry.date === activeDate}
                    data-testid={`daily-briefing-history-entry-${entry.date}`}
                    onClick={() => selectDate(entry.date)}
                    className="w-full justify-between"
                  >
                    <span className="font-mono">{entry.date}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        STATUS_BADGE_CLASS[entry.status]
                      )}
                    >
                      {t(`dailyBriefing.status.${entry.status}`)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap items-end gap-2">
          <Label className="flex flex-col items-start gap-1">
            {t("dailyBriefing.admin.previewDateLabel")}
            <Input
              type="date"
              data-testid="daily-briefing-admin-preview-date"
              value={dateInput || activeDate || ""}
              onChange={(event) => setDateInput(event.target.value)}
              className="w-40"
            />
          </Label>
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-admin-preview-show"
            disabled={!memberId || !(dateInput || activeDate)}
            onClick={showTypedDate}
          >
            {t("dailyBriefing.admin.previewShowButton")}
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-testid="daily-briefing-generate"
            disabled={!optedIn || blocked || generating}
            onClick={() => void generate()}
          >
            {generating
              ? t("dailyBriefing.management.generating")
              : generated
                ? t("dailyBriefing.admin.regenerate")
                : t("dailyBriefing.management.generate")}
          </Button>
          {generated && activeDate ? (
            <Button asChild variant="outline">
              <a
                data-testid="daily-briefing-view-png"
                href={appUrl(`/api/daily-briefing/${memberId}/${activeDate}/preview.png`)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("dailyBriefing.admin.viewPng")}
              </a>
            </Button>
          ) : (
            <Button type="button" variant="outline" disabled data-testid="daily-briefing-view-png">
              {t("dailyBriefing.admin.viewPng")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-print"
            disabled={!printingActive || !generated || printing}
            onClick={() => void print()}
          >
            {printing ? t("dailyBriefing.admin.printing") : t("dailyBriefing.admin.print")}
          </Button>
        </div>
        {memberId && !optedIn && (
          <p className="text-sm text-muted-foreground" data-testid="daily-briefing-needs-opt-in">
            {t("dailyBriefing.admin.needsOptIn")}
          </p>
        )}
        {!printingActive && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="daily-briefing-print-unavailable"
          >
            {t("dailyBriefing.admin.printUnavailable")}
          </p>
        )}
        {notice && (
          <p role="status" aria-live="polite" data-testid={notice.testId} className="text-control">
            {notice.text}
          </p>
        )}
        <ErrorNotice message={actionError} data-testid="daily-briefing-action-error" />

        <div className="flex min-w-0 flex-col gap-4 xl:flex-row">
          <div className="min-w-0 flex-1">
            {readError ? (
              <div className="flex flex-col items-start gap-2">
                <ErrorNotice message={readError} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="daily-briefing-read-retry"
                  onClick={() => activeDate && void loadRead(memberId, activeDate)}
                >
                  {t("dailyBriefing.admin.retry")}
                </Button>
              </div>
            ) : generated ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm" data-testid="daily-briefing-status" aria-live="polite">
                  {t("dailyBriefing.management.status")}:{" "}
                  {t(`dailyBriefing.status.${generated.status}`)}
                </p>
                <h4 className="font-semibold">{t("dailyBriefing.admin.payloadTitle")}</h4>
                <pre
                  data-testid="daily-briefing-generated-payload"
                  className="max-h-96 overflow-auto rounded-lg border bg-muted p-4 text-xs whitespace-pre-wrap break-all"
                >
                  {JSON.stringify(generated.payload, null, 2)}
                </pre>
              </div>
            ) : read && activeDate ? (
              <p className="text-sm text-muted-foreground" data-testid="daily-briefing-no-briefing">
                {t("dailyBriefing.admin.noBriefingForDate").replace("{date}", activeDate)}
              </p>
            ) : null}
          </div>
          {active && memberId && activeDate && (
            <BriefingImage
              memberId={memberId}
              date={activeDate}
              version={version}
              status={generated?.status}
            />
          )}
        </div>
      </div>
    </div>
  );
}
