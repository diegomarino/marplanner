import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import type { MenuItem, Slot } from "../../shared";
import {
  emphasisOf,
  MEAL_ORIGIN_TONE_CLASS,
  ONE_OFF_ORIGIN,
  originIdOf,
  toneOf,
  type MealOriginTone,
} from "./meal-origins";

/** What a cell needs to tint its chips: plan tones, the selected pills, and each origin's name. */
export interface MealCellOrigin {
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: readonly string[];
  labels: ReadonlyMap<string, string>;
}

const NO_ORIGIN: MealCellOrigin = { tones: new Map(), selected: [], labels: new Map() };

export interface MealCellProps {
  date: string;
  slot: Slot;
  items: MenuItem[];
  isToday: boolean;
  onAdd(date: string, slot: Slot): void;
  onSelect(date: string, item: MenuItem): void;
  /** Origin tones and highlight; without it recurring chips use the unknown tone. */
  origin?: MealCellOrigin;
}

function formatDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function MealCell({
  date,
  slot,
  items,
  isToday,
  onAdd,
  onSelect,
  origin = NO_ORIGIN,
}: MealCellProps) {
  const { t, language } = useTranslation();
  const dateLabel = formatDate(date, language);
  const addLabel = `${t("meals.week.add")} ${t(`meals.slot.${slot}` as "meals.slot.breakfast" | "meals.slot.lunch" | "meals.slot.snack" | "meals.slot.dinner").toLowerCase()} ${t("meals.week.on")} ${dateLabel}`;

  if (items.length === 0) {
    return (
      // eslint-disable-next-line ui-policy/raw-controls -- Native grid-cell surface stretches to the whole meal row; token-sized and covered by family density tests.
      <button
        type="button"
        data-testid={`meal-cell-${date}-${slot}`}
        className={`group min-h-[var(--control-height)] border-t text-control transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${isToday ? "bg-accent/10" : ""}`}
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
        {items.map((item) => {
          const originId = originIdOf(item);
          const tone = toneOf(originId, origin.tones);
          const originLabel =
            origin.labels.get(originId) ??
            t(originId === ONE_OFF_ORIGIN ? "meals.origin.oneOff" : "meals.origin.recurring");
          return (
            // eslint-disable-next-line ui-policy/raw-controls -- Native entry card grows with user content and retains block text flow inside the meal grid.
            <button
              key={item.entryId}
              type="button"
              data-testid="meal-entry-card"
              data-entry-id={item.entryId}
              data-source={item.source}
              data-origin={originId}
              data-emphasis={emphasisOf(originId, origin.selected)}
              title={originLabel}
              className={cn(
                "meal-origin-chip min-h-[var(--control-height)] rounded-xl border px-3 py-2 text-left text-control shadow-xs transition-shadow hover:shadow-md",
                MEAL_ORIGIN_TONE_CLASS[tone]
              )}
              onClick={() => onSelect(date, item)}
            >
              <span className={item.note !== null && !item.isTombstone ? "italic" : undefined}>
                {item.isTombstone ? t("meals.menu.tombstoneLabel") : item.label}
              </span>
            </button>
          );
        })}
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className="absolute right-2 bottom-2 flex h-[var(--control-height)] w-[var(--control-height)] items-center justify-center rounded-full text-control text-muted-foreground opacity-0 transition-opacity hover:bg-accent/20 hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={() => onAdd(date, slot)}
          aria-label={addLabel}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
