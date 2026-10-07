import { appUrl } from "@/lib/base-path";
import { useId } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { useTodayMeals } from "@/meals/useTodayMeals";
import type { Slot } from "../../shared";

const SLOTS: Slot[] = ["breakfast", "lunch", "snack", "dinner"];

const SLOT_LABEL_KEYS: Record<Slot, MessageKey> = {
  breakfast: "meals.slot.breakfast",
  lunch: "meals.slot.lunch",
  snack: "meals.slot.snack",
  dinner: "meals.slot.dinner",
};

const SLOT_ICONS: Record<Slot, string> = {
  breakfast: "☀",
  lunch: "◒",
  snack: "✦",
  dinner: "☾",
};

/** Read-only household-day menu strip for the Home dashboard. */
export function TodayMeals(): React.JSX.Element {
  const { t } = useTranslation();
  const headingId = useId();
  const { items, error } = useTodayMeals();
  const returnedItems = items ?? [];
  const itemsBySlot = new Map<Slot, typeof returnedItems>();
  for (const item of returnedItems) {
    const slotItems = itemsBySlot.get(item.slot) ?? [];
    slotItems.push(item);
    itemsBySlot.set(item.slot, slotItems);
  }

  return (
    <section aria-labelledby={headingId} className="bg-card rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-xl font-semibold">
          {t("todayMeals.title")}
        </h2>
        <a href={appUrl("/meals")} className="text-sm font-medium underline underline-offset-4">
          {t("todayMeals.viewAll")}
        </a>
      </div>
      {error && <ErrorNotice message={t("todayMeals.error")} />}
      <div
        data-testid="today-meals-strip"
        className="min-h-24 overflow-x-auto rounded-xl border border-border/70 bg-background/40 p-2"
      >
        {items === null && !error && (
          <p role="status" className="mb-2 text-sm text-muted-foreground">
            {t("todayMeals.loading")}
          </p>
        )}
        {items?.length === 0 && (
          <p className="mb-2 text-sm text-muted-foreground">{t("todayMeals.empty")}</p>
        )}
        <ul className="m-0 grid min-w-full auto-cols-[minmax(10rem,1fr)] grid-flow-col grid-rows-1 gap-2 list-none p-0">
          {SLOTS.map((slot) => {
            const slotItems = itemsBySlot.get(slot) ?? [];
            const populated = slotItems.length > 0;
            return (
              <li
                key={slot}
                data-testid={populated ? "today-meals-tile" : "today-meals-empty-slot"}
                data-slot={slot}
                className={
                  populated
                    ? "flex min-h-16 flex-col justify-between rounded-xl border border-border bg-card px-3 py-2"
                    : "flex min-h-16 flex-col justify-between rounded-xl border border-dashed border-border/70 px-3 py-2 text-muted-foreground"
                }
              >
                <span
                  data-testid="today-meals-slot"
                  data-slot={slot}
                  className="flex items-center gap-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  <span
                    aria-hidden="true"
                    data-testid={populated ? `today-meals-slot-icon-${slot}` : undefined}
                  >
                    {SLOT_ICONS[slot]}
                  </span>
                  {t(SLOT_LABEL_KEYS[slot])}
                </span>
                {populated ? (
                  <span data-testid="today-meals-item" className="text-sm font-medium">
                    {slotItems
                      .map((item) =>
                        item.isTombstone ? t("meals.menu.tombstoneLabel") : item.label
                      )
                      .join(" / ")}
                  </span>
                ) : (
                  <span aria-hidden="true" className="text-lg leading-none">
                    —
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
