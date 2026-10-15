/** Printing admin panel (FR-012/FR-013/FR-018, SC-003;,
 * FR-001/FR-009).
 * A test-print trigger that exercises the FULL pipeline without any content producer
 * (FR-018), and a jobs list whose `derivedState` renders `dead-letter`/`retrying` as their
 * OWN distinct labels — never collapsed into "pending" (SC-003's own false-green warning,
 * trap-sweep: "collapsing them into pending is the false-green"). Styled with the
 * token/shadcn dialect via the shared L2 components (`AdminPanel`/`ErrorNotice`) — the same
 * header/region wiring every other admin sub-panel nested inside `AdminGate`'s menu adopts
 * (`MealsManagement.tsx`), rather than a private `Card` header this surface previously
 * hand-rolled.
 * SC-011: the two error/status labels below (the test-print trigger result and each
 * job's derived-state label) route their UNHEALTHY branch through `ErrorNotice`, which owns
 * the `role="alert"`/`aria-live` wiring — this retires the two `eslint-disable-next-line`
 * grandfathered sites this file used to carry (lines 122/158 pre-migration; see
 * `eslint.config.mjs`'s `SC011_SELECTOR` comment for the full 12-site map). The HEALTHY
 * branch (enqueued/alreadyPrinted, or a healthy job state) is plain, non-destructive text —
 * SC-011 governs error states, not every status message.
 */
import { useEffect, useState } from "react";
import { authFetch } from "@/lib/credential";
import { notifyPrintIntentEnqueued } from "@/printing/queueWakeup";
import { useT } from "@/i18n";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { usePrinterSession } from "@/printing/PrinterSession";
import type { JobsListResponse, PrintJob, TestPrintResponse } from "../../shared";
import type { MessageKey } from "@/i18n/messages";

type TriggerResult = "enqueued" | "alreadyPrinted" | "pluginInactive" | "error";

const STATE_LABEL_KEYS: Record<PrintJob["derivedState"], MessageKey> = {
  pending: "printing.management.state.pending",
  claimed: "printing.management.state.claimed",
  printed: "printing.management.state.printed",
  failed: "printing.management.state.failed",
  cancelled: "printing.management.state.cancelled",
  "dead-letter": "printing.management.state.deadLetter",
  retrying: "printing.management.state.retrying",
};

/** dead-letter/failed are the two terminal-and-bad outcomes worth flagging visually;
 * everything else (including `retrying`, which is still progressing) stays neutral. */
function isUnhealthyState(state: PrintJob["derivedState"]): boolean {
  return state === "dead-letter" || state === "failed";
}

export function PrintingManagement(): React.JSX.Element {
  const t = useT();
  const printerSession = usePrinterSession();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null);

  useEffect(() => {
    void loadJobs();
  }, []);

  async function loadJobs(): Promise<void> {
    setLoading(true);
    setListError(null);
    try {
      const res = await authFetch("/api/printing/jobs", { credentials: "include" });
      if (!res.ok) throw new Error(`jobs: ${res.status}`);
      const data = (await res.json()) as JobsListResponse;
      setJobs(data.jobs);
    } catch {
      setListError(t("printing.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function triggerTestPrint(): Promise<void> {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const res = await authFetch("/api/printing/test-print", {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 409) {
        setTriggerResult("pluginInactive");
        return;
      }
      if (!res.ok) throw new Error(`test-print: ${res.status}`);
      const data = (await res.json()) as TestPrintResponse;
      if (data.enqueued) notifyPrintIntentEnqueued();
      setTriggerResult(data.alreadyPrinted ? "alreadyPrinted" : "enqueued");
      await loadJobs();
    } catch {
      setTriggerResult("error");
    } finally {
      setTriggering(false);
    }
  }

  const triggerMessageKey: MessageKey | null =
    triggerResult === null
      ? null
      : triggerResult === "enqueued"
        ? "printing.management.trigger.enqueued"
        : triggerResult === "alreadyPrinted"
          ? "printing.management.trigger.alreadyPrinted"
          : triggerResult === "pluginInactive"
            ? "printing.management.trigger.pluginInactive"
            : "printing.management.trigger.error";

  const triggerIsUnhealthy = triggerResult === "error" || triggerResult === "pluginInactive";

  return (
    <AdminPanel
      title={t("printing.management.title")}
      description={t("printing.management.description")}
      data-testid="printing-management"
    >
      <div className="flex flex-wrap items-center gap-3">
        {printerSession?.canPair && (
          <Button
            type="button"
            variant="outline"
            data-testid="printing-management-pair"
            onClick={() => printerSession.pair()}
          >
            {t(
              printerSession.displayState === "disconnected"
                ? "printing.executor.repairButton"
                : "printing.executor.pairButton"
            )}
          </Button>
        )}
        <Button
          type="button"
          data-testid="printing-trigger-test-print"
          disabled={triggering}
          onClick={() => void triggerTestPrint()}
        >
          {triggering
            ? t("printing.management.triggering")
            : t("printing.management.triggerButton")}
        </Button>
        {triggerMessageKey &&
          (triggerIsUnhealthy ? (
            <ErrorNotice
              message={t(triggerMessageKey)}
              data-testid="printing-trigger-result"
              politeness="assertive"
            />
          ) : (
            <p data-testid="printing-trigger-result" className="text-sm text-muted-foreground">
              {t(triggerMessageKey)}
            </p>
          ))}
      </div>

      <ErrorNotice message={listError} data-testid="printing-list-error" />

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("printing.management.loading")}</p>
      ) : !listError && jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="printing-jobs-empty">
          {t("printing.management.empty")}
        </p>
      ) : listError ? null : (
        <ul className="flex flex-col gap-2" data-testid="printing-jobs-list">
          {jobs.map((job) => (
            <li
              key={job.id}
              data-testid={`printing-job-${job.id}`}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div>
                <p className="text-sm font-medium">
                  {job.recordKey} — {job.targetDate}
                </p>
                {isUnhealthyState(job.derivedState) ? (
                  <ErrorNotice
                    message={t(STATE_LABEL_KEYS[job.derivedState])}
                    data-testid={`printing-job-state-${job.id}`}
                    politeness="polite"
                    className="border-0 bg-transparent p-0 text-sm"
                  />
                ) : (
                  <p
                    data-testid={`printing-job-state-${job.id}`}
                    className="text-sm text-muted-foreground"
                  >
                    {t(STATE_LABEL_KEYS[job.derivedState])}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}
