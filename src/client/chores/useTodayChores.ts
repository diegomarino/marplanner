import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { notifyPrintIntentEnqueued } from "@/printing/queueWakeup";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { useTranslation } from "@/i18n";
import type { BoardChore, BoardColumn, CompletionInput } from "../../shared";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

export interface TodayChoresState {
  columns: BoardColumn[] | null;
  error: string | null;
  timezone: string | null;
  pending: ReadonlySet<string>;
  toggleError: string | null;
  confirmTarget: { chore: BoardChore; memberId: string } | null;
  requestToggle: (chore: BoardChore, memberId: string) => void;
  confirmUncomplete: () => void;
  closeConfirm: () => void;
}

/** Shared public board read and completion state for the board and home surfaces. */
export function useTodayChores(forDate?: string): TodayChoresState {
  const { t } = useTranslation();
  const { timezone: householdTimezone } = useHouseholdSettings();
  const [columns, setColumns] = useState<BoardColumn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    chore: BoardChore;
    memberId: string;
  } | null>(null);
  const generationRef = useRef(0);

  const fetchBoard = useCallback(async (forDate: string, signal?: AbortSignal): Promise<void> => {
    const generation = ++generationRef.current;
    const res = await authFetch(`/api/chores/board?date=${encodeURIComponent(forDate)}`, {
      credentials: "include",
      signal,
    });
    if (!res.ok) throw new Error(`board: ${res.status}`);
    const data = (await res.json()) as BoardColumn[];
    if (generation === generationRef.current) setColumns(data);
  }, []);

  useEffect(() => {
    if (householdTimezone === null) return;
    const controller = new AbortController();
    setTimezone(householdTimezone);
    const requestedDate = forDate ?? todayInTimezone(householdTimezone);
    setDate(requestedDate);
    fetchBoard(requestedDate, controller.signal).catch((err: unknown) => {
      if ((err as Error).name !== "AbortError") setError(t("chores.board.error"));
    });
    return () => controller.abort();
  }, [forDate, householdTimezone, t, fetchBoard]);

  useEffect(() => {
    if (timezone === null || forDate !== undefined) return;
    const interval = setInterval(() => {
      const today = todayInTimezone(timezone);
      if (today !== date) {
        setDate(today);
        void fetchBoard(today).catch(() => {});
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [forDate, timezone, date, fetchBoard]);

  const toggleChore = useCallback(
    async (chore: BoardChore, memberId: string): Promise<void> => {
      const targetDate = forDate ?? (timezone !== null ? todayInTimezone(timezone) : date);
      if (targetDate === null || pending.has(chore.id)) return;
      if (targetDate !== date) setDate(targetDate);
      setToggleError(null);
      setPending((prev) => new Set(prev).add(chore.id));
      try {
        const res = chore.completed
          ? await authFetch(
              `/api/chores/${chore.id}/completions?memberId=${encodeURIComponent(
                memberId
              )}&date=${encodeURIComponent(targetDate)}`,
              { method: "DELETE", credentials: "include" }
            )
          : await authFetch(`/api/chores/${chore.id}/completions`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ memberId, date: targetDate } satisfies CompletionInput),
            });
        if (!res.ok) throw new Error(`toggle: ${res.status}`);
        if (!chore.completed) notifyPrintIntentEnqueued();
        await fetchBoard(targetDate);
      } catch {
        setToggleError(t("chores.board.toggleError"));
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(chore.id);
          return next;
        });
      }
    },
    [forDate, timezone, date, pending, fetchBoard, t]
  );

  const requestToggle = useCallback(
    (chore: BoardChore, memberId: string) => {
      if (chore.completed) setConfirmTarget({ chore, memberId });
      else void toggleChore(chore, memberId);
    },
    [toggleChore]
  );

  const confirmUncomplete = useCallback(() => {
    if (confirmTarget) void toggleChore(confirmTarget.chore, confirmTarget.memberId);
  }, [confirmTarget, toggleChore]);

  return {
    columns,
    error,
    timezone,
    pending,
    toggleError,
    confirmTarget,
    requestToggle,
    confirmUncomplete,
    closeConfirm: () => setConfirmTarget(null),
  };
}
