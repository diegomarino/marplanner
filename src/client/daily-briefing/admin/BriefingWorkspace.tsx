import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { appUrl } from "@/lib/base-path";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNotice } from "@/components/ErrorNotice";
import { usePrintingPluginActive } from "@/printing/pluginStatus";
import type { WeekdayCode } from "@/components/WeekdayPicker";
import { BriefingImage } from "./BriefingImage";
import { weekdayOfDate } from "./briefingBlocks";
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
  /** The selected member; the page only mounts the workspace for an opted-in member (spec D9)
   * and keys it by member id, so a member change starts from a clean state. */
  member: MemberDTO;
  /** The page date (spec D6); `null` means household today. */
  date: string | null;
  /** Household today from the shell timezone, when known; else `history.today` is used. */
  today: string | null;
  onDateChange: (date: string) => void;
  /** The Briefings tab is visible — nothing is fetched while hidden. */
  active: boolean;
  /** Generate all is running or an opt-in write is pending. */
  blocked: boolean;
  /** Bumped by the page after Generate briefings, to refetch history, payload and image. */
  refreshKey: number;
  onGenerated: (briefing: Briefing) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenBlocks: () => void;
  /** The member's briefing days (pause schedule); omitted = every day. */
  briefingDays?: readonly WeekdayCode[];
}

type Notice = { testId: string; text: string };

/** Reference `BriefingHistory` port: history, regenerate/view/print, payload, image. */
export function BriefingWorkspace({
  member,
  date,
  today,
  onDateChange,
  active,
  blocked,
  refreshKey,
  onGenerated,
  onBusyChange,
  onOpenBlocks,
  briefingDays,
}: BriefingWorkspaceProps) {
  const t = useT();
  const printingActive = usePrintingPluginActive();
  const [history, setHistory] = useState<BriefingHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // The read carries the date it answers, so a previous date's result never shows under a new one.
  const [read, setRead] = useState<{ date: string; result: BriefingReadResult } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Only the latest read may land: a slower response for an earlier date is dropped.
  const latestRead = useRef(0);

  const memberId = member.id;
  const householdToday = history?.today ?? today;
  const activeDate = date ?? householdToday;
  // Spec D7: "today" (or unknown) lets the server resolve the household date.
  const isToday = date === null || date === householdToday;
  // A paused day is explained before any Generate: the server would only skip it.
  const activeWeekday = activeDate ? weekdayOfDate(activeDate) : null;
  const pausedDate = Boolean(
    briefingDays && activeWeekday && !briefingDays.includes(activeWeekday)
  );

  async function loadHistory() {
    setHistoryError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/history/${memberId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("history");
      setHistory((await response.json()) as BriefingHistoryResponse);
    } catch {
      setHistoryError(t("dailyBriefing.admin.historyLoadError"));
    }
  }

  async function loadRead(date: string) {
    const request = ++latestRead.current;
    setReadError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/${memberId}/${date}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("read");
      const data = (await response.json()) as BriefingReadResult;
      if (latestRead.current === request) setRead({ date, result: data });
    } catch {
      if (latestRead.current === request) setReadError(t("dailyBriefing.admin.briefingLoadError"));
    }
  }

  // A notice answers the last action; once the tab is left (for example to unpause a day in
  // Blocks) it may no longer be true.
  useEffect(() => {
    if (!active) setNotice(null);
  }, [active]);

  useEffect(() => {
    if (active) void loadHistory();
  }, [active, refreshKey]);

  // A new date drops the previous date's notice.
  const shownDate = useRef(activeDate);
  useEffect(() => {
    if (shownDate.current === activeDate) return;
    shownDate.current = activeDate;
    setNotice(null);
  }, [activeDate]);

  useEffect(() => {
    if (active && activeDate) void loadRead(activeDate);
  }, [active, activeDate, version, refreshKey]);

  const shownRead = read && read.date === activeDate ? read.result : null;
  const generated = shownRead?.generated === true ? shownRead.briefing : null;

  async function generate() {
    if (blocked || generating) return;
    setGenerating(true);
    onBusyChange(true);
    setActionError(null);
    setNotice(null);
    try {
      const body = isToday ? { memberId } : { memberId, date: activeDate };
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
      if ("skipped" in result) {
        setNotice({
          testId: "daily-briefing-paused-notice",
          text: t("dailyBriefing.admin.pausedNotice")
            .replace("{name}", member.displayName)
            .replace("{date}", result.date)
            .replace("{blocks}", t("dailyBriefing.admin.tabBlocks")),
        });
        return;
      }
      if (result.date !== activeDate) onDateChange(result.date);
      setVersion((value) => value + 1);
      void loadHistory();
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

  const shownNotice: Notice | null =
    notice ??
    (pausedDate && activeDate
      ? {
          testId: "daily-briefing-paused-notice",
          text: t("dailyBriefing.admin.pausedNotice")
            .replace("{name}", member.displayName)
            .replace("{date}", activeDate)
            .replace("{blocks}", t("dailyBriefing.admin.tabBlocks")),
        }
      : null);

  async function print() {
    if (!activeDate || printing) return;
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

  return (
    <div className="flex flex-col gap-6 xl:flex-row" data-testid="daily-briefing-workspace">
      {/* Below xl the actions and the briefing come first; a long history follows them. */}
      <div className="flex w-full flex-col gap-4 max-xl:order-2 xl:w-64 xl:shrink-0">
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
                onClick={() => void loadHistory()}
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
                    onClick={() => onDateChange(entry.date)}
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
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Label className="flex flex-col items-start gap-1">
            {t("dailyBriefing.admin.previewDateLabel")}
            <Input
              type="date"
              data-testid="daily-briefing-admin-preview-date"
              value={activeDate ?? ""}
              onChange={(event) => event.target.value && onDateChange(event.target.value)}
              className="w-40"
            />
          </Label>
          {householdToday && activeDate !== householdToday && (
            <Button
              type="button"
              variant="outline"
              data-testid="daily-briefing-preview-today"
              onClick={() => onDateChange(householdToday)}
            >
              {t("dailyBriefing.admin.today")}
            </Button>
          )}
          <Button
            type="button"
            data-testid="daily-briefing-generate"
            disabled={blocked || generating || pausedDate}
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
        {!printingActive && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="daily-briefing-print-unavailable"
          >
            {t("dailyBriefing.admin.printUnavailable")}
          </p>
        )}
        {shownNotice && (
          <div className="flex flex-wrap items-center gap-3">
            <p
              role="status"
              aria-live="polite"
              data-testid={shownNotice.testId}
              className="text-control"
            >
              {shownNotice.text}
            </p>
            {shownNotice.testId === "daily-briefing-paused-notice" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="daily-briefing-paused-open-blocks"
                onClick={onOpenBlocks}
              >
                {t("dailyBriefing.admin.openBlocks")}
              </Button>
            )}
          </div>
        )}
        <ErrorNotice message={actionError} data-testid="daily-briefing-action-error" />

        {readError ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorNotice message={readError} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="daily-briefing-read-retry"
              onClick={() => activeDate && void loadRead(activeDate)}
            >
              {t("dailyBriefing.admin.retry")}
            </Button>
          </div>
        ) : generated && activeDate ? (
          // The rendered image is the briefing a parent recognises; the raw payload is only for
          // troubleshooting, so it stays collapsed below it.
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm" data-testid="daily-briefing-status" aria-live="polite">
              {t("dailyBriefing.management.status")}:{" "}
              {t(`dailyBriefing.status.${generated.status}`)}
            </p>
            {active && (
              <BriefingImage
                memberId={memberId}
                date={activeDate}
                version={version + refreshKey}
                status={generated.status}
              />
            )}
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-4 py-2 text-sm font-semibold">
                {t("dailyBriefing.admin.payloadTitle")}
              </summary>
              <pre
                data-testid="daily-briefing-generated-payload"
                className="max-h-96 overflow-auto bg-muted p-4 text-xs whitespace-pre-wrap break-all"
              >
                {JSON.stringify(generated.payload, null, 2)}
              </pre>
            </details>
          </div>
        ) : shownRead && activeDate && !(history && history.entries.length === 0) ? (
          <p className="text-sm text-muted-foreground" data-testid="daily-briefing-no-briefing">
            {t("dailyBriefing.admin.noBriefingForDate").replace("{date}", activeDate)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
