import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { addCalendarDays, buildWeekDays } from "@/calendar/calendar-presentation";
import type {
  MealEntryEditInput,
  MealEntryInput,
  MenuItem,
  Recipe,
  RecipeEditInput,
  RecipeInput,
  Slot,
} from "../../shared";

export const MEALS_CHANGED_EVENT = "marplanner:meals-changed";

export interface MealsWorkspaceState {
  anchorDate: string | null;
  weekDates: string[];
  weekMenu: Record<string, Record<Slot, MenuItem[]>> | null;
  recipes: Recipe[] | null;
  weekError: string | null;
  recipeError: string | null;
  pending: boolean;
  goPreviousWeek(): void;
  goCurrentWeek(): void;
  goNextWeek(): void;
  retryWeek(): Promise<void>;
  searchRecipes(query: string): Promise<void>;
  createEntry(input: MealEntryInput): Promise<boolean>;
  editEntry(id: string, input: MealEntryEditInput): Promise<boolean>;
  deleteEntry(id: string): Promise<boolean>;
  createRecipe(input: RecipeInput): Promise<boolean>;
  editRecipe(id: string, input: RecipeEditInput): Promise<boolean>;
}

type WeekMenu = Record<string, Record<Slot, MenuItem[]>>;

type FetchInit = Parameters<typeof fetch>[1];

async function readJson<T>(url: string, init?: FetchInit): Promise<T> {
  const response = await authFetch(url, { credentials: "include", ...init });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

function requestInit(method: string, body: unknown): FetchInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function useMealsWorkspace(): MealsWorkspaceState {
  const { t } = useTranslation();
  const { timezone, weekStartDay } = useHouseholdSettings();
  const [anchorDate, setAnchorDate] = useState<string | null>(null);
  const [weekMenu, setWeekMenu] = useState<WeekMenu | null>(null);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [recipeError, setRecipeError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const anchorRef = useRef<string | null>(null);
  const weekGeneration = useRef(0);
  const recipeQuery = useRef("");

  const loadRecipes = useCallback(
    async (query: string) => {
      try {
        const suffix = query.trim() ? `?search=${encodeURIComponent(query.trim())}` : "";
        const payload = await readJson<Recipe[] | { recipes?: Recipe[] }>(`/api/recipes${suffix}`);
        const next = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.recipes)
            ? payload.recipes
            : [];
        setRecipes(next);
        setRecipeError(null);
      } catch {
        setRecipeError(t("meals.recipes.error"));
      }
    },
    [t]
  );

  const loadWeek = useCallback(
    async (date: string) => {
      const generation = ++weekGeneration.current;
      setPending(true);
      try {
        const next = await readJson<WeekMenu>(`/api/menu/week?date=${encodeURIComponent(date)}`);
        if (generation !== weekGeneration.current) return;
        setWeekMenu(next);
        setWeekError(null);
      } catch {
        if (generation === weekGeneration.current) setWeekError(t("meals.week.error"));
      } finally {
        if (generation === weekGeneration.current) setPending(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void loadRecipes("");
  }, [loadRecipes]);

  useEffect(() => {
    if (timezone === null || anchorDate !== null) return;
    const initial = todayInHouseholdTimezone(timezone);
    anchorRef.current = initial;
    setAnchorDate(initial);
    void loadWeek(initial);
  }, [anchorDate, loadWeek, timezone, weekStartDay]);

  const navigate = useCallback(
    (days: number) => {
      const current = anchorRef.current;
      if (!current) return;
      const next = addCalendarDays(current, days);
      anchorRef.current = next;
      setAnchorDate(next);
      void loadWeek(next);
    },
    [loadWeek]
  );

  const goPreviousWeek = useCallback(() => navigate(-7), [navigate]);
  const goNextWeek = useCallback(() => navigate(7), [navigate]);
  const goCurrentWeek = useCallback(() => {
    if (!timezone) return;
    const current = todayInHouseholdTimezone(timezone);
    anchorRef.current = current;
    setAnchorDate(current);
    void loadWeek(current);
  }, [loadWeek, timezone]);

  const retryWeek = useCallback(async () => {
    if (anchorRef.current) await loadWeek(anchorRef.current);
  }, [loadWeek]);

  const searchRecipes = useCallback(
    async (query: string) => {
      recipeQuery.current = query;
      await loadRecipes(query);
    },
    [loadRecipes]
  );

  const refreshAfterMutation = useCallback(
    async (refreshRecipesToo: boolean) => {
      const current = anchorRef.current;
      if (current) await loadWeek(current);
      if (refreshRecipesToo) await loadRecipes(recipeQuery.current);
      window.dispatchEvent(new Event(MEALS_CHANGED_EVENT));
    },
    [loadRecipes, loadWeek]
  );

  const mutateEntry = useCallback(
    async (url: string, method: string, input?: unknown) => {
      try {
        const response = await authFetch(
          url,
          input === undefined
            ? { method, credentials: "include" }
            : { ...requestInit(method, input), credentials: "include" }
        );
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        await refreshAfterMutation(false);
        return true;
      } catch {
        return false;
      }
    },
    [refreshAfterMutation]
  );

  const createEntry = useCallback(
    (input: MealEntryInput) => mutateEntry("/api/meal-entries", "POST", input),
    [mutateEntry]
  );
  const editEntry = useCallback(
    (id: string, input: MealEntryEditInput) =>
      mutateEntry(`/api/meal-entries/${encodeURIComponent(id)}`, "PATCH", input),
    [mutateEntry]
  );
  const deleteEntry = useCallback(
    (id: string) => mutateEntry(`/api/meal-entries/${encodeURIComponent(id)}`, "DELETE"),
    [mutateEntry]
  );

  const mutateRecipe = useCallback(
    async (url: string, method: string, input: unknown) => {
      try {
        const response = await authFetch(url, {
          ...requestInit(method, input),
          credentials: "include",
        });
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        await refreshAfterMutation(true);
        return true;
      } catch {
        return false;
      }
    },
    [refreshAfterMutation]
  );

  const createRecipe = useCallback(
    (input: RecipeInput) => mutateRecipe("/api/recipes", "POST", input),
    [mutateRecipe]
  );
  const editRecipe = useCallback(
    (id: string, input: RecipeEditInput) =>
      mutateRecipe(`/api/recipes/${encodeURIComponent(id)}`, "PATCH", input),
    [mutateRecipe]
  );

  const weekDates = useMemo(() => {
    if (weekMenu) return Object.keys(weekMenu);
    if (anchorDate !== null) return buildWeekDays(anchorDate, weekStartDay === 0 ? 0 : 1);
    return [];
  }, [anchorDate, weekMenu, weekStartDay]);

  return {
    anchorDate,
    weekDates,
    weekMenu,
    recipes,
    weekError,
    recipeError,
    pending,
    goPreviousWeek,
    goCurrentWeek,
    goNextWeek,
    retryWeek,
    searchRecipes,
    createEntry,
    editEntry,
    deleteEntry,
    createRecipe,
    editRecipe,
  };
}
