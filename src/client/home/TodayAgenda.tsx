import { appUrl } from "@/lib/base-path";
import { useEffect, useId, useState } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import { memberEventStyle } from "@/calendar/member-event-style";
import type { FeedItem, Member, MemberColorKey } from "../../shared";
import { nextOccurrenceInTz } from "../../shared/householdTime";
import {
  householdDayRange,
  presentAgenda,
  type AgendaPresentationItem,
} from "./agenda-presentation";

// Literal generated-token utilities keep all sixteen identities visible to Tailwind.
const identityTokens: Record<MemberColorKey, string> = {
  blue: "bg-member-blue-500 text-member-blue-foreground",
  sky: "bg-member-sky-500 text-member-sky-foreground",
  cyan: "bg-member-cyan-500 text-member-cyan-foreground",
  teal: "bg-member-teal-500 text-member-teal-foreground",
  green: "bg-member-green-500 text-member-green-foreground",
  lime: "bg-member-lime-500 text-member-lime-foreground",
  yellow: "bg-member-yellow-500 text-member-yellow-foreground",
  amber: "bg-member-amber-500 text-member-amber-foreground",
  orange: "bg-member-orange-500 text-member-orange-foreground",
  red: "bg-member-red-500 text-member-red-foreground",
  rose: "bg-member-rose-500 text-member-rose-foreground",
  pink: "bg-member-pink-500 text-member-pink-foreground",
  fuchsia: "bg-member-fuchsia-500 text-member-fuchsia-foreground",
  purple: "bg-member-purple-500 text-member-purple-foreground",
  violet: "bg-member-violet-500 text-member-violet-foreground",
  indigo: "bg-member-indigo-500 text-member-indigo-foreground",
};
const accentTokens: Record<MemberColorKey, string> = {
  blue: "border-l-member-blue-500",
  sky: "border-l-member-sky-500",
  cyan: "border-l-member-cyan-500",
  teal: "border-l-member-teal-500",
  green: "border-l-member-green-500",
  lime: "border-l-member-lime-500",
  yellow: "border-l-member-yellow-500",
  amber: "border-l-member-amber-500",
  orange: "border-l-member-orange-500",
  red: "border-l-member-red-500",
  rose: "border-l-member-rose-500",
  pink: "border-l-member-pink-500",
  fuchsia: "border-l-member-fuchsia-500",
  purple: "border-l-member-purple-500",
  violet: "border-l-member-violet-500",
  indigo: "border-l-member-indigo-500",
};
const temporalLabels: Record<AgendaPresentationItem["temporalState"], MessageKey> = {
  past: "agenda.past",
  "in-progress": "agenda.inProgress",
  next: "agenda.next",
  future: "agenda.future",
};
type AgendaState =
  | { status: "loading" | "failed" }
  | { status: "ready"; events: FeedItem[]; members: Member[]; timezone: string; date: string };

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await authFetch(url, { signal, credentials: "include" });
  if (!response.ok) throw new Error(`agenda: ${response.status}`);
  return response.json() as Promise<T>;
}

export function TodayAgenda(): React.JSX.Element {
  const { t, language } = useTranslation();
  const {
    timezone: configuredTimezone,
    status: settingsStatus,
    retry: retrySettings,
  } = useHouseholdSettings();
  const headingId = useId();
  const [state, setState] = useState<AgendaState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    if (settingsStatus === "loading") return () => controller.abort();
    if (settingsStatus === "error" || !configuredTimezone) {
      setState({ status: "failed" });
      return () => controller.abort();
    }
    void (async () => {
      const timezone = configuredTimezone;
      const instant = Date.now();
      const range = householdDayRange(timezone, instant);
      const query = new URLSearchParams({ source: "all", from: range.from, to: range.to });
      const [events, members] = await Promise.all([
        read<FeedItem[]>(`/api/calendar/events?${query}`, controller.signal),
        read<Member[]>("/api/members?lifecycle=all", controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setNow(Date.now());
      setState({ status: "ready", events, members, timezone, date: range.date });
    })().catch(() => {
      if (!controller.signal.aborted) setState({ status: "failed" });
    });
    return () => controller.abort();
  }, [configuredTimezone, settingsStatus, attempt]);

  useEffect(() => {
    if (state.status !== "ready") return;
    // Re-project exactly at event edges; refetch only on household-day rollover.
    // Visibility recovery handles a tablet waking after a throttled timer. No polling.
    const refresh = () => {
      const instant = Date.now();
      if (householdDayRange(state.timezone, instant).date !== state.date) {
        setState({ status: "loading" });
        setAttempt((value) => value + 1);
      }
      setNow(instant);
    };
    const edges = state.events
      .filter((event) => !event.allDay)
      .flatMap((event) => [
        Date.parse(event.occurrenceStart),
        Date.parse(event.occurrenceEnd ?? ""),
      ])
      .filter((edge) => edge > now);
    const next = Math.min(nextOccurrenceInTz("00:00", state.timezone, now), ...edges);
    const delay = next - Date.now();
    if (delay <= 0 || householdDayRange(state.timezone, now).date !== state.date) {
      refresh();
      return;
    }
    const timer = setTimeout(refresh, delay);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [state, now]);

  const items =
    state.status === "ready" ? presentAgenda(state.events, state.members, state.timezone, now) : [];
  const time =
    state.status === "ready"
      ? new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
          timeZone: state.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
      : null;
  const date =
    state.status === "ready"
      ? new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-US", {
          timeZone: "UTC",
          weekday: "long",
          month: "long",
          day: "numeric",
        }).format(new Date(`${state.date}T12:00:00Z`))
      : null;

  return (
    <section
      aria-labelledby={headingId}
      className="bg-card flex h-full min-h-0 flex-col rounded-3xl border p-5 text-control shadow-sm"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b pb-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-semibold uppercase tracking-wide">
            {t("agenda.title")}
          </h2>
          {date && <p className="mt-1 text-2xl font-bold capitalize leading-tight">{date}</p>}
        </div>
        <a
          className="shrink-0 text-sm font-semibold underline-offset-4 hover:underline"
          href={appUrl("/calendar")}
        >
          {t("calendar.title")}
        </a>
      </header>
      {state.status === "loading" && (
        <p role="status" className="py-4 text-muted-foreground">
          {t("agenda.loading")}
        </p>
      )}
      {state.status === "failed" && (
        <div className="space-y-2 py-4">
          <ErrorNotice message={t("agenda.error")} />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (settingsStatus === "error" || !configuredTimezone) retrySettings();
              else setAttempt((value) => value + 1);
            }}
          >
            {t("agenda.retry")}
          </Button>
        </div>
      )}
      {state.status === "ready" &&
        (items.length === 0 ? (
          <p className="py-4 text-muted-foreground">{t("agenda.empty")}</p>
        ) : (
          <ul className="m-0 min-h-0 flex-1 list-none space-y-2 overflow-y-auto pt-4 pr-1">
            {items.map((item) => (
              <li
                key={`${item.event.id}@${item.event.occurrenceStart}`}
                className={cn(
                  "member-event-surface rounded-xl border border-l-4 p-3",
                  item.activeAssignees[0]
                    ? accentTokens[item.activeAssignees[0].colorKey]
                    : "border-l-transparent",
                  item.temporalState === "past" && "text-muted-foreground",
                  (item.temporalState === "in-progress" || item.temporalState === "next") &&
                    "font-semibold ring-1 ring-foreground"
                )}
                // eslint-disable-next-line ui-policy/debt -- Assigned-member identity is passed through CSS custom properties into the token-based event surface.
                style={memberEventStyle(item.activeAssignees.map((member) => member.colorKey))}
              >
                <div className="grid min-w-0 grid-cols-[4.25rem_minmax(0,1fr)] items-start gap-3">
                  <div data-testid="agenda-time" className="font-mono text-sm tabular-nums">
                    {item.kind === "all-day" ? (
                      t("agenda.allDay")
                    ) : (
                      <time dateTime={item.event.occurrenceStart}>
                        {time!.format(new Date(item.event.occurrenceStart))}
                      </time>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="break-words">{item.event.title}</h3>
                    {item.kind !== "all-day" && (
                      <p className="mt-1 truncate text-sm">
                        {item.event.occurrenceEnd && (
                          <>
                            –{" "}
                            <time dateTime={item.event.occurrenceEnd}>
                              {time!.format(new Date(item.event.occurrenceEnd))}
                            </time>
                            {" · "}
                          </>
                        )}
                        <span>{t(temporalLabels[item.temporalState])}</span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap gap-2">
                  {item.activeAssignees.map((member) => (
                    <span
                      key={member.memberId}
                      className={cn("rounded-md px-2 py-1", identityTokens[member.colorKey])}
                    >
                      {member.label}
                    </span>
                  ))}
                  {item.fallbackAssigneeLabels.map((label, index) => (
                    <span key={index}>{label}</span>
                  ))}
                  {item.event.assignedTo.length === 0 && <span>{t("agenda.unassigned")}</span>}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
