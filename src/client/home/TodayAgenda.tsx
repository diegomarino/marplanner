import { appUrl } from "@/lib/base-path";
import { ChevronRight } from "lucide-react";
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
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

// Literal generated-token utilities keep every identity colour visible to Tailwind.
const accentTokens: Record<MemberColorKey, string> = {
  blue: "border-l-member-blue-500",
  sky: "border-l-member-sky-500",
  teal: "border-l-member-teal-500",
  green: "border-l-member-green-500",
  lime: "border-l-member-lime-500",
  amber: "border-l-member-amber-500",
  orange: "border-l-member-orange-500",
  red: "border-l-member-red-500",
  pink: "border-l-member-pink-500",
  violet: "border-l-member-violet-500",
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

/** One labelled agenda group: a small caption, a dotted rule and its own list. */
function AgendaGroup({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3
          id={labelId}
          className="text-muted-foreground text-xs font-bold tracking-widest whitespace-nowrap uppercase"
        >
          {label}
        </h3>
        <div aria-hidden="true" className="flex-1 border-b border-dotted" />
      </div>
      <ul aria-labelledby={labelId} className="m-0 list-none space-y-2">
        {children}
      </ul>
    </section>
  );
}

export function TodayAgenda(): React.JSX.Element {
  const { t, language } = useTranslation();
  const {
    timezone: configuredTimezone,
    status: settingsStatus,
    retry: retrySettings,
  } = useHouseholdSettings();
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
    state.status === "ready"
      ? presentAgenda(state.events, state.members, state.timezone, now, language)
      : [];
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
          month: "short",
          day: "numeric",
        }).format(new Date(`${state.date}T12:00:00Z`))
      : null;

  const allDayItems = items.filter((item) => item.kind === "all-day");
  const timedItems = items.filter((item) => item.kind === "timed");

  const renderItem = (item: AgendaPresentationItem) => {
    const accent = item.activeAssignees[0]?.colorKey;
    // Status and assignment are not drawn; they stay in the row for assistive technology.
    const details = [
      ...(item.kind === "timed" ? [t(temporalLabels[item.temporalState])] : []),
      ...item.activeAssignees.map((member) => member.label),
      ...item.fallbackAssigneeLabels,
      ...(item.event.assignedTo.length === 0 ? [t("agenda.unassigned")] : []),
    ];
    return (
      <li
        key={`${item.event.id}@${item.event.occurrenceStart}`}
        className={cn(
          // `relative` keeps the visually hidden details inside the row, so rows scrolled out
          // of the list do not extend the page.
          "relative rounded-md border-l-4 px-3 py-2",
          // Member identity wins; only an all-day event nobody owns takes the all-day surface.
          item.kind === "all-day" && !accent
            ? "bg-event-all-day border-l-event-all-day-border"
            : "member-event-surface",
          accent ? accentTokens[accent] : item.kind === "timed" && "border-l-transparent",
          item.temporalState === "past" && "text-muted-foreground",
          (item.temporalState === "in-progress" || item.temporalState === "next") &&
            "font-semibold ring-1 ring-foreground"
        )}
        // eslint-disable-next-line ui-policy/debt -- Assigned-member identity is passed through CSS custom properties into the token-based event surface.
        style={memberEventStyle(item.activeAssignees.map((member) => member.colorKey))}
      >
        <div className="flex min-w-0 gap-3">
          {item.kind === "timed" && (
            <div
              data-testid="agenda-time"
              className="flex shrink-0 flex-col items-center pt-0.5 font-mono text-xs leading-tight font-semibold tabular-nums"
            >
              <time dateTime={item.event.occurrenceStart}>
                {time!.format(new Date(item.event.occurrenceStart))}
              </time>
              {item.event.occurrenceEnd && (
                <time dateTime={item.event.occurrenceEnd} className="text-muted-foreground">
                  {time!.format(new Date(item.event.occurrenceEnd))}
                </time>
              )}
            </div>
          )}
          <h4 className="min-w-0 font-bold break-words">
            {item.event.decoratedTitle ?? item.event.title}
          </h4>
        </div>
        <p className="sr-only" data-testid="agenda-details">
          {details.map((detail, index) => (
            <Fragment key={index}>
              {index > 0 && ", "}
              <span>{detail}</span>
            </Fragment>
          ))}
        </p>
      </li>
    );
  };

  return (
    <section
      aria-label={t("agenda.title")}
      className="bg-card flex h-full min-h-0 flex-col rounded-3xl border p-5 text-control shadow-sm"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b pb-4">
        {date && (
          <h2 className="font-display min-w-0 text-xl leading-tight font-bold capitalize">
            {date}
          </h2>
        )}
        <a
          className="ml-auto inline-flex shrink-0 items-center text-sm font-semibold underline-offset-4 hover:underline"
          href={appUrl("/calendar")}
        >
          {t("agenda.viewAll")}
          <ChevronRight aria-hidden="true" className="size-4" />
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
          <div
            data-testid="agenda-groups"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4 pr-1"
          >
            {allDayItems.length > 0 && (
              <AgendaGroup label={t("agenda.allDay")}>{allDayItems.map(renderItem)}</AgendaGroup>
            )}
            {timedItems.length > 0 && (
              <AgendaGroup label={t("agenda.scheduled")}>{timedItems.map(renderItem)}</AgendaGroup>
            )}
          </div>
        ))}
    </section>
  );
}
