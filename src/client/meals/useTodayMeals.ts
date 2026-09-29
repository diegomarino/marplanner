import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { useTranslation } from "@/i18n";
import type { MenuItem } from "../../shared";
import { MEALS_CHANGED_EVENT } from "./useMealsWorkspace";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

export interface TodayMealsState {
  items: MenuItem[] | null;
  error: string | null;
}

type FetchMenuResult =
  { status: "applied" } | { status: "stale" } | { status: "failed"; error: unknown };

/** Current household-day menu state shared by the full menu board and Home strip. */
export function useTodayMeals(): TodayMealsState {
  const { t } = useTranslation();
  const { timezone: householdTimezone } = useHouseholdSettings();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const generationRef = useRef(0);

  const fetchMenu = useCallback(
    async (forDate: string, signal?: AbortSignal): Promise<FetchMenuResult> => {
      const generation = ++generationRef.current;
      try {
        const res = await authFetch(`/api/menu?date=${encodeURIComponent(forDate)}`, {
          credentials: "include",
          signal,
        });
        if (generation !== generationRef.current) return { status: "stale" };
        if (!res.ok) return { status: "failed", error: new Error(`menu: ${res.status}`) };
        const data = (await res.json()) as MenuItem[];
        if (generation !== generationRef.current) return { status: "stale" };
        setItems(data);
        setError(null);
        return { status: "applied" };
      } catch (error) {
        return generation === generationRef.current
          ? { status: "failed", error }
          : { status: "stale" };
      }
    },
    []
  );

  useEffect(() => {
    if (householdTimezone === null) return;
    const controller = new AbortController();
    setTimezone(householdTimezone);
    const today = todayInTimezone(householdTimezone);
    void fetchMenu(today, controller.signal).then((result) => {
      if (result.status === "applied") setDate(today);
      if (result.status === "failed" && (result.error as Error).name !== "AbortError") {
        setError(t("meals.board.error"));
      }
    });
    return () => controller.abort();
  }, [householdTimezone, t, fetchMenu]);

  useEffect(() => {
    if (timezone === null) return;
    const interval = setInterval(() => {
      const today = todayInTimezone(timezone);
      if (today !== date) {
        void fetchMenu(today).then((result) => {
          if (result.status === "applied") setDate(today);
        });
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [timezone, date, fetchMenu]);

  useEffect(() => {
    if (date === null) return;
    const refresh = () => {
      void fetchMenu(date).then((result) => {
        if (result.status === "failed" && (result.error as Error).name !== "AbortError") {
          setError(t("meals.board.error"));
        }
      });
    };
    window.addEventListener(MEALS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MEALS_CHANGED_EVENT, refresh);
  }, [date, fetchMenu, t]);

  return { items, error };
}
