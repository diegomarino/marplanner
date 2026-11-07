import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { notifyPrintIntentEnqueued } from "@/printing/queueWakeup";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { primeCelebrationSound } from "./celebration-sound";
import { useTranslation } from "@/i18n";
import type { BoardChore, BoardColumn, CompletionInput, PeriodId } from "../../shared";

/** A member just finished every chore of one day period with their own tap. */
export interface PeriodCelebration {
  /** Increments per celebration, so a surface can key (and replace) its overlay. */
  id: number;
  memberId: string;
  periodId: PeriodId;
  date: string;
}

const CELEBRATED_KEY_PREFIX = "period-celebration";

/** Whether this period already celebrated in this browser session. Storage can be missing or
 * refuse access (private mode, quota); then every completion counts as new. */
function alreadyCelebrated(memberId: string, date: string, periodId: PeriodId): boolean {
  const key = `${CELEBRATED_KEY_PREFIX}:${memberId}:${date}:${periodId}`;
  try {
    if (window.sessionStorage.getItem(key) !== null) return true;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Fall through: celebrate rather than fail the completion.
  }
  return false;
}

function isPeriodComplete(
  columns: readonly BoardColumn[] | null,
  memberId: string,
  choreId: string
): { periodId: PeriodId; complete: boolean } | null {
  const period = columns
    ?.find((column) => column.memberId === memberId)
    ?.dayPeriods.find((candidate) => candidate.chores.some((chore) => chore.id === choreId));
  if (!period) return null;
  return {
    periodId: period.id,
    complete: period.chores.length > 0 && period.chores.every((chore) => chore.completed),
  };
}

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
  /** The latest celebration, or null. Only a completion tap that finishes a period sets it:
   * never a load, refetch, day rollover, uncompletion or an already celebrated period. */
  celebration: PeriodCelebration | null;
  dismissCelebration: () => void;
}

/** Shared public board read and completion state for the board and home surfaces. */
export function useTodayChores(forDate?: string): TodayChoresState {
  const { t } = useTranslation();
  const { timezone: householdTimezone, celebrationSound } = useHouseholdSettings();
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
  const [celebration, setCelebration] = useState<PeriodCelebration | null>(null);
  const generationRef = useRef(0);
  const columnsRef = useRef<BoardColumn[] | null>(null);
  const celebrationIdRef = useRef(0);

  const fetchBoard = useCallback(
    async (forDate: string, signal?: AbortSignal): Promise<BoardColumn[]> => {
      const generation = ++generationRef.current;
      const res = await authFetch(`/api/chores/board?date=${encodeURIComponent(forDate)}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error(`board: ${res.status}`);
      const data = (await res.json()) as BoardColumn[];
      if (generation === generationRef.current) {
        columnsRef.current = data;
        setColumns(data);
      }
      return data;
    },
    []
  );

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
      // The state the member saw when tapping, compared with the board after the write.
      const before =
        chore.completed || targetDate !== date
          ? null
          : isPeriodComplete(columnsRef.current, memberId, chore.id);
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
        const after = isPeriodComplete(await fetchBoard(targetDate), memberId, chore.id);
        if (
          before !== null &&
          !before.complete &&
          after?.complete === true &&
          after.periodId === before.periodId &&
          !alreadyCelebrated(memberId, targetDate, after.periodId)
        ) {
          setCelebration({
            id: ++celebrationIdRef.current,
            memberId,
            periodId: after.periodId,
            date: targetDate,
          });
        }
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
      if (chore.completed) {
        setConfirmTarget({ chore, memberId });
        return;
      }
      // Still inside the tap: a completion may turn into a celebration once the request and
      // refetch settle, and by then the browser may no longer allow audio to start.
      if (celebrationSound !== false) primeCelebrationSound();
      void toggleChore(chore, memberId);
    },
    [toggleChore, celebrationSound]
  );

  const dismissCelebration = useCallback(() => setCelebration(null), []);

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
    celebration,
    dismissCelebration,
  };
}
