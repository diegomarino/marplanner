import type { ForecastHour } from "../../shared";

/** Slice the hourly forecast down to the CURRENT household hour onward. Open-Meteo's
 * `hourly` block always starts at midnight of the requested day, so rendering the raw array
 * verbatim shows hours that already passed (at 21:45, the first 22 rows would be history).
 * `hour.time` is an offset-free household-local wall time (`YYYY-MM-DDTHH:mm`, per the port's
 * `timezone=<household IANA>` request), so it is compared as text with the current wall hour
 * in `timezone` — never parsed as browser-local time, since a kiosk's browser and the household
 * may be in different zones. A null `timezone` (no settings yet) falls back to the browser's.
 */
export function sliceUpcomingHours(
  hourly: readonly ForecastHour[],
  nowMs: number,
  timezone?: string | null
): ForecastHour[] {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(nowMs))
      .map((part) => [part.type, part.value])
  );
  const currentHour = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
  const index = hourly.findIndex((hour) => hour.time.slice(0, 13) >= currentHour);
  return index === -1 ? [] : hourly.slice(index);
}

/** `HH:mm` (24h) in the household language's locale conventions. */
export function formatHourLabel(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Short weekday + day-of-month (e.g. "Fri 5" / "vie 5") in the household language . `dateOnly` ("YYYY-MM-DD") is parsed as LOCAL midnight (appending "T00:00:00") rather
 * than the bare date-only form, which the JS `Date` constructor parses as UTC midnight — a
 * household west of UTC would otherwise see the PREVIOUS day's label.
 */
export function formatDayLabel(dateOnly: string, language: string): string {
  return new Intl.DateTimeFormat(language, { weekday: "short", day: "numeric" }).format(
    new Date(`${dateOnly}T00:00:00`)
  );
}
