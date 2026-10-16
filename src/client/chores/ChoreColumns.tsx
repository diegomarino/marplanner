import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronUp, Flame, Loader2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { StatusToggle } from "@/components/StatusToggle";
import { Button } from "@/components/ui/button";
import { NotoEmoji } from "./noto-emoji";
import { useTodayChores } from "@/chores/useTodayChores";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { authFetch } from "@/lib/credential";
import { cn } from "@/lib/utils";
import {
  MEMBER_COLOR_KEYS,
  type BoardChore,
  type BoardColumn,
  type DayPeriodDTO,
  type MemberColorKey,
  type PeriodId,
} from "../../shared";
import { resolveActivePeriod } from "../../shared/dayPeriods";

const DAY_PERIOD_LABEL_KEYS: Record<PeriodId, MessageKey> = {
  morning: "dayPeriod.morning",
  afternoon: "dayPeriod.afternoon",
  evening: "dayPeriod.evening",
  night: "dayPeriod.night",
};

type MemberColorProfile = { id: string; colorKey: MemberColorKey };
type MemberScale = {
  column: string;
  badge: string;
  period: string;
  card: string;
  completeCard: string;
  progress: string;
};

const MEMBER_SCALES: Record<MemberColorKey, MemberScale> = {
  blue: {
    column: "bg-member-blue-100 border-member-blue-200",
    badge: "bg-member-blue-500 text-member-avatar-foreground",
    period: "bg-member-blue-200 border-member-blue-300",
    card: "border-member-blue-200 bg-member-blue-100",
    completeCard: "border-member-blue-500 bg-member-blue-300 text-member-blue-foreground",
    progress: "bg-member-blue-500",
  },
  sky: {
    column: "bg-member-sky-100 border-member-sky-200",
    badge: "bg-member-sky-500 text-member-avatar-foreground",
    period: "bg-member-sky-200 border-member-sky-300",
    card: "border-member-sky-200 bg-member-sky-100",
    completeCard: "border-member-sky-500 bg-member-sky-300 text-member-sky-foreground",
    progress: "bg-member-sky-500",
  },
  teal: {
    column: "bg-member-teal-100 border-member-teal-200",
    badge: "bg-member-teal-500 text-member-avatar-foreground",
    period: "bg-member-teal-200 border-member-teal-300",
    card: "border-member-teal-200 bg-member-teal-100",
    completeCard: "border-member-teal-500 bg-member-teal-300 text-member-teal-foreground",
    progress: "bg-member-teal-500",
  },
  green: {
    column: "bg-member-green-100 border-member-green-200",
    badge: "bg-member-green-500 text-member-avatar-foreground",
    period: "bg-member-green-200 border-member-green-300",
    card: "border-member-green-200 bg-member-green-100",
    completeCard: "border-member-green-500 bg-member-green-300 text-member-green-foreground",
    progress: "bg-member-green-500",
  },
  lime: {
    column: "bg-member-lime-100 border-member-lime-200",
    badge: "bg-member-lime-500 text-member-avatar-foreground",
    period: "bg-member-lime-200 border-member-lime-300",
    card: "border-member-lime-200 bg-member-lime-100",
    completeCard: "border-member-lime-500 bg-member-lime-300 text-member-lime-foreground",
    progress: "bg-member-lime-500",
  },
  amber: {
    column: "bg-member-amber-100 border-member-amber-200",
    badge: "bg-member-amber-500 text-member-avatar-foreground",
    period: "bg-member-amber-200 border-member-amber-300",
    card: "border-member-amber-200 bg-member-amber-100",
    completeCard: "border-member-amber-500 bg-member-amber-300 text-member-amber-foreground",
    progress: "bg-member-amber-500",
  },
  orange: {
    column: "bg-member-orange-100 border-member-orange-200",
    badge: "bg-member-orange-500 text-member-avatar-foreground",
    period: "bg-member-orange-200 border-member-orange-300",
    card: "border-member-orange-200 bg-member-orange-100",
    completeCard: "border-member-orange-500 bg-member-orange-300 text-member-orange-foreground",
    progress: "bg-member-orange-500",
  },
  red: {
    column: "bg-member-red-100 border-member-red-200",
    badge: "bg-member-red-500 text-member-avatar-foreground",
    period: "bg-member-red-200 border-member-red-300",
    card: "border-member-red-200 bg-member-red-100",
    completeCard: "border-member-red-500 bg-member-red-300 text-member-red-foreground",
    progress: "bg-member-red-500",
  },
  pink: {
    column: "bg-member-pink-100 border-member-pink-200",
    badge: "bg-member-pink-500 text-member-avatar-foreground",
    period: "bg-member-pink-200 border-member-pink-300",
    card: "border-member-pink-200 bg-member-pink-100",
    completeCard: "border-member-pink-500 bg-member-pink-300 text-member-pink-foreground",
    progress: "bg-member-pink-500",
  },
  violet: {
    column: "bg-member-violet-100 border-member-violet-200",
    badge: "bg-member-violet-500 text-member-avatar-foreground",
    period: "bg-member-violet-200 border-member-violet-300",
    card: "border-member-violet-200 bg-member-violet-100",
    completeCard: "border-member-violet-500 bg-member-violet-300 text-member-violet-foreground",
    progress: "bg-member-violet-500",
  },
};

const NEUTRAL_SCALE: MemberScale = {
  column: "bg-muted border-border",
  badge: "bg-muted text-foreground",
  period: "bg-muted border-border",
  card: "border-border bg-card",
  completeCard: "border-foreground bg-muted text-foreground",
  progress: "bg-muted-foreground",
};

type ResolvedMemberScale = MemberScale & { colorVar: string };

function memberScale(profile: MemberColorProfile | undefined): ResolvedMemberScale {
  if (profile && MEMBER_COLOR_KEYS.includes(profile.colorKey)) {
    return {
      ...MEMBER_SCALES[profile.colorKey],
      colorVar: `var(--color-member-${profile.colorKey}-500)`,
    };
  }
  return { ...NEUTRAL_SCALE, colorVar: "var(--color-muted-foreground)" };
}

function householdNowMinutes(timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

interface ChoreColumnsProps {
  date?: string;
  layout: "fit" | "scroll";
}

export function ChoreColumns({ date, layout }: ChoreColumnsProps): React.JSX.Element {
  const { t } = useTranslation();
  const chores = useTodayChores(date);
  const [periods, setPeriods] = useState<DayPeriodDTO[] | null>(null);
  const [memberProfiles, setMemberProfiles] = useState<Map<string, MemberColorProfile>>(new Map());
  const [activePeriodByMember, setActivePeriodByMember] = useState<Record<string, PeriodId>>({});

  useEffect(() => {
    const controller = new AbortController();
    void authFetch("/api/members?lifecycle=active", {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`members: ${res.status}`);
        const data = (await res.json()) as MemberColorProfile[];
        if (!Array.isArray(data)) throw new Error("members: invalid response");
        setMemberProfiles(
          new Map(
            data
              .filter((member) => MEMBER_COLOR_KEYS.includes(member.colorKey))
              .map((member) => [member.id, member])
          )
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void authFetch("/api/day-periods", { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`day-periods: ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data)) setPeriods(data as DayPeriodDTO[]);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const columns = chores.columns;
    if (columns === null || periods === null || chores.timezone === null) return;
    const activePeriod = resolveActivePeriod(periods, householdNowMinutes(chores.timezone));
    setActivePeriodByMember((current) => {
      const next = { ...current };
      for (const column of columns) {
        if (!(column.memberId in next)) next[column.memberId] = activePeriod;
      }
      return next;
    });
  }, [chores.columns, chores.timezone, periods]);

  const selectPeriod = useCallback((memberId: string, periodId: PeriodId) => {
    setActivePeriodByMember((current) => ({
      ...current,
      [memberId]: periodId,
    }));
  }, []);

  return (
    <>
      {chores.error && (
        <ErrorNotice message={t(layout === "fit" ? "todayChores.error" : "chores.board.error")} />
      )}
      {chores.toggleError && <ErrorNotice message={chores.toggleError} className="mb-3" />}
      {chores.columns === null && !chores.error && (
        <p role="status" className="text-muted-foreground">
          {t(layout === "fit" ? "todayChores.loading" : "chores.board.loading")}
        </p>
      )}
      {chores.columns?.length === 0 && (
        <p className="text-muted-foreground">
          {t(layout === "fit" ? "todayChores.noChildren" : "chores.board.noChildren")}
        </p>
      )}
      {chores.columns && chores.columns.length > 0 && (
        <div
          data-testid="chore-columns"
          className="flex min-h-0 flex-1 items-stretch gap-4 overflow-x-auto pb-1"
        >
          {chores.columns.map((column) => (
            <ChoreColumn
              key={column.memberId}
              column={column}
              scale={memberScale(memberProfiles.get(column.memberId))}
              activePeriod={activePeriodByMember[column.memberId] ?? column.dayPeriods[0]?.id}
              pending={chores.pending}
              t={t}
              onSelectPeriod={selectPeriod}
              onToggleChore={chores.requestToggle}
              layout={layout}
            />
          ))}
        </div>
      )}
      <ConfirmDialog
        open={chores.confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) chores.closeConfirm();
        }}
        title={t(
          layout === "fit"
            ? "todayChores.uncompleteConfirmTitle"
            : "chores.board.uncompleteConfirmTitle"
        )}
        description={t(
          layout === "fit"
            ? "todayChores.uncompleteConfirmDescription"
            : "chores.board.uncompleteConfirmDescription"
        )}
        confirmLabel={t(
          layout === "fit"
            ? "todayChores.uncompleteConfirmConfirm"
            : "chores.board.uncompleteConfirmConfirm"
        )}
        cancelLabel={t(
          layout === "fit"
            ? "todayChores.uncompleteConfirmCancel"
            : "chores.board.uncompleteConfirmCancel"
        )}
        onConfirm={chores.confirmUncomplete}
        confirmTestId={
          layout === "fit" ? "today-chores-uncomplete-confirm" : "chores-uncomplete-confirm"
        }
        cancelTestId={
          layout === "fit" ? "today-chores-uncomplete-cancel" : "chores-uncomplete-cancel"
        }
      />
    </>
  );
}

function ChoreColumn({
  column,
  scale,
  activePeriod,
  pending,
  t,
  onSelectPeriod,
  onToggleChore,
  layout,
}: {
  column: BoardColumn;
  scale: ResolvedMemberScale;
  activePeriod: PeriodId | undefined;
  pending: ReadonlySet<string>;
  t: (key: MessageKey) => string;
  onSelectPeriod: (memberId: string, periodId: PeriodId) => void;
  onToggleChore: (chore: BoardChore, memberId: string) => void;
  layout: "fit" | "scroll";
}): React.JSX.Element {
  const activeIndex = Math.max(
    0,
    column.dayPeriods.findIndex((period) => period.id === activePeriod)
  );
  const period = column.dayPeriods[activeIndex];
  const canGoUp = activeIndex > 0;
  const canGoDown = activeIndex < column.dayPeriods.length - 1;

  return (
    <div
      data-testid={`${layout === "fit" ? "today-chores" : "chores-board"}-column-${column.memberId}`}
      className="h-full min-w-[220px] flex-1 basis-[220px] overflow-y-auto rounded-2xl border p-3 shadow-sm [background:linear-gradient(180deg,color-mix(in_oklch,var(--member-color)_16%,var(--member-mix-ground)),color-mix(in_oklch,var(--member-color)_8%,var(--member-mix-ground)))] [border-color:color-mix(in_oklch,var(--member-color)_28%,var(--member-mix-ground))]"
      // eslint-disable-next-line ui-policy/debt -- The configured member identity is passed through one CSS custom property into the token layer.
      style={{ "--member-color": scale.colorVar } as CSSProperties}
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          data-testid="today-chores-member-badge"
          className={cn("min-w-0 rounded-full px-3 py-1 text-lg font-semibold", scale.badge)}
        >
          {column.displayName}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-sm font-semibold tabular-nums">
          {column.streak !== null && (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 [background:color-mix(in_oklch,var(--member-color)_12%,var(--member-mix-ground))] [border-color:color-mix(in_oklch,var(--member-color)_34%,var(--member-mix-ground))]">
              <Flame aria-hidden="true" className="size-4 fill-current text-accent" />
              <span className="sr-only">{t("chores.board.streakLabel")}</span> {column.streak}
            </span>
          )}
          {column.todayProgress !== null && (
            <span className="relative inline-flex min-w-16 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-1 [background:color-mix(in_oklch,var(--member-color)_12%,var(--member-mix-ground))] [border-color:color-mix(in_oklch,var(--member-color)_34%,var(--member-mix-ground))]">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[var(--today-chores-progress)] rounded-full [background:color-mix(in_oklch,var(--member-color)_50%,var(--member-mix-ground))]"
                // eslint-disable-next-line ui-policy/debt -- Dynamic progress is passed through a CSS custom property into the token layer.
                style={
                  {
                    "--today-chores-progress": `${Math.min(
                      100,
                      column.todayProgress.total > 0
                        ? (column.todayProgress.completed / column.todayProgress.total) * 100
                        : 0
                    )}%`,
                  } as CSSProperties
                }
              />
              <Check aria-hidden="true" className="relative size-4" />
              <span className="relative">
                <span className="sr-only">{t("chores.board.progressLabel")}</span>{" "}
                {column.todayProgress.completed}/{column.todayProgress.total}
              </span>
            </span>
          )}
        </div>
      </div>
      {period && (
        <div className="mt-3 flex flex-col gap-2">
          {canGoUp && (
            <Button
              type="button"
              variant="outline"
              aria-label={t("todayChores.previousPeriod")}
              className="w-full"
              onClick={() => onSelectPeriod(column.memberId, column.dayPeriods[activeIndex - 1].id)}
            >
              <ChevronUp aria-hidden="true" />
            </Button>
          )}
          <section
            data-testid="today-chores-active-period"
            data-period-id={period.id}
            className="rounded-xl border p-2 [background:color-mix(in_oklch,var(--member-color)_10%,var(--member-mix-ground))] [border-color:color-mix(in_oklch,var(--member-color)_25%,var(--member-mix-ground))]"
          >
            <header className="mb-2 flex items-center gap-2">
              <h3 className="font-semibold">{t(DAY_PERIOD_LABEL_KEYS[period.id])}</h3>
              <span className="rounded-full px-2 py-0.5 text-sm [background:color-mix(in_oklch,var(--member-color)_18%,var(--member-mix-ground))]">
                {period.chores.filter((chore) => chore.completed).length}/{period.chores.length}
              </span>
            </header>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {period.chores.length === 0 ? (
                <li className="text-muted-foreground">{t("todayChores.empty")}</li>
              ) : (
                period.chores.map((chore) => (
                  <li key={chore.id}>
                    <StatusToggle
                      data-testid={
                        layout === "fit"
                          ? `today-chore-toggle-${column.memberId}-${chore.id}`
                          : `chore-toggle-${chore.id}`
                      }
                      pressed={chore.completed}
                      label={
                        <span className="flex w-full flex-1 flex-col self-stretch">
                          <span
                            className={cn(
                              "flex flex-1 items-center justify-center px-4 py-3",
                              chore.completed
                                ? "[background:color-mix(in_oklch,var(--member-color)_30%,var(--member-mix-ground))]"
                                : "[background:color-mix(in_oklch,var(--member-color)_14%,var(--member-mix-ground))]"
                            )}
                          >
                            <span
                              aria-hidden="true"
                              data-testid={`today-chore-icon-${column.memberId}-${chore.id}`}
                              data-emoji={chore.icon ?? "📋"}
                              className={cn(
                                "relative flex size-12 items-center justify-center text-5xl leading-none",
                                chore.completed && "line-through opacity-55"
                              )}
                            >
                              <NotoEmoji
                                emoji={chore.icon ?? "📋"}
                                size={48}
                                className="block size-12"
                              />
                              {chore.completed && (
                                <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-foreground" />
                              )}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "flex min-h-12 items-center gap-3 px-4 py-2",
                              chore.completed
                                ? "[background:color-mix(in_oklch,var(--member-color)_50%,var(--member-mix-ground))]"
                                : "[background:color-mix(in_oklch,var(--member-color)_26%,var(--member-mix-ground))]"
                            )}
                          >
                            <span
                              data-testid={`today-chore-name-${column.memberId}-${chore.id}`}
                              className={cn(
                                "flex-1 text-left font-serif text-lg leading-tight font-semibold",
                                chore.completed && "text-muted-foreground line-through"
                              )}
                            >
                              {chore.name}
                            </span>
                            <span
                              aria-hidden="true"
                              className={cn(
                                "flex size-7 shrink-0 items-center justify-center rounded-full border-2",
                                chore.completed
                                  ? "text-primary-foreground [background:color-mix(in_oklch,var(--member-color)_58%,var(--member-mix-ground))] [border-color:color-mix(in_oklch,var(--member-color)_66%,var(--member-mix-ground))]"
                                  : "[background:color-mix(in_oklch,var(--member-color)_10%,var(--member-mix-ground))] [border-color:color-mix(in_oklch,var(--member-color)_34%,var(--member-mix-ground))]"
                              )}
                            >
                              {pending.has(chore.id) ? (
                                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                              ) : (
                                chore.completed && <Check className="size-4" strokeWidth={3} />
                              )}
                            </span>
                          </span>
                        </span>
                      }
                      accessibleName={chore.name}
                      busy={pending.has(chore.id)}
                      onPress={() => onToggleChore(chore, column.memberId)}
                      wrap
                      className={cn(
                        "min-h-[120px] w-full items-stretch overflow-hidden rounded-2xl border p-0",
                        chore.completed
                          ? "[border-color:color-mix(in_oklch,var(--member-color)_48%,var(--member-mix-ground))]"
                          : "[border-color:color-mix(in_oklch,var(--member-color)_26%,var(--member-mix-ground))]"
                      )}
                    />
                  </li>
                ))
              )}
            </ul>
          </section>
          {canGoDown && (
            <Button
              type="button"
              variant="outline"
              aria-label={t("todayChores.nextPeriod")}
              className="w-full"
              onClick={() => onSelectPeriod(column.memberId, column.dayPeriods[activeIndex + 1].id)}
            >
              <ChevronDown aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
