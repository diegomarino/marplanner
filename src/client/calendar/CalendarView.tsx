import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Temporal } from "temporal-polyfill";
import { useTranslation } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import { AdminPanel } from "@/components/AdminPanel";
import { CheckboxField } from "@/components/CheckboxField";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PillToggle } from "@/components/PillToggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CalendarMonthView } from "@/calendar/CalendarMonthView";
import { EventDescription } from "@/calendar/EventDescription";
import { memberFilterStyle } from "@/calendar/member-event-style";
import { ScheduleXWeekView } from "@/calendar/ScheduleXWeekView";
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

/** The event was created but its people could not be saved. */
class AssignmentAfterCreateError extends Error {}

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

  // A true UTC instant (ADR-062), placed in the household Calendar timezone. The zone itself is
  // not shown: every time on this screen is household time.
  const timedParts = (instant: string): { day: string; time: string } => {
    const d = new Date(instant);
    return {
      day: new Intl.DateTimeFormat(locale, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: timezone,
      }).format(d),
      time: new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
      }).format(d),
    };
  };

  const renderWhen = (event: FeedItem): string => {
    if (event.allDay) {
      const start = formatAllDay(event.occurrenceStart);
      if (event.occurrenceEnd) {
        // occurrenceEnd is EXCLUSIVE (half-open). Show the inclusive last day, and
        // omit it entirely for a single-day event so it doesn't look like two days.
        const inclusiveEnd = addCalendarDays(event.occurrenceEnd, -1);
        if (inclusiveEnd !== event.occurrenceStart) {
          return `${start} — ${formatAllDay(inclusiveEnd)}`;
        }
      }
      return start;
    }
    const start = timedParts(event.occurrenceStart);
    if (!event.occurrenceEnd || event.occurrenceEnd === event.occurrenceStart) {
      return `${start.day} ${start.time}`;
    }
    const end = timedParts(event.occurrenceEnd);
    return end.day === start.day
      ? `${start.day} ${start.time} — ${end.time}`
      : `${start.day} ${start.time} — ${end.day} ${end.time}`;
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

  const [showEdit, setShowEdit] = useState<string | null>(null);
  const [editingEvent, setEditingEvent] = useState<FeedItem | null>(null);
  const [updatingEvent, setUpdatingEvent] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);

  const [fEditTitle, setFEditTitle] = useState("");
  const [fEditDate, setFEditDate] = useState("");
  const [fEditStart, setFEditStart] = useState("");
  const [fEditEnd, setFEditEnd] = useState("");
  const [fEditLocation, setFEditLocation] = useState("");
  const [fEditDescription, setFEditDescription] = useState("");
  const [fEditAllDay, setFEditAllDay] = useState(true);
  const [fEditDateEnd, setFEditDateEnd] = useState("");
  const [editMemberIds, setEditMemberIds] = useState<Set<string>>(() => new Set());

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
  const [fDateEnd, setFDateEnd] = useState("");
  const [fLocation, setFLocation] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [createMemberIds, setCreateMemberIds] = useState<Set<string>>(() => new Set());

  const toggleCreateMember = (memberId: string): void => {
    setCreateMemberIds((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  };

  const resetForm = (): void => {
    setFTitle("");
    setFAllDay(true);
    setFDate("");
    setFStart("");
    setFEnd("");
    setFDateEnd("");
    setFLocation("");
    setFDescription("");
    setCreateMemberIds(new Set());
    setCreateError(null);
  };

  const openEdit = (event: FeedItem): void => {
    setShowEdit(`${event.id}@${event.occurrenceStart}`);
    setEditingEvent(event);
    setFEditTitle(event.title);
    setFEditLocation(event.location ?? "");
    setFEditDescription(event.description ?? "");
    setFEditAllDay(event.allDay);
    setEditMemberIds(new Set(event.assignedTo));
    if (event.allDay) {
      setFEditDate(event.occurrenceStart);
      // The form shows the last day; the stored end is the day after it.
      setFEditDateEnd(
        event.occurrenceEnd ? addCalendarDays(event.occurrenceEnd, -1) : event.occurrenceStart
      );
      setFEditStart("");
      setFEditEnd("");
    } else {
      setFEditStart(formatInstantAsDateTimeLocal(event.occurrenceStart, timezone));
      setFEditEnd(
        formatInstantAsDateTimeLocal(event.occurrenceEnd ?? event.occurrenceStart, timezone)
      );
      setFEditDate("");
      setFEditDateEnd("");
    }
    setEventError(null);
  };

  /** Switching shape in the edit form carries the day across, so the fields are never blank. */
  const changeEditAllDay = (allDay: boolean): void => {
    setFEditAllDay(allDay);
    if (allDay && !fEditDate) {
      const day = fEditStart.slice(0, 10);
      setFEditDate(day);
      setFEditDateEnd(fEditEnd.slice(0, 10) || day);
    }
    if (!allDay && !fEditStart && fEditDate) {
      setFEditStart(`${fEditDate}T09:00`);
      setFEditEnd(`${fEditDate}T10:00`);
    }
  };

  const toggleEditMember = (memberId: string): void => {
    setEditMemberIds((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
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
    setFEditLocation("");
    setFEditDescription("");
    setFEditDateEnd("");
    setEditMemberIds(new Set());
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

    try {
      const payload: Partial<EventInput> = {};

      if (fEditTitle !== original.title) {
        payload.title = fEditTitle;
      }
      if (fEditLocation.trim() !== (original.location ?? "")) {
        payload.location = fEditLocation;
      }
      if (fEditDescription.trim() !== (original.description ?? "")) {
        payload.description = fEditDescription;
      }

      // An emptied date field must fail here, as a conversion error, not reach the server.
      if (fEditAllDay) Temporal.PlainDate.from(fEditDate);
      const lastDay = fEditDateEnd && fEditDateEnd > fEditDate ? fEditDateEnd : fEditDate;
      if (fEditAllDay !== original.allDay) {
        // A new shape is sent whole; the server drops the old one.
        payload.allDay = fEditAllDay;
        if (fEditAllDay) {
          payload.startDate = fEditDate;
          payload.endDate = addCalendarDays(lastDay, 1);
        } else {
          payload.startUtc = dateTimeLocalToUtcInstant(fEditStart, timezone);
          payload.endUtc = dateTimeLocalToUtcInstant(fEditEnd, timezone);
          payload.tzid = timezone;
        }
      } else if (original.allDay) {
        const originalLastDay = original.occurrenceEnd
          ? addCalendarDays(original.occurrenceEnd, -1)
          : original.occurrenceStart;
        if (fEditDate !== original.occurrenceStart || lastDay !== originalLastDay) {
          payload.startDate = fEditDate;
          payload.endDate = addCalendarDays(lastDay, 1);
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

      const res = await authFetch(`/api/calendar/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`edit: ${res.status}`);

      const before = new Set(original.assignedTo);
      const peopleChanged =
        before.size !== editMemberIds.size || [...editMemberIds].some((id) => !before.has(id));
      if (peopleChanged) {
        const assignment: AssignmentReplace = { memberIds: Array.from(editMemberIds) };
        const assigned = await authFetch(`/api/calendar/events/${eventId}/assignments`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(assignment),
        });
        if (!assigned.ok) {
          // The other fields are saved; keep the form open on the people that were not.
          setEventError(t("calendar.assignmentError"));
          return;
        }
      }
      // Saving ends the visit: the summary behind the form still holds the pre-edit occurrence.
      closeEdit();
      setSelectedEvent(null);
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

  const submitCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      let input: EventInput;
      if (fAllDay) {
        // Half-open single day: endDate = startDate + 1 (server rejects start == end).
        input = {
          title: fTitle,
          allDay: true,
          startDate: fDate,
          // The form's end date is the last day shown; the stored end is exclusive.
          endDate: addCalendarDays(fDateEnd && fDateEnd > fDate ? fDateEnd : fDate, 1),
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
      if (fLocation.trim()) input.location = fLocation;
      if (fDescription.trim()) input.description = fDescription;
      const res = await authFetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`create: ${res.status}`);
      if (createMemberIds.size > 0) {
        const { id } = (await res.json()) as { id: string };
        const assignment: AssignmentReplace = { memberIds: Array.from(createMemberIds) };
        const assigned = await authFetch(`/api/calendar/events/${id}/assignments`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(assignment),
        });
        // The event exists either way; reload so it shows, and say the people were not saved.
        if (!assigned.ok) {
          setReloadKey((k) => k + 1);
          setCreateMemberIds(new Set());
          throw new AssignmentAfterCreateError();
        }
      }
      resetForm();
      setShowCreate(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (err instanceof AssignmentAfterCreateError) {
        resetForm();
        setShowCreate(false);
        setError(t("calendar.assignmentError"));
        return;
      }
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
      // Page-level surface for `/calendar`, so it owns the route's one `<h1>`; hidden because the
      // selected nav entry already says "Calendar".
      headingLevel="h1"
      headingHidden
      className="min-h-0"
    >
      <div className="flex flex-col gap-3">
        <h2
          className="text-2xl font-bold tracking-tight capitalize"
          data-testid="calendar-period-title"
        >
          {periodTitle}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2" aria-label={t("calendar.filters")}>
            <PillToggle
              checked={showAllDay}
              onChange={setShowAllDay}
              label={t("calendar.allDayFilter")}
            />
            {activeMembers.map((member) => (
              <PillToggle
                key={member.id}
                checked={selectedFilterMemberIds.has(member.id)}
                onChange={() => toggleFilterMember(member.id)}
                label={member.displayName}
              />
            ))}
          </div>
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
                    ? "bg-accent text-accent-foreground"
                    : "bg-background text-muted-foreground hover:bg-primary/10 hover:text-foreground"
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
                    ? "bg-accent text-accent-foreground"
                    : "bg-background text-muted-foreground hover:bg-primary/10 hover:text-foreground"
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
              <CalendarCheck />
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
      </div>

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (open || creating) return;
          resetForm();
          setShowCreate(false);
        }}
      >
        <DialogContent
          closeLabel={t("calendar.close")}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle className="text-2xl">{t("calendar.newEvent")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(event) => void submitCreate(event)} className="flex flex-col gap-4">
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
            <div className="grid gap-4 sm:grid-cols-2">
              {fAllDay ? (
                <>
                  <Label className="flex flex-col items-start gap-1.5">
                    {t("calendar.startDate")}
                    <Input
                      type="date"
                      value={fDate}
                      onChange={(e) => setFDate(e.target.value)}
                      required
                    />
                  </Label>
                  <Label className="flex flex-col items-start gap-1.5">
                    {t("calendar.endDate")}
                    <Input
                      type="date"
                      value={fDateEnd}
                      min={fDate || undefined}
                      onChange={(e) => setFDateEnd(e.target.value)}
                    />
                  </Label>
                </>
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
                      min={fStart || undefined}
                      onChange={(e) => setFEnd(e.target.value)}
                      required
                    />
                  </Label>
                </>
              )}
            </div>
            <CheckboxField checked={fAllDay} onChange={setFAllDay} label={t("calendar.allDay")} />
            <Label className="flex flex-col items-start gap-1.5">
              {t("calendar.location")}
              <Input
                value={fLocation}
                maxLength={300}
                onChange={(e) => setFLocation(e.target.value)}
                placeholder={t("calendar.addLocation")}
              />
            </Label>
            <Label className="flex flex-col items-start gap-1.5">
              {t("calendar.description")}
              <Textarea
                value={fDescription}
                maxLength={4000}
                rows={3}
                onChange={(e) => setFDescription(e.target.value)}
                placeholder={t("calendar.addDescription")}
              />
            </Label>
            {activeMembers.length > 0 && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-control mb-1.5 font-medium">
                  {t("calendar.participants")}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {activeMembers.map((member) => (
                    <PillToggle
                      key={member.id}
                      checked={createMemberIds.has(member.id)}
                      onChange={() => toggleCreateMember(member.id)}
                      label={member.displayName}
                      selectedStyle={memberFilterStyle(member.colorKey)}
                    />
                  ))}
                </div>
              </fieldset>
            )}
            <ErrorNotice message={createError} />
            <div className="grid grid-cols-2 gap-3">
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
              <Button type="submit" data-testid="calendar-create-submit" disabled={creating}>
                {creating ? t("calendar.creating") : t("calendar.createEvent")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

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
          <Dialog
            open={selectedEvent !== null}
            onOpenChange={(open) => {
              if (open) return;
              // Reopening an event must start from its summary, not a half-finished panel.
              closeEdit();
              closeDeleteConfirm();
              setSelectedEvent(null);
            }}
          >
            <DialogContent
              closeLabel={t("calendar.close")}
              // Anchored by its top edge: opening Edit or the delete confirmation then grows the
              // dialog downwards, where a centred one would shift its title and buttons.
              className="top-[12dvh] max-h-[calc(88dvh-1rem)] translate-y-0 overflow-y-auto"
              data-testid="calendar-event-detail"
            >
              {(selectedEvent ? [selectedEvent] : []).map((event) => (
                <div key={presentationEventId(event)} className="flex flex-col gap-3">
                  <DialogHeader>
                    <DialogTitle className="text-xl">{event.title}</DialogTitle>
                    <DialogDescription>{renderWhen(event)}</DialogDescription>
                  </DialogHeader>
                  {event.location && (
                    <p className="text-control flex items-start gap-2">
                      <MapPin className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      <span className="sr-only">{t("calendar.location")}: </span>
                      {event.location}
                    </p>
                  )}
                  {event.description && (
                    <EventDescription text={event.description} className="text-control" />
                  )}
                  {event.assignedTo.length > 0 && showEdit === null && (
                    <ul
                      className="flex list-none flex-wrap gap-2 p-0"
                      aria-label={t("calendar.participants")}
                    >
                      {activeMembers
                        .filter((member) => event.assignedTo.includes(member.id))
                        .map((member) => (
                          <li
                            key={member.id}
                            className="text-control rounded-full border px-3 py-1 font-medium"
                            // eslint-disable-next-line ui-policy/debt -- Member identity is rendered through the generated semantic colour token.
                            style={memberFilterStyle(member.colorKey)}
                          >
                            {member.displayName}
                          </li>
                        ))}
                    </ul>
                  )}
                  {event.source === "external" ? (
                    <p className="text-muted-foreground text-sm">
                      {t("calendar.externalReadOnly")}
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-start justify-end gap-2">
                      {showEdit === `${event.id}@${event.occurrenceStart}` ? (
                        <div className="bg-muted w-full rounded-2xl p-3">
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void submitEdit(event.id);
                            }}
                            className="flex flex-col gap-3"
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
                            <div className="grid gap-3 sm:grid-cols-2">
                              {fEditAllDay ? (
                                <>
                                  <Label className="flex flex-col items-start gap-1.5">
                                    {t("calendar.startDate")}
                                    <Input
                                      type="date"
                                      value={fEditDate}
                                      onChange={(e) => setFEditDate(e.target.value)}
                                      required
                                    />
                                  </Label>
                                  <Label className="flex flex-col items-start gap-1.5">
                                    {t("calendar.endDate")}
                                    <Input
                                      type="date"
                                      value={fEditDateEnd}
                                      min={fEditDate || undefined}
                                      onChange={(e) => setFEditDateEnd(e.target.value)}
                                    />
                                  </Label>
                                </>
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
                                      min={fEditStart || undefined}
                                      onChange={(e) => setFEditEnd(e.target.value)}
                                      required
                                    />
                                  </Label>
                                </>
                              )}
                            </div>
                            <CheckboxField
                              checked={fEditAllDay}
                              onChange={changeEditAllDay}
                              label={t("calendar.allDay")}
                            />
                            <Label className="flex flex-col items-start gap-1.5">
                              {t("calendar.location")}
                              <Input
                                value={fEditLocation}
                                maxLength={300}
                                onChange={(e) => setFEditLocation(e.target.value)}
                                placeholder={t("calendar.addLocation")}
                              />
                            </Label>
                            <Label className="flex flex-col items-start gap-1.5">
                              {t("calendar.description")}
                              <Textarea
                                value={fEditDescription}
                                maxLength={4000}
                                rows={3}
                                onChange={(e) => setFEditDescription(e.target.value)}
                                placeholder={t("calendar.addDescription")}
                              />
                            </Label>
                            <fieldset className="flex flex-col gap-1.5">
                              <legend className="text-control mb-1.5 font-medium">
                                {t("calendar.participants")}
                              </legend>
                              {loadingMembers ? (
                                <div className="text-muted-foreground text-sm">
                                  {t("calendar.loadingMembers")}
                                </div>
                              ) : membersError ? (
                                <ErrorNotice message={membersError} />
                              ) : (
                                <ul className="flex list-none flex-wrap gap-2 p-0">
                                  {activeMembers.map((member) => (
                                    <li key={member.id}>
                                      <PillToggle
                                        checked={editMemberIds.has(member.id)}
                                        onChange={() => toggleEditMember(member.id)}
                                        label={member.displayName}
                                        selectedStyle={memberFilterStyle(member.colorKey)}
                                        data-testid={`calendar-assign-member-${member.id}`}
                                      />
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </fieldset>
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
                          onClick={() => openEdit(event)}
                        >
                          <Pencil />
                          {t("calendar.edit")}
                        </Button>
                      )}
                      {showDeleteConfirm === `${event.id}@${event.occurrenceStart}` ? (
                        <div className="bg-destructive/10 border-destructive/40 w-full rounded-2xl border p-3">
                          <div className="flex flex-col gap-2">
                            <div className="text-sm">{t("calendar.deleteConfirm")}</div>
                            <ErrorNotice message={deleteError} />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                data-testid="calendar-delete-confirm-btn"
                                onClick={() => void submitDelete(event.id)}
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
                          onClick={() => openDeleteConfirm(event)}
                        >
                          <Trash2 />
                          {t("calendar.delete")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </DialogContent>
          </Dialog>
        </>
      )}
    </AdminPanel>
  );
}
