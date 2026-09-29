import "temporal-polyfill/global";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Temporal } from "temporal-polyfill";
import { ChoreColumns } from "@/chores/ChoreColumns";
import { useTranslation } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { Button } from "@/components/ui/button";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/** Full-page chores surface; date navigation belongs here, outside the shared columns. */
export function ChoresBoard(): React.JSX.Element {
  const { language, t } = useTranslation();
  const { timezone } = useHouseholdSettings();
  const today = timezone === null ? null : todayInTimezone(timezone);
  const [dayOffset, setDayOffset] = useState(0);
  const selectedDate = useMemo(
    () =>
      today === null
        ? undefined
        : Temporal.PlainDate.from(today).add({ days: dayOffset }).toString(),
    [dayOffset, today]
  );
  const dateLabel = useMemo(() => {
    if (!selectedDate) return null;
    return new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${selectedDate}T12:00:00.000Z`));
  }, [language, selectedDate]);

  return (
    <main className="flex h-[calc(100dvh-5rem)] min-h-0 flex-col gap-4 p-6">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("chores.board.title")}</h1>
          {dateLabel && <h2 className="text-xl font-semibold capitalize">{dateLabel}</h2>}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("chores.board.previousDay")}
            onClick={() => setDayOffset((current) => current - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" onClick={() => setDayOffset(0)}>
            {t("chores.board.today")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("chores.board.nextDay")}
            onClick={() => setDayOffset((current) => current + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
      <ChoreColumns date={selectedDate} layout="scroll" />
    </main>
  );
}
