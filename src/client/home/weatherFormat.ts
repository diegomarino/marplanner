import type { ForecastHour } from "../../shared";

/** Slice the hourly forecast down to the CURRENT hour onward. Open-Meteo's
 * `hourly` block always starts at midnight of the requested day, so rendering the raw array
 * verbatim shows hours that already passed (at 21:45, the first 22 rows would be history).
 * `hour.time` is an ISO string with NO timezone suffix (household-tz-local, per the port's
 * `timezone=<household IANA>` request) — `new Date(...)` therefore parses it as LOCAL wall
 * time in whatever runtime evaluates it. The kiosk's own system clock IS the household's wall
 * clock (the same assumption the server-side pull-time fetch already relies on), so comparing
 * against the client's own `Date.now` this way needs no extra timezone math.
 */
export function sliceUpcomingHours(hourly: readonly ForecastHour[], nowMs: number): ForecastHour[] {
  const now = new Date(nowMs);
  const currentHourStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    0,
    0,
    0
  ).getTime();
  const index = hourly.findIndex((hour) => new Date(hour.time).getTime() >= currentHourStart);
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
