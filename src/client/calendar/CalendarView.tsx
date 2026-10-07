import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Temporal } from "temporal-polyfill";
import { useTranslation } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import { AdminPanel } from "@/components/AdminPanel";
import { CheckboxField } from "@/components/CheckboxField";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarMonthView } from "@/calendar/CalendarMonthView";
import { ScheduleXWeekView } from "@/calendar/ScheduleXWeekView";
import { memberFilterStyle } from "@/calendar/member-event-style";
import {
  addCalendarDays,
  buildCalendarDays,
  buildWeekDays,
  dateTimeLocalToUtcInstant,
  filterCalendarEvents,
  formatInstantAsDateTimeLocal,
  getHouseholdCalendarDate,
  presentationEventId,
  shiftCalendarPeriod,
  type CalendarMode,
  type WeekStartDay,
} from "@/calendar/calendar-presentation";
import type { AssignmentReplace, EventInput, FeedItem, Member } from "../../shared";

const DAY_MS = 24 * 60 * 60 * 1000;

export function CalendarView() {
  const { t, language } = useTranslation();
  const householdSettings = useHouseholdSettings();
  const timezone =
    householdSettings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<CalendarMode>("month");
  const [currentDate, setCurrentDate] = useState(() =>
    getHouseholdCalendarDate(Date.now(), timezone)
  );
  const [scrollToNowKey, setScrollToNowKey] = useState(0);
  const [showAllDay, setShowAllDay] = useState(true);
  const [selectedFilterMemberIds, setSelectedFilterMemberIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedEvent, setSelectedEvent] = useState<FeedItem | null>(null);

  useEffect(() => {
    setCurrentDate(getHouseholdCalendarDate(Date.now(), timezone));
  }, [timezone]);

  // Bounded instants inset ONE day inside the server's fixed −30d/+365d window
  // (boundary.ts rejects a range that reaches the exact edge; a date-only bound
  // maps to a tz midnight that can also fall outside). Instants dodge both.
  const range = useMemo(() => {
    const now = Date.now();
    return {
      from: new Date(now - 29 * DAY_MS).toISOString(),
      to: new Date(now + 364 * DAY_MS).toISOString(),
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    authFetch(
      `/api/calendar/events?source=all&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { signal: controller.signal, credentials: "include" }
    )
      .then((res) => {
        if (!res.ok) throw new Error(`calendar: ${res.status}`);
        return res.json() as Promise<FeedItem[]>;
      })
      .then((data) => setEvents(data))
      .catch((err: unknown) => {
        if ((err as Error).name !== "AbortError") setError(t("calendar.error"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [range, reloadKey, t]);

  const locale = language === "es" ? "es-ES" : "en-GB";

  const formatAllDay = (dateStr: string): string => {
    // YYYY-MM-DD → the literal calendar day, tz-neutral (parse + format as UTC so
    // a browser behind UTC never shifts it to the previous day).
    const d = new Date(`${dateStr}T00:00:00Z`);
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(d);
  };

  const formatTimed = (instant: string): string => {
    // A true UTC instant (ADR-062): place it in the household Calendar timezone.
    const d = new Date(instant);
    const day = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: timezone,
    }).format(d);
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: timezone,
    }).format(d);
    return `${day} ${time}`;
  };

  const renderWhen = (event: FeedItem): string => {
    if (event.allDay) {
      const start = formatAllDay(event.occurrenceStart);
      if (event.occurrenceEnd) {
        // occurrenceEnd is EXCLUSIVE (half-open). Show the inclusive last day, and
        // omit it entirely for a single-day event so it doesn't look like two days.
        const endExclusive = new Date(`${event.occurrenceEnd}T00:00:00Z`);
        endExclusive.setUTCDate(endExclusive.getUTCDate() - 1);
        const inclusiveEnd = endExclusive.toISOString().slice(0, 10);
        if (inclusiveEnd !== event.occurrenceStart) {
          return `${start} — ${formatAllDay(inclusiveEnd)}`;
        }
      }
      return start;
    }
    const start = formatTimed(event.occurrenceStart);
    return event.occurrenceEnd ? `${start} — ${formatTimed(event.occurrenceEnd)}` : start;
  };

  const [members, setMembers] = useState<Member[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingMembers(true);
    authFetch("/api/members", { signal: controller.signal, credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`members: ${res.status}`);
        return res.json() as Promise<Member[]>;
      })
      .then((data) => {
        setMembers(data);
        setMembersError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMembersError(t("calendar.errorLoadingMembers"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMembers(false);
      });
    return () => controller.abort();
  }, [t]);

  const activeMembers = useMemo(
    () => members.filter((member) => member.lifecycle === "active"),
    [members]
  );
  const filteredEvents = useMemo(
    () =>
      filterCalendarEvents(
        events,
        showAllDay,
        selectedFilterMemberIds,
        activeMembers.map((member) => member.id)
      ),
    [activeMembers, events, selectedFilterMemberIds, showAllDay]
  );

  const [showAssign, setShowAssign] = useState<string | null>(null);
  const [assignmentMemberIds, setAssignmentMemberIds] = useState<Set<string>>(new Set());
  const [updatingAssignment, setUpdatingAssignment] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);

  const [showEdit, setShowEdit] = useState<string | null>(null);
  const [editingEvent, setEditingEvent] = useState<FeedItem | null>(null);
  const [updatingEvent, setUpdatingEvent] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);

  const [fEditTitle, setFEditTitle] = useState("");
  const [fEditDate, setFEditDate] = useState("");
  const [fEditStart, setFEditStart] = useState("");
  const [fEditEnd, setFEditEnd] = useState("");

  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [deletingEvent, setDeletingEvent] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // --- inline Calendar authoring ------------------------------------------------
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [fTitle, setFTitle] = useState("");
  const [fAllDay, setFAllDay] = useState(true);
  const [fDate, setFDate] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");

  const resetAssignment = (): void => {
    setShowAssign(null);
    setAssignmentMemberIds(new Set());
    setAssignmentError(null);
  };

  const resetForm = (): void => {
    setFTitle("");
    setFAllDay(true);
    setFDate("");
    setFStart("");
    setFEnd("");
    setCreateError(null);
    resetAssignment();
  };

  const openAssign = (event: FeedItem): void => {
    setShowAssign(presentationEventId(event));
    setAssignmentMemberIds(new Set(event.assignedTo));
    setAssignmentError(null);
  };

  const openEdit = (event: FeedItem): void => {
    setShowEdit(`${event.id}@${event.occurrenceStart}`);
    setEditingEvent(event);
    setFEditTitle(event.title);
    if (event.allDay) {
      setFEditDate(event.occurrenceStart.slice(0, 10));
    } else {
      setFEditStart(formatInstantAsDateTimeLocal(event.occurrenceStart, timezone));
      if (event.occurrenceEnd) {
        setFEditEnd(formatInstantAsDateTimeLocal(event.occurrenceEnd, timezone));
      }
    }
    setEventError(null);
  };

  const openDeleteConfirm = (event: FeedItem): void => {
    setShowDeleteConfirm(`${event.id}@${event.occurrenceStart}`);
    setDeleteError(null);
  };

  const closeEdit = (): void => {
    setShowEdit(null);
    setEditingEvent(null);
    setFEditTitle("");
    setFEditDate("");
    setFEditStart("");
    setFEditEnd("");
    setEventError(null);
  };

  const closeDeleteConfirm = (): void => {
    setShowDeleteConfirm(null);
    setDeleteError(null);
  };

  const submitEdit = async (eventId: string): Promise<void> => {
    setUpdatingEvent(true);
    setEventError(null);

    const original = editingEvent;
    if (!original) {
      setEventError(t("calendar.deleteNoLongerAvailable"));
      closeEdit();
      setUpdatingEvent(false);
      return;
    }

    const payload: Partial<EventInput> = {};

    if (fEditTitle !== original.title) {
      payload.title = fEditTitle;
    }

    if (original.allDay) {
      const newDate = fEditDate !== original.occurrenceStart.slice(0, 10);
      if (newDate) {
        payload.startDate = fEditDate;
        const originalSpanDays = original.occurrenceEnd
          ? Temporal.PlainDate.from(original.occurrenceStart).until(
              Temporal.PlainDate.from(original.occurrenceEnd),
              { largestUnit: "day" }
            ).days
          : 1;
        payload.endDate = addCalendarDays(fEditDate, originalSpanDays);
      }
    } else {
      const originalStartLocal = formatInstantAsDateTimeLocal(original.occurrenceStart, timezone);
      if (fEditStart !== originalStartLocal) {
        payload.startUtc = dateTimeLocalToUtcInstant(fEditStart, timezone);
      }
      if (original.occurrenceEnd && fEditEnd) {
        const originalEndLocal = formatInstantAsDateTimeLocal(original.occurrenceEnd, timezone);
        if (fEditEnd !== originalEndLocal) {
          payload.endUtc = dateTimeLocalToUtcInstant(fEditEnd, timezone);
        }
      }
    }

    try {
      const res = await authFetch(`/api/calendar/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`edit: ${res.status}`);
      closeEdit();
      setReloadKey((k) => k + 1);
    } catch {
      setEventError(t("calendar.editError"));
    } finally {
      setUpdatingEvent(false);
    }
  };

  const submitDelete = async (eventId: string): Promise<void> => {
    setDeletingEvent(true);
    setDeleteError(null);
    try {
      const res = await authFetch(`/api/calendar/events/${eventId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`delete: ${res.status}`);
      closeDeleteConfirm();
      setReloadKey((k) => k + 1);
    } catch {
      setDeleteError(t("calendar.deleteError"));
    } finally {
      setDeletingEvent(false);
    }
  };

  const toggleMember = (memberId: string): void => {
    setAssignmentMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  };

  const submitAssignment = async (eventId: string): Promise<void> => {
    setUpdatingAssignment(true);
    setAssignmentError(null);
    const payload: AssignmentReplace = { memberIds: Array.from(assignmentMemberIds) };
    try {
      const res = await authFetch(`/api/calendar/events/${eventId}/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`assignment: ${res.status}`);
      resetAssignment();
      setReloadKey((k) => k + 1);
    } catch {
      setAssignmentError(t("calendar.assignmentError"));
    } finally {
      setUpdatingAssignment(false);
    }
  };

  const submitCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    let input: EventInput;
    if (fAllDay) {
      // Half-open single day: endDate = startDate + 1 (server rejects start == end).
      input = {
        title: fTitle,
        allDay: true,
        startDate: fDate,
        endDate: addCalendarDays(fDate, 1),
      };
    } else {
      input = {
        title: fTitle,
        allDay: false,
        startUtc: dateTimeLocalToUtcInstant(fStart, timezone),
        endUtc: dateTimeLocalToUtcInstant(fEnd, timezone),
        tzid: timezone,
      };
    }
    try {
      const res = await authFetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`create: ${res.status}`);
      resetForm();
      setShowCreate(false);
      setReloadKey((k) => k + 1);
    } catch {
      setCreateError(t("calendar.error"));
    } finally {
      setCreating(false);
    }
  };

  const weekStartDay: WeekStartDay = householdSettings.weekStartDay === 0 ? 0 : 1;
  const selectedPlainDate = Temporal.PlainDate.from(currentDate);
  const visibleDates =
    mode === "month"
      ? buildCalendarDays(selectedPlainDate.year, selectedPlainDate.month - 1, weekStartDay)
      : buildWeekDays(currentDate, weekStartDay);
  const formatCalendarDate = (date: string, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00.000Z`)
    );
  const periodTitle =
    mode === "month"
      ? formatCalendarDate(currentDate, { month: "long", year: "numeric" })
      : `${formatCalendarDate(visibleDates[0], {
          month: "short",
          day: "numeric",
        })} – ${formatCalendarDate(visibleDates[visibleDates.length - 1], {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`;
  const weekdayKeys =
    weekStartDay === 1
      ? (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const)
      : (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const);
  const weekdayLabels = weekdayKeys.map((key) => t(`calendar.weekday.${key}`));
  const today = getHouseholdCalendarDate(Date.now(), timezone);
  const supportedStart = addCalendarDays(today, -29);
  const supportedEnd = addCalendarDays(today, 364);

  const periodDate = (direction: -1 | 1): string =>
    shiftCalendarPeriod(currentDate, mode, direction);
  const periodIsSupported = (date: string): boolean => {
    const plainDate = Temporal.PlainDate.from(date);
    const dates =
      mode === "month"
        ? buildCalendarDays(plainDate.year, plainDate.month - 1, weekStartDay)
        : buildWeekDays(date, weekStartDay);
    return dates[0] >= supportedStart && dates[dates.length - 1] < supportedEnd;
  };
  const previousDate = periodDate(-1);
  const nextDate = periodDate(1);

  const toggleFilterMember = (memberId: string): void => {
    setSelectedFilterMemberIds((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  };

  const goToToday = (): void => {
    setCurrentDate(getHouseholdCalendarDate(Date.now(), timezone));
    setScrollToNowKey((value) => value + 1);
  };

  useEffect(() => {
    if (
      selectedEvent &&
      !filteredEvents.some(
        (event) => presentationEventId(event) === presentationEventId(selectedEvent)
      )
    ) {
      setSelectedEvent(null);
    }
  }, [filteredEvents, selectedEvent]);

  return (
    <AdminPanel
      title={t("calendar.title")}
      description={t("calendar.description")}
      // CalendarView is the page-level surface for the whole
      // `/calendar` route (mounted as sibling content to `AdminGate`, exactly like
      // `ChoresBoard`/`MealsBoard`/`DailyBriefingView` — see `AdminPanel`'s own `headingLevel` doc)
      // rather than a nested admin sub-panel (`MealsManagement`'s shape) — so it gets the page's
      // one `<h1>`, matching those three siblings instead of leaving `/calendar` with zero.
      headingLevel="h1"
      className="min-h-0"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-start justify-between gap-3 xl:flex-row xl:items-center">
          <h2
            className="text-2xl font-bold tracking-tight capitalize"
            data-testid="calendar-period-title"
          >
            {periodTitle}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="border-input flex overflow-hidden rounded-lg border">
              <Button
                variant="ghost"
                type="button"
                aria-pressed={mode === "month"}
                onClick={() => setMode("month")}
                className={cn(
                  "rounded-none px-4 font-medium",
                  mode === "month"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                )}
              >
                {t("calendar.month")}
              </Button>
              <Button
                variant="ghost"
                type="button"
                aria-pressed={mode === "week"}
                onClick={() => setMode("week")}
                className={cn(
                  "rounded-none px-4 font-medium",
                  mode === "week"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                )}
              >
                {t("calendar.week")}
              </Button>
            </div>
            <Button
              type="button"
              data-testid="calendar-create-btn"
              onClick={() => setShowCreate(true)}
            >
              <Plus />
              {t("calendar.newEvent")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("calendar.previousPeriod")}
              disabled={!periodIsSupported(previousDate)}
              onClick={() => setCurrentDate(previousDate)}
            >
              <ChevronLeft />
            </Button>
            <Button type="button" variant="outline" onClick={goToToday}>
              {t("calendar.today")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("calendar.nextPeriod")}
              disabled={!periodIsSupported(nextDate)}
              onClick={() => setCurrentDate(nextDate)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2" aria-label={t("calendar.filters")}>
          <label
            className={cn(
              "border-input inline-flex min-h-[var(--control-height)] cursor-pointer items-center gap-2 rounded-full border px-3 font-medium",
              showAllDay ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            {/* eslint-disable-next-line ui-policy/raw-controls -- Native checkbox is nested in the token-sized all-day filter label. */}
            <input
              type="checkbox"
              checked={showAllDay}
              onChange={(event) => setShowAllDay(event.target.checked)}
              className="size-[var(--control-height)] text-control accent-current"
            />
            {t("calendar.allDayFilter")}
          </label>
          {activeMembers.map((member) => {
            const checked = selectedFilterMemberIds.has(member.id);
            return (
              <label
                key={member.id}
                className={cn(
                  "border-input inline-flex min-h-[var(--control-height)] cursor-pointer items-center gap-2 rounded-full border px-3 font-medium",
                  !checked && "bg-muted text-muted-foreground"
                )}
                // eslint-disable-next-line ui-policy/debt -- Selected member identity is rendered through the generated semantic colour token.
                style={checked ? memberFilterStyle(member.colorKey) : undefined}
              >
                {/* eslint-disable-next-line ui-policy/raw-controls -- Native checkbox is nested in the token-sized all-day filter label. */}
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleFilterMember(member.id)}
                  className="size-[var(--control-height)] text-control"
                />
                {member.displayName}
              </label>
            );
          })}
        </div>
      </div>

      {showCreate ? (
        <div className="mb-2">
          <form
            onSubmit={submitCreate}
            className="flex max-w-[360px] flex-col gap-2 rounded-md border p-3"
          >
            <Label className="flex flex-col items-start gap-1.5">
              {t("calendar.createTitle")}
              <Input
                data-testid="calendar-create-title-input"
                value={fTitle}
                onChange={(e) => setFTitle(e.target.value)}
                placeholder={t("calendar.placeholderTitle")}
                required
              />
            </Label>
            <CheckboxField checked={fAllDay} onChange={setFAllDay} label={t("calendar.allDay")} />
            {fAllDay ? (
              <Label className="flex flex-col items-start gap-1.5">
                {t("calendar.startDate")}
                <Input
                  type="date"
                  value={fDate}
                  onChange={(e) => setFDate(e.target.value)}
                  required
                />
              </Label>
            ) : (
              <>
                <Label className="flex flex-col items-start gap-1.5">
                  {t("calendar.startTime")}
                  <Input
                    type="datetime-local"
                    value={fStart}
                    onChange={(e) => setFStart(e.target.value)}
                    required
                  />
                </Label>
                <Label className="flex flex-col items-start gap-1.5">
                  {t("calendar.endTime")}
                  <Input
                    type="datetime-local"
                    value={fEnd}
                    onChange={(e) => setFEnd(e.target.value)}
                    required
                  />
                </Label>
              </>
            )}
            <ErrorNotice message={createError} />
            <div className="flex gap-2">
              <Button type="submit" data-testid="calendar-create-submit" disabled={creating}>
                {creating ? t("calendar.creating") : t("calendar.createEvent")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  resetForm();
                  setShowCreate(false);
                }}
                disabled={creating}
              >
                {t("calendar.cancel")}
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {loading ? (
        <div className="text-muted-foreground">{t("calendar.loading")}</div>
      ) : error ? (
        <ErrorNotice message={error} />
      ) : (
        <>
          {mode === "month" ? (
            <CalendarMonthView
              currentDate={currentDate}
              events={filteredEvents}
              members={activeMembers}
              timezone={timezone}
              weekStartDay={weekStartDay}
              weekdayLabels={weekdayLabels}
              locale={locale}
              onEventClick={setSelectedEvent}
            />
          ) : (
            <ScheduleXWeekView
              key={`calendar-week-${currentDate}-${weekStartDay}-${timezone}`}
              selectedDate={currentDate}
              events={filteredEvents}
              members={activeMembers}
              timezone={timezone}
              weekStartDay={weekStartDay}
              onEventClick={setSelectedEvent}
              scrollToNowKey={scrollToNowKey}
            />
          )}
          {filteredEvents.length === 0 && (
            <div className="text-muted-foreground py-4 text-center">{t("calendar.noEvents")}</div>
          )}
          {selectedEvent && (
            <div
              className="bg-card flex flex-col gap-2 rounded-2xl border p-4 shadow-sm"
              data-testid="calendar-event-detail"
            >
              {[selectedEvent].map((event) => (
                <div key={presentationEventId(event)} className="rounded-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-semibold">{event.title}</div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedEvent(null)}
                    >
                      {t("calendar.close")}
                    </Button>
                  </div>
                  <div className="text-muted-foreground mt-1 text-sm">{renderWhen(event)}</div>
                  {event.source === "external" ? (
                    <p className="text-muted-foreground mt-2 text-sm">
                      {t("calendar.externalReadOnly")}
                    </p>
                  ) : (
                    <>
                      {showAssign === `${event.id}@${event.occurrenceStart}` ? (
                        <div className="bg-muted mt-2 rounded-md p-3">
                          <div className="flex flex-col gap-2">
                            {loadingMembers ? (
                              <div className="text-muted-foreground text-sm">
                                {t("calendar.loadingMembers")}
                              </div>
                            ) : membersError ? (
                              <ErrorNotice message={membersError} />
                            ) : (
                              <>
                                <div className="mb-1 text-xs font-semibold">
                                  {t("calendar.assignTo")}
                                </div>
                                <ul className="my-1 max-h-30 list-none overflow-y-auto p-0">
                                  {activeMembers.map((member) => (
                                    <li key={member.id} className="rounded-sm px-2 py-1">
                                      <CheckboxField
                                        checked={assignmentMemberIds.has(member.id)}
                                        onChange={() => toggleMember(member.id)}
                                        label={member.displayName}
                                        data-testid={`calendar-assign-member-${member.id}`}
                                        // removing the `<li
                                        // onClick>` (the FR-013 fix) shrank the tappable area from
                                        // the whole row (~1198px measured) to just the label's own
                                        // content width (~206px) — an ~83% reduction on a
                                        // wall-mounted kiosk. `w-full` restores a full-row hit area
                                        // on the (still correctly semantics-only) `<label>` itself,
                                        // and `cursor-pointer` restores the affordance the `<li>`'s
                                        // removed `onClick` used to imply. Deliberate: this is NOT
                                        // a re-add of the `<li>`'s onClick (the row container stays
                                        // inert; only the label — which already legitimately owns
                                        // activation — grows to fill it).
                                        className="w-full cursor-pointer"
                                      />
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </div>
                          <ErrorNotice message={assignmentError} className="mt-2" />
                          <div className="mt-2 flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              data-testid="calendar-assign-save-btn"
                              onClick={() => submitAssignment(event.id)}
                              disabled={updatingAssignment}
                            >
                              {updatingAssignment ? t("calendar.updating") : t("calendar.save")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={resetAssignment}
                              disabled={updatingAssignment}
                            >
                              {t("calendar.cancel")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="calendar-assign-btn"
                          className="mt-2"
                          onClick={() => openAssign(event)}
                        >
                          {event.assignedTo.length > 0
                            ? t("calendar.editAssignment")
                            : t("calendar.assignTo")}
                        </Button>
                      )}
                      {showEdit === `${event.id}@${event.occurrenceStart}` ? (
                        <div className="bg-muted mt-2 rounded-md p-3">
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              submitEdit(event.id);
                            }}
                            className="flex flex-col gap-2"
                          >
                            <Label className="flex flex-col items-start gap-1.5">
                              {t("calendar.editTitle")}
                              <Input
                                data-testid="calendar-edit-title-input"
                                value={fEditTitle}
                                onChange={(e) => setFEditTitle(e.target.value)}
                                placeholder={t("calendar.placeholderTitle")}
                                required
                              />
                            </Label>
                            {event.allDay ? (
                              <Label className="flex flex-col items-start gap-1.5">
                                {t("calendar.startDate")}
                                <Input
                                  type="date"
                                  value={fEditDate}
                                  onChange={(e) => setFEditDate(e.target.value)}
                                  required
                                />
                              </Label>
                            ) : (
                              <>
                                <Label className="flex flex-col items-start gap-1.5">
                                  {t("calendar.startTime")}
                                  <Input
                                    type="datetime-local"
                                    value={fEditStart}
                                    onChange={(e) => setFEditStart(e.target.value)}
                                    required
                                  />
                                </Label>
                                <Label className="flex flex-col items-start gap-1.5">
                                  {t("calendar.endTime")}
                                  <Input
                                    type="datetime-local"
                                    value={fEditEnd}
                                    onChange={(e) => setFEditEnd(e.target.value)}
                                    required
                                  />
                                </Label>
                              </>
                            )}
                            <ErrorNotice message={eventError} />
                            <div className="flex gap-2">
                              <Button
                                type="submit"
                                data-testid="calendar-edit-save-btn"
                                disabled={updatingEvent}
                              >
                                {updatingEvent ? t("calendar.updating") : t("calendar.save")}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={closeEdit}
                                disabled={updatingEvent}
                              >
                                {t("calendar.cancel")}
                              </Button>
                            </div>
                          </form>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="calendar-edit-btn"
                          className="mt-2"
                          onClick={() => openEdit(event)}
                        >
                          {t("calendar.edit")}
                        </Button>
                      )}
                      {showDeleteConfirm === `${event.id}@${event.occurrenceStart}` ? (
                        <div className="bg-destructive/10 border-destructive/40 mt-2 rounded-md border p-3">
                          <div className="flex flex-col gap-2">
                            <div className="text-sm">{t("calendar.deleteConfirm")}</div>
                            <ErrorNotice message={deleteError} />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                data-testid="calendar-delete-confirm-btn"
                                onClick={() => submitDelete(event.id)}
                                disabled={deletingEvent}
                              >
                                {deletingEvent ? t("calendar.deleting") : t("calendar.delete")}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={closeDeleteConfirm}
                                disabled={deletingEvent}
                              >
                                {t("calendar.cancel")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="calendar-delete-btn"
                          className="mt-2"
                          onClick={() => openDeleteConfirm(event)}
                        >
                          {t("calendar.delete")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </AdminPanel>
  );
}
