import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MenuItem, Slot } from "../../shared";
import { MealCell } from "./MealCell";

const SLOTS: Slot[] = ["breakfast", "lunch", "snack", "dinner"];

function formatRangeDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatWeekday(date: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    weekday: "short",
    timeZone: "UTC",
  })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(/\.$/, "")
    .toUpperCase();
}

function dayNumber(date: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`)
  );
}

export interface MealPlanGridProps {
  weekDates: string[];
  weekMenu: Record<string, Record<Slot, MenuItem[]>>;
  todayDate: string | null;
  pending: boolean;
  onPrevious(): void;
  onCurrent(): void;
  onNext(): void;
  onAdd(date: string, slot: Slot): void;
  onSelect(date: string, item: MenuItem): void;
  /** Heading level of the week range: "h1" on the family board, "h3" under an admin panel heading. */
  titleAs?: "h1" | "h3";
}

export function MealPlanGrid({
  weekDates,
  weekMenu,
  todayDate,
  pending,
  onPrevious,
  onCurrent,
  onNext,
  onAdd,
  onSelect,
  titleAs = "h1",
}: MealPlanGridProps) {
  const { t, language } = useTranslation();
  const range = weekDates.length
    ? `${formatRangeDate(weekDates[0], language)} – ${formatRangeDate(weekDates[weekDates.length - 1], language)}`
    : null;
  return (
    <section className="flex h-full min-w-0 flex-col" aria-label={t("meals.week.title")}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 px-1">
        {range &&
          (titleAs === "h3" ? (
            <h3 className="text-2xl font-bold tracking-tight">{range}</h3>
          ) : (
            <h1 className="text-3xl font-bold tracking-tight">{range}</h1>
          ))}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="rounded-full"
            onClick={onPrevious}
            aria-label={t("meals.week.previous")}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" className="px-5" onClick={onCurrent}>
            {t("meals.week.today")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="rounded-full"
            onClick={onNext}
            aria-label={t("meals.week.next")}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          {pending && (
            <span role="status" className="text-muted-foreground">
              {t("meals.week.loading")}
            </span>
          )}
        </div>
      </div>
      <div
        data-testid="meal-plan-grid"
        className="flex-1 overflow-x-auto rounded-3xl border bg-card shadow-xs"
      >
        <div className="grid min-w-[56rem] grid-cols-[7rem_repeat(7,minmax(0,1fr))]">
          <div className="flex items-center justify-center border-r p-3 text-sm font-semibold text-muted-foreground">
            {t("meals.week.slot")}
          </div>
          {weekDates.map((date) => (
            <div
              key={date}
              data-testid={`meal-day-heading-${date}`}
              className={`flex flex-col items-center justify-center border-r p-3 text-sm font-semibold tracking-wide last:border-r-0 ${todayDate === date ? "bg-accent/20 text-accent-foreground" : "text-muted-foreground"}`}
            >
              <span>{formatWeekday(date, language)}</span>
              <span className="mt-0.5 text-xs opacity-75">{dayNumber(date)}</span>
            </div>
          ))}
          {SLOTS.map((slot) => (
            <div key={slot} data-slot-row={slot} className="contents">
              <div className="flex min-h-32 items-center justify-center border-r border-t bg-muted/30 p-3 text-sm font-medium text-muted-foreground">
                {t(
                  `meals.slot.${slot}` as
                    | "meals.slot.breakfast"
                    | "meals.slot.lunch"
                    | "meals.slot.snack"
                    | "meals.slot.dinner"
                )}
              </div>
              {weekDates.map((date) => (
                <MealCell
                  key={`${date}-${slot}`}
                  date={date}
                  slot={slot}
                  items={weekMenu[date]?.[slot] ?? []}
                  isToday={todayDate === date}
                  onAdd={onAdd}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
