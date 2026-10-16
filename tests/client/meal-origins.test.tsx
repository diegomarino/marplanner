import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { LanguageProvider } from "@/i18n";
import {
  emphasisOf,
  originIdOf,
  originPills,
  planTones,
  preselectedPlanId,
  toneOf,
  useMealOrigins,
} from "@/meals/meal-origins";
import type { MealPlan, MenuItem } from "../../src/shared";

const plan = (id: string, name: string, createdAt: number, active = true): MealPlan => ({
  id,
  name,
  active,
  createdAt,
  updatedAt: createdAt,
});
const item = (planId: string | null): MenuItem => ({
  entryId: "e",
  slot: "lunch",
  label: "x",
  isTombstone: false,
  source: planId ? "recurring" : "oneoff",
  planId,
  recipeId: null,
  note: "x",
});

describe("meal origins", () => {
  it("colours plans by creation order then id, including inactive plans, and cycles after six", () => {
    const plans = [
      plan("b", "Zeta", 5),
      plan("a", "Alpha", 5),
      plan("c", "Old", 1, false),
      ...["d", "e", "f", "g", "h"].map((id, i) => plan(id, id, 10 + i)),
    ];
    const tones = planTones(plans);
    expect(tones.get("c")).toBe("plan-1");
    expect(tones.get("a")).toBe("plan-2");
    expect(tones.get("b")).toBe("plan-3");
    expect(tones.get("f")).toBe("plan-6");
    expect(tones.get("g")).toBe("plan-1");
    expect(tones.get("h")).toBe("plan-2");
  });

  it("keeps a plan's colour when another plan is renamed or deactivated", () => {
    const before = planTones([plan("a", "A", 1), plan("b", "B", 2)]);
    const after = planTones([plan("a", "Z renamed", 1, false), plan("b", "B", 2)]);
    expect(after.get("b")).toBe(before.get("b"));
  });

  it("maps items to origins and unknown plans to the unknown tone", () => {
    const tones = planTones([plan("a", "A", 1)]);
    expect(originIdOf(item(null))).toBe("oneoff");
    expect(originIdOf(item("a"))).toBe("a");
    expect(toneOf("oneoff", tones)).toBe("oneoff");
    expect(toneOf("a", tones)).toBe("plan-1");
    expect(toneOf("missing", tones)).toBe("unknown");
  });

  it("highlights selected origins and dims the rest only while something is selected", () => {
    expect(emphasisOf("a", [])).toBe("normal");
    expect(emphasisOf("a", ["a"])).toBe("hit");
    expect(emphasisOf("oneoff", ["a"])).toBe("dim");
  });

  it("offers One-off first, then active plans by name, never inactive ones", () => {
    const plans = [plan("b", "School", 2), plan("a", "Simpson", 1), plan("c", "Gone", 3, false)];
    expect(originPills(plans, planTones(plans), "One-off")).toEqual([
      { id: "oneoff", label: "One-off", tone: "oneoff" },
      { id: "b", label: "School", tone: "plan-2" },
      { id: "a", label: "Simpson", tone: "plan-1" },
    ]);
  });

  it("preselects a plan only when exactly one active plan pill is selected", () => {
    const plans = [plan("a", "A", 1), plan("b", "B", 2, false)];
    expect(preselectedPlanId(["a"], plans)).toBe("a");
    expect(preselectedPlanId(["oneoff"], plans)).toBeUndefined();
    expect(preselectedPlanId(["a", "oneoff"], plans)).toBeUndefined();
    expect(preselectedPlanId(["b"], plans)).toBeUndefined();
    expect(preselectedPlanId([], plans)).toBeUndefined();
  });

  it("drops a selected plan whose pill disappears", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LanguageProvider>{children}</LanguageProvider>
    );
    let plans: MealPlan[] = [plan("a", "A", 1)];
    const { result, rerender } = renderHook(() => useMealOrigins(plans), { wrapper });
    act(() => result.current.setSelected(["a"]));
    expect(result.current.preselectPlanId).toBe("a");
    plans = [plan("a", "A", 1, false)];
    rerender();
    expect(result.current.selected).toEqual([]);
    expect(result.current.preselectPlanId).toBeUndefined();
    expect(result.current.pills.map((pill) => pill.id)).toEqual(["oneoff"]);
  });

  it("works with no plans loaded yet", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LanguageProvider>{children}</LanguageProvider>
    );
    const { result } = renderHook(() => useMealOrigins(null), { wrapper });
    expect(result.current.pills).toEqual([{ id: "oneoff", label: "One-off", tone: "oneoff" }]);
    expect(toneOf("a", result.current.tones)).toBe("unknown");
  });
});
