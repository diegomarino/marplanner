import { useTranslation } from "@/i18n";
import { Plus } from "lucide-react";
import type { MenuItem, Slot } from "../../shared";

export interface MealCellProps {
  date: string;
  slot: Slot;
  items: MenuItem[];
  isToday: boolean;
  onAdd(date: string, slot: Slot): void;
  onSelect(date: string, item: MenuItem): void;
}

function formatDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function MealCell({ date, slot, items, isToday, onAdd, onSelect }: MealCellProps) {
  const { t, language } = useTranslation();
  const dateLabel = formatDate(date, language);
  const addLabel = `${t("meals.week.add")} ${t(`meals.slot.${slot}` as "meals.slot.breakfast" | "meals.slot.lunch" | "meals.slot.snack" | "meals.slot.dinner").toLowerCase()} ${t("meals.week.on")} ${dateLabel}`;

  if (items.length === 0) {
    return (
      <button
        type="button"
        data-testid={`meal-cell-${date}-${slot}`}
        className={`group min-h-[var(--control-height)] border-t text-[length:var(--control-font-size)] transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${isToday ? "bg-accent/10" : ""}`}
        onClick={() => onAdd(date, slot)}
        aria-label={addLabel}
      >
        <Plus
          aria-hidden="true"
          data-testid="meal-cell-add-icon"
          className="mx-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    );
  }

  return (
    <div
      data-testid={`meal-cell-${date}-${slot}`}
      className={`group relative min-h-32 border-t p-2 ${isToday ? "bg-accent/10" : ""}`}
    >
      <div className="flex min-w-0 flex-col gap-2 pb-8">
        {items.map((item) => (
          <button
            key={item.entryId}
            type="button"
            data-testid="meal-entry-card"
            data-entry-id={item.entryId}
            data-source={item.source}
            className="min-h-[var(--control-height)] rounded-xl border border-accent bg-accent/20 px-3 py-2 text-left text-[length:var(--control-font-size)] text-accent-foreground shadow-xs transition-shadow hover:shadow-md"
            onClick={() => onSelect(date, item)}
          >
            <span>{item.isTombstone ? t("meals.menu.tombstoneLabel") : item.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="absolute right-2 bottom-2 flex h-[var(--control-height)] w-[var(--control-height)] items-center justify-center rounded-full text-[length:var(--control-font-size)] text-muted-foreground opacity-0 transition-opacity hover:bg-accent/20 hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={() => onAdd(date, slot)}
          aria-label={addLabel}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
