/** "meals" domain block ("The 21 block types", FR-013). PORTED from
 * v1 `apps/api/src/lib/daily-briefing/blocks/meals.ts` (lunch/snack/dinner labels for the day),
 * re-sourced against v2's meals domain.
 * v2 seam: `getMenu(date, undefined)` (`src/server/modules/meals`, host-api-barrel-exported — the
 * SAME function 010's own `gatherBlocks` already calls for its "meals" block). `getMenu` already
 * resolves the household-timezone weekday for recurring entries internally
 * (`weekdayOf(date, readHouseholdTimezone)` in `meals/index.ts`) and returns each entry's
 * display `label` pre-resolved (recipe name, a tombstone placeholder, or a one-off note) — v1 had
 * to look up `recipes` separately and derive the label by hand; that work is already done here.
 * `breakfast` entries are excluded (v1 parity — the adapter/envelope shape only has
 * lunch/snack/dinner fields).
 * MEALS-RECIPES-AC-10 fold: v1 assumed one entry per slot (v1's meals table had
 * no additive multi-entry model); v2's meals domain is a deliberate CONTRACT EXTENSION over that
 * port — "Consumers receive a per-slot resolved-label list; the briefing freezes it verbatim" — so
 * a slot MAY carry several entries (e.g. two one-off lunch options) and this block must preserve
 * ALL of them, not just the first. The merged adapter's shape is still `lunch?/snack?/dinner?:
 * string` (a single string per slot), so multiple entries for one slot are joined,
 * in `getMenu`'s own returned order, with ", " — the freeze-verbatim requirement is satisfied at
 * the label-list level (every label survives into the string), not by picking one.
 */
import { getMenu } from "../../../host-api";

const TYPE = "meals";

export interface MealsBlockContext {
  date: string;
}

export interface MealsBlockData {
  lunch?: string;
  snack?: string;
  dinner?: string;
}

function stripEmojis(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/️/g, "")
    .trim();
}

export const mealsBlock = {
  type: TYPE,
  scope: "shared" as const,
  source: "src/server/modules/meals getMenu (host-api-barrel-exported, 010 precedent)",
  async generate(ctx: MealsBlockContext): Promise<MealsBlockData | null> {
    const items = getMenu(ctx.date, undefined);

    // N-per-slot (MEALS-RECIPES-AC-10): collect EVERY entry for a slot, in getMenu's own
    // returned order, and join their labels — a slot's siblings are never dropped.
    const joinSlot = (slot: "lunch" | "snack" | "dinner"): string | undefined => {
      const labels = items.filter((i) => i.slot === slot).map((i) => i.label);
      return labels.length > 0 ? labels.join(", ") : undefined;
    };

    const lunchLabel = joinSlot("lunch");
    const snackLabel = joinSlot("snack");
    const dinnerLabel = joinSlot("dinner");

    if (!lunchLabel && !snackLabel && !dinnerLabel) return null;

    const data: MealsBlockData = {};
    if (lunchLabel) data.lunch = stripEmojis(lunchLabel);
    if (snackLabel) data.snack = stripEmojis(snackLabel);
    if (dinnerLabel) data.dinner = stripEmojis(dinnerLabel);
    return data;
  },
};
