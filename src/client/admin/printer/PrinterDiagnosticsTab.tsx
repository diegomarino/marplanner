/** Printer diagnostics (FR-016/SC-003): test print through the server queue, "reset today's
 * print", and the recent-prints table. Dead-letter and failed rows are announced through
 * ErrorNotice; every other status is plain text, never collapsed into "pending". */
import { useEffect, useId, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettingsContext } from "@/lib/householdSettings";
import { notifyPrintIntentEnqueued } from "@/printing/queueWakeup";
import type {
  JobsListResponse,
  Member,
  PrintJob,
  ResetTodayPrintsResponse,
  TestPrintResponse,
} from "../../../shared";

export const RECENT_PRINTS_LIMIT = 50;

const STATE_LABEL_KEYS: Record<PrintJob["derivedState"], MessageKey> = {
  pending: "printing.management.state.pending",
  claimed: "printing.management.state.claimed",
  printed: "printing.management.state.printed",
  failed: "printing.management.state.failed",
  cancelled: "printing.management.state.cancelled",
  "dead-letter": "printing.management.state.deadLetter",
  retrying: "printing.management.state.retrying",
};

/** dead-letter/failed are the two terminal-and-bad outcomes worth announcing. */
function isUnhealthyState(state: PrintJob["derivedState"]): boolean {
  return state === "dead-letter" || state === "failed";
}

/** The producer behind a record key, when it is one we name; otherwise null (show the key). */
export function printSourceKey(recordKey: string): MessageKey | null {
  if (recordKey === "test-print") return "admin.printer.source.test";
  if (recordKey.startsWith("daily-briefing:")) return "admin.printer.source.briefing";
  return null;
}

type Notice = { text: string; unhealthy: boolean; testId: string };

export function PrinterDiagnosticsTab(): React.JSX.Element {
  const { t, language } = useTranslation();
  const household = useHouseholdSettingsContext();
  const headingId = useId();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [memberNames, setMemberNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [busy, setBusy] = useState<"test" | "reset" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function loadJobs(): Promise<void> {
    setLoading(true);
    setListFailed(false);
    const membersRead = authFetch("/api/members?lifecycle=all", { credentials: "include" })
      .then(async (response) => (response.ok ? ((await response.json()) as Member[]) : []))
      .catch((): Member[] => []);
    try {
      const response = await authFetch("/api/printing/jobs", { credentials: "include" });
      if (!response.ok) throw new Error(`jobs: ${response.status}`);
      const data = (await response.json()) as JobsListResponse;
      const members = await membersRead;
      setJobs(data.jobs);
      setMemberNames(new Map(members.map((member) => [member.id, member.displayName])));
    } catch {
      setListFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadJobs();
  }, []);

  async function triggerTestPrint(): Promise<void> {
    setBusy("test");
    setNotice(null);
    try {
      const response = await authFetch("/api/printing/test-print", {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 409) {
        setNotice({
          text: t("printing.management.trigger.pluginInactive"),
          unhealthy: true,
          testId: "printing-trigger-result",
        });
        return;
      }
      if (!response.ok) throw new Error(`test-print: ${response.status}`);
      const data = (await response.json()) as TestPrintResponse;
      if (data.enqueued) notifyPrintIntentEnqueued();
      setNotice({
        text: t(
          data.alreadyPrinted
            ? "printing.management.trigger.alreadyPrinted"
            : "printing.management.trigger.enqueued"
        ),
        unhealthy: false,
        testId: "printing-trigger-result",
      });
      await loadJobs();
    } catch {
      setNotice({
        text: t("printing.management.trigger.error"),
        unhealthy: true,
        testId: "printing-trigger-result",
      });
    } finally {
      setBusy(null);
    }
  }

  async function resetToday(): Promise<void> {
    setBusy("reset");
    setNotice(null);
    try {
      const response = await authFetch("/api/printing/reset-today", {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 409) {
        setNotice({
          text: t("printing.management.trigger.pluginInactive"),
          unhealthy: true,
          testId: "printing-reset-today-result",
        });
        return;
      }
      if (!response.ok) throw new Error(`reset-today: ${response.status}`);
      const data = (await response.json()) as ResetTodayPrintsResponse;
      setNotice({
        text:
          data.resetRecords === 0
            ? t("admin.printer.reset.nothing")
            : t("admin.printer.reset.done")
                .replace("{records}", String(data.resetRecords))
                .replace("{jobs}", String(data.cancelledJobs)),
        unhealthy: false,
        testId: "printing-reset-today-result",
      });
      await loadJobs();
    } catch {
      setNotice({
        text: t("admin.printer.reset.error"),
        unhealthy: true,
        testId: "printing-reset-today-result",
      });
    } finally {
      setBusy(null);
    }
  }

  const formatter = new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    ...(household?.timezone ? { timeZone: household.timezone } : {}),
  });
  const visibleJobs = jobs.slice(0, RECENT_PRINTS_LIMIT);
  const columns: MessageKey[] = [
    "admin.printer.col.when",
    "admin.printer.col.date",
    "admin.printer.col.member",
    "admin.printer.col.source",
    "admin.printer.col.status",
    "admin.printer.col.attempts",
    "admin.printer.col.reason",
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="printer-diagnostics">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          data-testid="printing-trigger-test-print"
          disabled={busy !== null}
          onClick={() => void triggerTestPrint()}
        >
          {busy === "test"
            ? t("printing.management.triggering")
            : t("printing.management.triggerButton")}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="printing-reset-today"
          disabled={busy !== null}
          onClick={() => setConfirmOpen(true)}
        >
          {t("admin.printer.reset.button")}
        </Button>
      </div>
      {notice &&
        (notice.unhealthy ? (
          <ErrorNotice message={notice.text} data-testid={notice.testId} politeness="assertive" />
        ) : (
          <p data-testid={notice.testId} className="text-muted-foreground text-sm">
            {notice.text}
          </p>
        ))}

      <section className="flex flex-col gap-3" aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={headingId} className="text-lg font-semibold">
            {t("admin.printer.recent.title")}
          </h3>
          <Button
            type="button"
            variant="outline"
            data-testid="printing-jobs-refresh"
            disabled={loading}
            onClick={() => void loadJobs()}
          >
            {t("admin.printer.recent.refresh")}
          </Button>
        </div>
        {loading ? (
          <p className="text-muted-foreground text-sm">{t("printing.management.loading")}</p>
        ) : listFailed ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorNotice
              message={t("printing.management.loadError")}
              data-testid="printing-list-error"
            />
            <Button
              type="button"
              variant="outline"
              data-testid="printing-jobs-retry"
              onClick={() => void loadJobs()}
            >
              {t("admin.printer.retry")}
            </Button>
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="printing-jobs-empty">
            {t("printing.management.empty")}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table data-testid="printing-jobs-table" className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    {columns.map((key) => (
                      <th key={key} scope="col" className="py-2 pr-4 font-semibold">
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map((job) => {
                    const sourceKey = printSourceKey(job.recordKey);
                    const memberName = job.memberId ? memberNames.get(job.memberId) : undefined;
                    return (
                      <tr
                        key={job.id}
                        data-testid={`printing-job-${job.id}`}
                        className="border-b align-top last:border-0"
                      >
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {formatter.format(job.createdAt)}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">{job.targetDate}</td>
                        <td className="py-2 pr-4">{memberName ?? "—"}</td>
                        <td className="py-2 pr-4">{sourceKey ? t(sourceKey) : job.recordKey}</td>
                        <td className="py-2 pr-4">
                          {isUnhealthyState(job.derivedState) ? (
                            <ErrorNotice
                              message={t(STATE_LABEL_KEYS[job.derivedState])}
                              data-testid={`printing-job-state-${job.id}`}
                              politeness="polite"
                              className="border-0 bg-transparent p-0 text-sm"
                            />
                          ) : (
                            <span data-testid={`printing-job-state-${job.id}`}>
                              {t(STATE_LABEL_KEYS[job.derivedState])}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{job.attempts}</td>
                        <td className="py-2 pr-4">{job.failureReason ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {jobs.length > RECENT_PRINTS_LIMIT && (
              <p className="text-muted-foreground text-sm">{t("admin.printer.recent.limited")}</p>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("admin.printer.reset.title")}
        description={t("admin.printer.reset.description")}
        confirmLabel={t("admin.printer.reset.confirm")}
        cancelLabel={t("admin.printer.reset.cancel")}
        onConfirm={() => void resetToday()}
        destructive
        confirmTestId="printing-reset-today-confirm"
        cancelTestId="printing-reset-today-cancel"
      />
    </div>
  );
}
