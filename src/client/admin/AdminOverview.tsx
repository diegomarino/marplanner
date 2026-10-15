import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, RefreshCw } from "lucide-react";

import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { clientBuildInfo } from "@/lib/build-info";
import { authFetch } from "@/lib/credential";
import { cn } from "@/lib/utils";
import type { ClientLogPage, ClientLogRow, SystemStatus } from "../../shared";

const RECENT_LOG_ROWS = 20;

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function relativeTime(iso: string, locale: string, now: number): string {
  const elapsed = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of RELATIVE_STEPS) {
    if (Math.abs(elapsed) >= ms) return format.format(Math.round(elapsed / ms), unit);
  }
  return format.format(0, "minute");
}

function StatusCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-[var(--control-height)] items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      <dl className="bg-card grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-2xl border p-4 shadow-sm">
        {children}
      </dl>
    </section>
  );
}

const UPTIME_UNITS: ["day" | "hour" | "minute", number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** Whole-second uptime as the two largest non-zero units ("2d 3h"), or seconds under a minute. */
export function formatUptime(totalSeconds: number, locale: string): string {
  const unit = (value: number, name: Intl.NumberFormatOptions["unit"]) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(
      value
    );
  let remaining = Math.max(0, Math.floor(totalSeconds));
  if (remaining < 60) return unit(remaining, "second");
  const parts: string[] = [];
  for (const [name, size] of UPTIME_UNITS) {
    const value = Math.floor(remaining / size);
    remaining -= value * size;
    if (value > 0) parts.push(unit(value, name));
  }
  return parts.slice(0, 2).join(" ");
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-control font-semibold">{label}</dt>
      <dd className="text-control min-w-0 break-words">{children}</dd>
    </>
  );
}

async function readLevel(level: "warn" | "error"): Promise<ClientLogRow[]> {
  const response = await authFetch(`/api/telemetry/client-log?level=${level}`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`client-log: ${response.status}`);
  const page = (await response.json()) as Partial<ClientLogPage> | null;
  return Array.isArray(page?.rows) ? page.rows : [];
}

/** The admin landing page: what is deployed, what this device runs, and what recently went
 * wrong.
 */
export function AdminOverview({ onOpenTelemetry }: { onOpenTelemetry: () => void }) {
  const { t, language } = useTranslation();
  const locale = language === "es" ? "es-ES" : "en-GB";
  const device = clientBuildInfo();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [logs, setLogs] = useState<ClientLogRow[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setStatusError(null);
    try {
      const response = await authFetch("/api/telemetry/system-status", { credentials: "include" });
      if (!response.ok) throw new Error(`system-status: ${response.status}`);
      const body = (await response.json()) as Partial<SystemStatus> | null;
      if (!body || typeof body.build !== "object" || body.build === null) {
        throw new Error("system-status: unexpected body");
      }
      setStatus(body as SystemStatus);
    } catch {
      setStatus(null);
      setStatusError(t("admin.overview.statusError"));
    } finally {
      setChecking(false);
    }
    try {
      const [warnings, errors] = await Promise.all([readLevel("warn"), readLevel("error")]);
      setLogs(
        [...warnings, ...errors]
          .sort((a, b) => b.receivedAt - a.receivedAt)
          .slice(0, RECENT_LOG_ROWS)
      );
      setLogsError(null);
    } catch {
      setLogsError(t("admin.overview.logs.loadError"));
    }
  }, [t]);

  useEffect(() => {
    void check();
  }, [check]);

  const now = Date.now();
  const unknown = t("admin.overview.unknown");
  const built = (iso: string | null | undefined): string =>
    iso ? relativeTime(iso, locale, now) : t("admin.overview.notBuilt");
  const serverSha = status?.build.sha ?? null;
  const sameBuild = device?.sha && serverSha ? device.sha === serverSha : null;

  return (
    <div className="flex flex-col gap-6" data-testid="admin-overview">
      <h1 className="font-display text-2xl font-bold">{t("admin.overview.title")}</h1>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <StatusCard title={t("admin.overview.system")}>
            <StatusRow label={t("admin.overview.status")}>
              {status ? status.status : statusError ? t("admin.overview.unreachable") : "…"}
            </StatusRow>
            <StatusRow label={t("admin.overview.lastCheck")}>
              {status
                ? new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  }).format(new Date(status.checkedAt))
                : "—"}
            </StatusRow>
            <StatusRow label={t("admin.overview.uptime")}>
              <span data-testid="admin-overview-uptime">
                {status
                  ? typeof status.uptimeSeconds === "number"
                    ? formatUptime(status.uptimeSeconds, locale)
                    : "—"
                  : "—"}
              </span>
            </StatusRow>
            <StatusRow label={t("admin.overview.deploy")}>
              <span className="font-mono">{serverSha ?? unknown}</span>
              {status?.build.subject && (
                <span className="text-muted-foreground"> {status.build.subject}</span>
              )}
            </StatusRow>
            <StatusRow label={t("admin.overview.built")}>
              {status ? built(status.build.builtAt) : "—"}
            </StatusRow>
          </StatusCard>
          <ErrorNotice message={statusError} />

          <StatusCard
            title={t("admin.overview.device")}
            action={
              <Button
                type="button"
                size="sm"
                data-testid="admin-overview-check"
                disabled={checking}
                onClick={() => void check()}
              >
                <RefreshCw aria-hidden="true" />
                {t("admin.overview.checkNow")}
              </Button>
            }
          >
            <StatusRow label={t("admin.overview.bundle")}>
              <span className="font-mono">{device?.sha ?? unknown}</span>
              {sameBuild !== null && (
                <span
                  data-testid="admin-overview-build-match"
                  aria-live="polite"
                  className={cn(
                    "ml-2 inline-flex items-center gap-1",
                    sameBuild ? "text-success" : "text-destructive"
                  )}
                >
                  {sameBuild && <Check aria-hidden="true" className="size-4" />}
                  {sameBuild ? t("admin.overview.matches") : t("admin.overview.differs")}
                </span>
              )}
            </StatusRow>
            <StatusRow label={t("admin.overview.bundleBuilt")}>{built(device?.builtAt)}</StatusRow>
          </StatusCard>
        </div>

        <section className="flex min-w-0 flex-col gap-2" aria-labelledby="admin-overview-logs">
          <div className="flex min-h-[var(--control-height)] items-center justify-between gap-2">
            <h2 id="admin-overview-logs" className="text-lg font-semibold">
              {t("admin.overview.logs.title")}
            </h2>
            <Button type="button" variant="outline" size="sm" onClick={onOpenTelemetry}>
              {t("admin.overview.logs.open")}
            </Button>
          </div>
          <ErrorNotice message={logsError} />
          <div className="bg-card rounded-2xl border shadow-sm">
            {logs === null ? (
              !logsError && <p className="text-muted-foreground p-4">…</p>
            ) : logs.length === 0 ? (
              <p className="text-muted-foreground p-4">{t("admin.overview.logs.empty")}</p>
            ) : (
              <ul
                className="divide-border m-0 list-none divide-y p-0"
                data-testid="admin-overview-logs"
              >
                {logs.map((row) => (
                  <li key={row.id} className="flex flex-col gap-1 px-4 py-3">
                    <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 font-semibold uppercase",
                          row.level === "error"
                            ? "bg-destructive text-primary-foreground"
                            : "bg-accent/25 text-accent-foreground"
                        )}
                      >
                        {row.level}
                      </span>
                      <span className="font-mono">{row.component}</span>
                      <time dateTime={new Date(row.receivedAt).toISOString()}>
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(row.receivedAt))}
                      </time>
                    </div>
                    <p className="text-control break-words">{row.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
