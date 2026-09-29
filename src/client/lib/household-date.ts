/** Returns the household's current business date. Callers obtain the IANA timezone from the
 * shared `useHouseholdSettings` context — MealsManagement is the one remaining
 * exception, still reading it via its own ad-hoc `/api/settings` GET (it has a user-facing
 * retry affordance the shared, non-retrying context can't support) — after the admin surface
 * has been unlocked.
 */
export function todayInHouseholdTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}
