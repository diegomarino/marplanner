export type WeekBand = "plain" | "shaded";

/**
 * Band of each date for the Messages zebra. A new week begins on every week-start day after the
 * first date, so the lead-in chunk (or the first full week) is always plain and bands then
 * alternate. `weekStartDay` is 0 (Sunday) or 1 (Monday); anything else, including null before
 * the household settings load, is treated as Monday.
 */
export function weekBands(
  dates: readonly string[],
  weekStartDay: number | null | undefined
): WeekBand[] {
  const startsOn = weekStartDay === 0 ? 0 : 1;
  let weeks = 0;
  return dates.map((date, index) => {
    if (index > 0 && new Date(`${date}T00:00:00Z`).getUTCDay() === startsOn) weeks += 1;
    return weeks % 2 === 1 ? "shaded" : "plain";
  });
}
