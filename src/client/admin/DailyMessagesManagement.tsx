import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import type { Language } from "@/i18n/messages";
import { authFetch } from "@/lib/credential";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import type { DailyMessage, DailyMessageUpsert, Member } from "../../shared";

const WINDOW_DAYS = 14;
const MAX_TEXT_LEN = 500;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function buildDateWindow(from: string): string[] {
  if (!from) return [];
  return Array.from({ length: WINDOW_DAYS }, (_, index) => addDays(from, index));
}

function formatDateLabel(date: string, language: Language): string {
  const weekday = new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-US", {
    weekday: "long",
    timeZone: "UTC",
  })
    .format(new Date(`${date}T00:00:00Z`))
    .slice(0, 3);
  return `${date} ${weekday}`;
}

export function DailyMessagesManagement() {
  const { language, t } = useTranslation();
  const { timezone: householdTimezone } = useHouseholdSettings();
  const loadErrorMessage = t("dailyMessages.management.error");
  const saveErrorMessage = t("dailyMessages.management.saveError");
  const [activeMembers, setActiveMembers] = useState<Member[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [today, setToday] = useState("");
  const [windowFrom, setWindowFrom] = useState("");
  const [messagesList, setMessagesList] = useState<DailyMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [savingDates, setSavingDates] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState<"members" | "messages" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DailyMessage | null>(null);
  const loadRequestIdRef = useRef(0);
  const selectedMemberIdRef = useRef(selectedMemberId);

  selectedMemberIdRef.current = selectedMemberId;

  const dates = useMemo(() => buildDateWindow(windowFrom), [windowFrom]);
  const messagesByDate = useMemo(
    () => new Map(messagesList.map((message) => [message.date, message])),
    [messagesList]
  );

  useEffect(() => {
    if (householdTimezone === null) return;

    let cancelled = false;
    setLoadingMembers(true);
    setError(null);
    setLoadFailed(null);

    void (async () => {
      try {
        const today = todayInHouseholdTimezone(householdTimezone);
        const response = await authFetch("/api/members", { credentials: "include" });
        if (!response.ok) throw new Error("Failed to load members");
        const members = (await response.json()) as Member[];
        if (cancelled) return;

        const active = members.filter((member) => member.lifecycle === "active");
        setToday(today);
        setWindowFrom(today);
        setActiveMembers(active);
        setSelectedMemberId((current) => current || active[0]?.id || "");
      } catch {
        if (!cancelled) {
          setError(loadErrorMessage);
          setLoadFailed("members");
        }
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [householdTimezone, loadErrorMessage, reloadKey]);

  useEffect(() => {
    if (!selectedMemberId || !windowFrom) {
      setMessagesList([]);
      setDrafts({});
      return;
    }

    const requestId = ++loadRequestIdRef.current;
    const memberId = selectedMemberId;
    const dateWindow = buildDateWindow(windowFrom);
    setLoadingMessages(true);
    setError(null);
    setLoadFailed(null);
    setMessagesList([]);
    setDrafts({});

    void (async () => {
      try {
        const params = new URLSearchParams({
          memberId,
          from: windowFrom,
          days: String(WINDOW_DAYS),
        });
        const response = await authFetch(`/api/daily-messages?${params.toString()}`, {
          credentials: "include",
        });
        if (!response.ok) throw new Error("Failed to load messages");
        const messages = (await response.json()) as DailyMessage[];
        if (requestId !== loadRequestIdRef.current) return;

        const loadedByDate = new Map(messages.map((message) => [message.date, message.text]));
        setMessagesList(messages);
        setDrafts(
          Object.fromEntries(dateWindow.map((date) => [date, loadedByDate.get(date) ?? ""]))
        );
      } catch {
        if (requestId === loadRequestIdRef.current) {
          setError(loadErrorMessage);
          setLoadFailed("messages");
        }
      } finally {
        if (requestId === loadRequestIdRef.current) setLoadingMessages(false);
      }
    })();
  }, [loadErrorMessage, selectedMemberId, windowFrom, reloadKey]);

  async function saveMessage(date: string) {
    const memberId = selectedMemberId;
    const text = drafts[date] ?? "";
    const existing = messagesByDate.get(date);

    if (!text.trim()) {
      if (existing) setDrafts((current) => ({ ...current, [date]: existing.text }));
      return;
    }
    if (text === existing?.text || savingDates.has(date)) return;

    setSavingDates((current) => new Set(current).add(date));
    setError(null);
    try {
      const input: DailyMessageUpsert = { memberId, date, text };
      const response = await authFetch("/api/daily-messages", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Failed to save message");
      const saved = (await response.json()) as DailyMessage;
      if (selectedMemberIdRef.current !== memberId) return;

      setMessagesList((current) => [...current.filter((message) => message.date !== date), saved]);
      setDrafts((current) => ({ ...current, [date]: saved.text }));
    } catch {
      if (selectedMemberIdRef.current === memberId) {
        setError(saveErrorMessage);
      }
    } finally {
      setSavingDates((current) => {
        const next = new Set(current);
        next.delete(date);
        return next;
      });
    }
  }

  function navigateWindow(days: number) {
    if (!today || !windowFrom) return;
    const target = addDays(windowFrom, days);
    const boundedTarget = target < today ? today : target;
    if (boundedTarget === windowFrom) return;

    setLoadingMessages(true);
    setMessagesList([]);
    setDrafts({});
    setWindowFrom(boundedTarget);
  }

  async function deleteMessage(message: DailyMessage) {
    setError(null);
    try {
      const params = new URLSearchParams({ memberId: message.memberId, date: message.date });
      const response = await authFetch(`/api/daily-messages?${params.toString()}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to delete message");
      if (selectedMemberIdRef.current !== message.memberId) return;

      setMessagesList((current) => current.filter((candidate) => candidate.date !== message.date));
      setDrafts((current) => ({ ...current, [message.date]: "" }));
    } catch {
      if (selectedMemberIdRef.current === message.memberId) {
        setError(t("dailyMessages.management.deleteError"));
      }
    }
  }

  return (
    <AdminPanel
      title={t("dailyMessages.management.title")}
      description={t("dailyMessages.management.description")}
      data-testid="daily-messages-management"
    >
      {loadingMembers && (
        <p className="text-muted-foreground">{t("dailyMessages.management.loading")}</p>
      )}

      <ErrorNotice message={error} data-testid="daily-messages-error" />

      {loadFailed && (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          data-testid="daily-messages-retry"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          {t("dailyMessages.management.retry")}
        </Button>
      )}

      {!loadingMembers &&
        loadFailed !== "members" &&
        (activeMembers.length === 0 ? (
          <p className="text-muted-foreground" data-testid="daily-messages-no-members">
            {t("dailyMessages.management.noActiveMembers")}
          </p>
        ) : (
          <div className="max-w-2xl space-y-4">
            <Field label={t("dailyMessages.management.selectMember")}>
              <select
                value={selectedMemberId}
                data-testid="daily-messages-select-member"
                onChange={(event) => {
                  if (event.target.value === selectedMemberId) return;
                  setLoadingMessages(true);
                  setMessagesList([]);
                  setDrafts({});
                  setSelectedMemberId(event.target.value);
                }}
                className={NATIVE_SELECT_CLASSES}
              >
                {activeMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </Field>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                data-testid="daily-messages-previous-window"
                disabled={loadingMessages || !today || windowFrom <= today}
                onClick={() => navigateWindow(-WINDOW_DAYS)}
              >
                <ChevronLeft aria-hidden="true" />
                {t("dailyMessages.management.previousWindow")}
              </Button>
              <p
                className="text-muted-foreground font-mono text-sm"
                data-testid="daily-messages-window-range"
                aria-live="polite"
              >
                {dates.length > 0 ? `${dates[0]} – ${dates[dates.length - 1]}` : ""}
              </p>
              <Button
                type="button"
                variant="outline"
                data-testid="daily-messages-next-window"
                disabled={loadingMessages}
                onClick={() => navigateWindow(WINDOW_DAYS)}
              >
                {t("dailyMessages.management.nextWindow")}
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>

            {loadingMessages ? (
              <p className="text-muted-foreground">{t("dailyMessages.management.loading")}</p>
            ) : loadFailed === "messages" ? null : (
              <ul className="space-y-2">
                {dates.map((date) => {
                  const existing = messagesByDate.get(date);
                  const saving = savingDates.has(date);
                  const inputId = `daily-messages-text-${date}`;

                  return (
                    <li
                      key={`${selectedMemberId}-${date}`}
                      className="flex items-start gap-3 rounded-lg border border-transparent px-2 py-1 transition-colors focus-within:border-border focus-within:bg-card"
                      data-testid={`daily-messages-day-${date}`}
                    >
                      <label
                        htmlFor={inputId}
                        className="text-muted-foreground w-32 shrink-0 pt-2 font-mono text-xs"
                      >
                        {formatDateLabel(date, language)}
                      </label>
                      <Textarea
                        id={inputId}
                        aria-label={formatDateLabel(date, language)}
                        data-testid={inputId}
                        value={drafts[date] ?? ""}
                        placeholder="---"
                        rows={1}
                        maxLength={MAX_TEXT_LEN}
                        disabled={saving}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [date]: event.target.value }))
                        }
                        onFocus={(event) => {
                          event.currentTarget.rows = 3;
                        }}
                        onBlur={(event) => {
                          event.currentTarget.rows = 1;
                          void saveMessage(date);
                        }}
                        className="flex-1 resize-none"
                      />
                      {existing && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          data-testid={`daily-messages-delete-${date}`}
                          aria-label={`${t("dailyMessages.action.delete")} ${date}`}
                          onClick={() => setDeleteTarget(existing)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("dailyMessages.action.deleteConfirm")}
        confirmLabel={t("dailyMessages.action.delete")}
        cancelLabel={t("dailyMessages.action.cancel")}
        onConfirm={() => {
          if (deleteTarget) void deleteMessage(deleteTarget);
        }}
        confirmTestId="daily-messages-delete-confirm"
        cancelTestId="daily-messages-delete-cancel"
      />
    </AdminPanel>
  );
}
