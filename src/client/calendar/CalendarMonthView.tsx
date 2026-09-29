import type { CSSProperties } from "react";
import { Temporal } from "temporal-polyfill";

import { cn } from "@/lib/utils";
import { memberEventStyle } from "@/calendar/member-event-style";
import {
  buildCalendarDays,
  getCalendarRowCount,
  getEventsForCalendarDay,
  getHouseholdCalendarDate,
  presentationEventId,
  type WeekStartDay,
} from "@/calendar/calendar-presentation";
import type { FeedItem, Member } from "../../shared";

interface CalendarMonthViewProps {
  currentDate: string;
  events: readonly FeedItem[];
  members: readonly Member[];
  timezone: string;
  weekStartDay: WeekStartDay;
  weekdayLabels: readonly string[];
  locale: string;
  onEventClick: (event: FeedItem) => void;
}

function eventStyle(event: FeedItem, members: readonly Member[]): CSSProperties {
  return memberEventStyle(
    event.assignedTo.flatMap((memberId) => {
      const member = members.find(
        (candidate) => candidate.id === memberId && candidate.lifecycle === "active"
      );
      return member ? [member.colorKey] : [];
    })
  );
}

function formatTime(event: FeedItem, locale: string, timezone: string): string | null {
  if (event.allDay) return null;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(event.occurrenceStart));
}

export function CalendarMonthView({
  currentDate,
  events,
  members,
  timezone,
  weekStartDay,
  weekdayLabels,
  locale,
  onEventClick,
}: CalendarMonthViewProps) {
  const selectedDate = Temporal.PlainDate.from(currentDate);
  const year = selectedDate.year;
  const month = selectedDate.month - 1;
  const days = buildCalendarDays(year, month, weekStartDay);
  const rowCount = getCalendarRowCount(year, month, weekStartDay);
  const today = getHouseholdCalendarDate(Date.now(), timezone);

  return (
    <div
      className="bg-card flex min-h-[42rem] flex-1 flex-col overflow-x-auto rounded-3xl border shadow-sm"
      data-testid="calendar-month-grid"
    >
      <div className="bg-muted/40 grid min-w-3xl grid-cols-7 border-b">
        {weekdayLabels.map((label) => (
          <div
            key={label}
            role="columnheader"
            className="text-muted-foreground py-3 text-center text-xs font-semibold tracking-wider uppercase"
          >
            {label}
          </div>
        ))}
      </div>
      <div
        className={cn(
          "bg-border grid min-w-3xl flex-1 grid-cols-7 gap-px",
          rowCount === 5 ? "grid-rows-5" : "grid-rows-6"
        )}
      >
        {days.map((dateKey) => {
          const date = Temporal.PlainDate.from(dateKey);
          const dayEvents = getEventsForCalendarDay(events, dateKey, timezone);
          const isCurrentMonth = date.year === year && date.month === month + 1;
          const isToday = dateKey === today;
          return (
            <div
              key={dateKey}
              className={cn(
                "bg-card group/cell flex min-h-24 flex-col overflow-hidden p-2",
                !isCurrentMonth && "bg-muted/25 text-muted-foreground",
                isToday && "ring-primary/45 rounded-xl ring-4 ring-inset"
              )}
              data-date={dateKey}
              data-today={isToday ? "true" : undefined}
            >
              <span
                className={cn(
                  "mb-1 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                  isToday && "bg-primary text-primary-foreground shadow-sm"
                )}
              >
                {date.day}
              </span>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {dayEvents.map((event) => {
                  const time = formatTime(event, locale, timezone);
                  return (
                    <button
                      key={presentationEventId(event)}
                      type="button"
                      data-testid="calendar-event-row"
                      data-presentation-id={presentationEventId(event)}
                      onClick={() => onEventClick(event)}
                      className="member-event-surface focus:ring-primary min-h-[var(--control-height)] w-full cursor-pointer rounded-md border border-l-4 px-2 py-1.5 text-left text-[length:var(--control-font-size)] font-medium shadow-sm hover:brightness-95 focus:ring-2 focus:ring-offset-1 focus:outline-none"
                      // eslint-disable-next-line no-restricted-syntax -- Dynamic assignment styling passes only semantic member-token CSS custom properties.
                      style={eventStyle(event, members)}
                      title={event.title}
                    >
                      {time && (
                        <span className="mr-1.5 font-mono text-[10px] whitespace-nowrap opacity-75">
                          {time}
                        </span>
                      )}
                      <span className="leading-tight break-words whitespace-normal">
                        {event.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
