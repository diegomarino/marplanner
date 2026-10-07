import "temporal-polyfill/global";
import { useTranslation } from "@/i18n";
import type { CalendarEvent } from "@schedule-x/calendar";
import { createViewWeek } from "@schedule-x/calendar";
import { createCurrentTimePlugin } from "@schedule-x/current-time";
import { ScheduleXCalendar, useCalendarApp } from "@schedule-x/react";
import { useEffect, useMemo, useRef } from "react";
import { Temporal } from "temporal-polyfill";

import { memberEventStyle } from "@/calendar/member-event-style";
import {
  getHouseholdMinuteOfDay,
  presentationEventId,
  toScheduleXEvent,
  type WeekStartDay,
} from "@/calendar/calendar-presentation";
import type { FeedItem, Member } from "../../shared";
import "@schedule-x/theme-default/dist/index.css";
import "./schedule-x-overrides.css";

interface ScheduleXWeekViewProps {
  selectedDate: string;
  timezone: string;
  weekStartDay: WeekStartDay;
  events: readonly FeedItem[];
  members: readonly Member[];
  onEventClick: (event: FeedItem) => void;
  scrollToNowKey: number;
}

const GRID_HEIGHT = 1600;

function eventStyle(event: FeedItem | undefined, members: readonly Member[]) {
  if (!event) return {};
  return memberEventStyle(
    event.assignedTo.flatMap((memberId) => {
      const member = members.find(
        (candidate) => candidate.id === memberId && candidate.lifecycle === "active"
      );
      return member ? [member.colorKey] : [];
    })
  );
}

export function formatWeekEventTime(event: FeedItem | undefined, timezone: string): string | null {
  if (!event || event.allDay) return null;

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(event.occurrenceStart));
}

function EventContent({
  calendarEvent,
  event,
  members,
  timezone,
}: {
  calendarEvent: CalendarEvent;
  event: FeedItem | undefined;
  members: readonly Member[];
  timezone: string;
}) {
  // Schedule-X removes its wrapper just after updating the collection. During that brief
  // transition React can still render the old portal, while the current event map no longer
  // contains its event. Never attempt to derive a Date from that stale calendar payload.
  const time = formatWeekEventTime(event, timezone);
  return (
    <div
      className="member-event-surface sx-mp-event-content"
      data-testid="calendar-event-row"
      data-presentation-id={event ? presentationEventId(event) : String(calendarEvent.id)}
      // eslint-disable-next-line ui-policy/debt -- Dynamic assignment styling passes only semantic member-token CSS custom properties.
      style={eventStyle(event, members)}
    >
      {time && <div className="sx-mp-event-time">{time}</div>}
      <div className="sx-mp-event-title">{calendarEvent.title}</div>
    </div>
  );
}

export function ScheduleXWeekView(props: ScheduleXWeekViewProps) {
  const { language } = useTranslation();
  const locale = language === "es" ? "es-ES" : "en-GB";
  return <LocalizedWeekView key={locale} {...props} locale={locale} />;
}

function LocalizedWeekView({
  selectedDate,
  timezone,
  weekStartDay,
  events,
  members,
  onEventClick,
  scrollToNowKey,
  locale,
}: ScheduleXWeekViewProps & { locale: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const eventByIdRef = useRef(new Map<string, FeedItem>());
  const projected = useMemo(
    () => events.map((event) => toScheduleXEvent(event, timezone)),
    [events, timezone]
  );
  const initialProjectedRef = useRef(projected);
  eventByIdRef.current = new Map(
    projected.map((calendarEvent, index) => [String(calendarEvent.id), events[index]])
  );

  const config = useMemo(
    () => ({
      locale,
      selectedDate: Temporal.PlainDate.from(selectedDate),
      defaultView: "week",
      views: [createViewWeek()] as [ReturnType<typeof createViewWeek>],
      firstDayOfWeek: weekStartDay === 1 ? 1 : 7,
      timezone,
      dayBoundaries: { start: "00:00", end: "24:00" },
      callbacks: {
        onEventClick: (calendarEvent: CalendarEvent) => {
          const event = eventByIdRef.current.get(String(calendarEvent.id));
          if (event) onEventClick(event);
        },
      },
      events: initialProjectedRef.current,
    }),
    [selectedDate, weekStartDay, timezone, onEventClick, locale]
  );
  const plugins = useMemo(() => [createCurrentTimePlugin()], []);
  const calendarApp = useCalendarApp(config, plugins);
  const customComponents = useMemo(
    () => ({
      timeGridEvent: ({ calendarEvent }: { calendarEvent: CalendarEvent }) => (
        <EventContent
          calendarEvent={calendarEvent}
          event={eventByIdRef.current.get(String(calendarEvent.id))}
          members={members}
          timezone={timezone}
        />
      ),
      dateGridEvent: ({ calendarEvent }: { calendarEvent: CalendarEvent }) => (
        <EventContent
          calendarEvent={calendarEvent}
          event={eventByIdRef.current.get(String(calendarEvent.id))}
          members={members}
          timezone={timezone}
        />
      ),
    }),
    [members, timezone]
  );

  useEffect(() => {
    calendarApp?.events.set(projected);
  }, [calendarApp, projected]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    let timeoutId = 0;
    const startedAt = Date.now();
    const retryScroll = () => {
      if (Date.now() - startedAt < 2000) {
        timeoutId = window.setTimeout(() => {
          frame = window.requestAnimationFrame(scrollToCurrentTime);
        }, 50);
      }
    };
    const scrollToCurrentTime = () => {
      const viewport = root.querySelector<HTMLElement>(".sx__view-container");
      const grid = root.querySelector<HTMLElement>(".sx__week-grid");
      if (!viewport || !grid || viewport.scrollHeight <= viewport.clientHeight) {
        retryScroll();
        return;
      }
      const minute = getHouseholdMinuteOfDay(Date.now(), timezone);
      const focus =
        (minute / (24 * 60)) * (grid.clientHeight || GRID_HEIGHT) - viewport.clientHeight / 2;
      const target = Math.max(0, Math.min(focus, viewport.scrollHeight - viewport.clientHeight));
      if (Math.abs(viewport.scrollTop - target) > 2) {
        viewport.scrollTop = target;
        retryScroll();
      }
    };

    frame = window.requestAnimationFrame(scrollToCurrentTime);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeoutId);
    };
  }, [scrollToNowKey, selectedDate, timezone]);

  return (
    <div ref={rootRef} className="sx-week-embedded" data-testid="calendar-week-grid">
      <ScheduleXCalendar calendarApp={calendarApp} customComponents={customComponents} />
    </div>
  );
}
