import { useMemo, useState } from "react";

import { useTranslation } from "@/i18n";
import type { MealPlan, MenuItem } from "../../shared";

/** Where a meal comes from: a one-off for its date, or a meal plan's weekly entry. Colours are
 * automatic (spec D1): a plan's tone is its position among ALL plans by creation order (then id),
 * so renaming or (de)activating a plan never recolours another. Nothing is stored. */

export const ONE_OFF_ORIGIN = "oneoff";
export const MEAL_ORIGIN_PLAN_TONES = [
  "plan-1",
  "plan-2",
  "plan-3",
  "plan-4",
  "plan-5",
  "plan-6",
] as const;
export type MealOriginTone = "oneoff" | "unknown" | (typeof MEAL_ORIGIN_PLAN_TONES)[number];
export type MealOriginEmphasis = "normal" | "hit" | "dim";

export interface MealOriginPill {
  id: string;
  label: string;
  tone: MealOriginTone;
}

/** Static map so Tailwind and readers see every class; the colours live in globals.css/tokens.css. */
export const MEAL_ORIGIN_TONE_CLASS: Record<MealOriginTone, string> = {
  oneoff: "meal-origin-oneoff",
  unknown: "meal-origin-unknown",
  "plan-1": "meal-origin-plan-1",
  "plan-2": "meal-origin-plan-2",
  "plan-3": "meal-origin-plan-3",
  "plan-4": "meal-origin-plan-4",
  "plan-5": "meal-origin-plan-5",
  "plan-6": "meal-origin-plan-6",
};

/** Binary string order, like SQLite's default collation used by the menu's plan-name order. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function planTones(plans: readonly MealPlan[]): ReadonlyMap<string, MealOriginTone> {
  const ordered = [...plans].sort((a, b) => a.createdAt - b.createdAt || compareText(a.id, b.id));
  return new Map(
    ordered.map((plan, index) => [
      plan.id,
      MEAL_ORIGIN_PLAN_TONES[index % MEAL_ORIGIN_PLAN_TONES.length],
    ])
  );
}

export function originIdOf(item: MenuItem): string {
  return item.planId ?? ONE_OFF_ORIGIN;
}

export function toneOf(
  originId: string,
  tones: ReadonlyMap<string, MealOriginTone>
): MealOriginTone {
  if (originId === ONE_OFF_ORIGIN) return "oneoff";
  return tones.get(originId) ?? "unknown";
}

export function emphasisOf(originId: string, selected: readonly string[]): MealOriginEmphasis {
  if (selected.length === 0) return "normal";
  return selected.includes(originId) ? "hit" : "dim";
}

/** "One-off" first, then every ACTIVE plan by name then id (spec D2). */
export function originPills(
  plans: readonly MealPlan[],
  tones: ReadonlyMap<string, MealOriginTone>,
  oneOffLabel: string
): MealOriginPill[] {
  const active = plans
    .filter((plan) => plan.active)
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  return [
    { id: ONE_OFF_ORIGIN, label: oneOffLabel, tone: "oneoff" },
    ...active.map((plan) => ({ id: plan.id, label: plan.name, tone: toneOf(plan.id, tones) })),
  ];
}

/** Exactly one pill selected, and it is an active plan: the add dialog opens on that plan. */
export function preselectedPlanId(
  selected: readonly string[],
  plans: readonly MealPlan[]
): string | undefined {
  if (selected.length !== 1) return undefined;
  const [id] = selected;
  return plans.some((plan) => plan.id === id && plan.active) ? id : undefined;
}

export interface MealOriginsState {
  pills: MealOriginPill[];
  tones: ReadonlyMap<string, MealOriginTone>;
  selected: string[];
  setSelected(next: string[]): void;
  preselectPlanId: string | undefined;
}

const NO_PLANS: readonly MealPlan[] = [];

/** Page-local pill selection (spec D3): survives week navigation, is not persisted, and drops ids
 * whose pill is gone. */
export function useMealOrigins(plans: readonly MealPlan[] | null): MealOriginsState {
  const { t } = useTranslation();
  const list = plans ?? NO_PLANS;
  const [rawSelected, setSelected] = useState<string[]>([]);
  const tones = useMemo(() => planTones(list), [list]);
  const pills = useMemo(() => originPills(list, tones, t("meals.origin.oneOff")), [list, tones, t]);
  const selected = useMemo(
    () => rawSelected.filter((id) => pills.some((pill) => pill.id === id)),
    [rawSelected, pills]
  );
  return {
    pills,
    tones,
    selected,
    setSelected,
    preselectPlanId: preselectedPlanId(selected, list),
  };
}
