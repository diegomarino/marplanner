import { CalendarView } from "@/calendar/CalendarView";
import { ChoresBoard } from "@/chores/ChoresBoard";
import { HomeSurface } from "@/home/HomeSurface";
import { MealsBoard } from "@/meals/MealsBoard";
import type { PluginId } from "../../shared/plugins";

/** The complete family inventory; unknown paths never substitute Home. */
export const familyRoutes = [
  { id: "home", path: "/", label: "shell.nav.home", Component: HomeSurface },
  { id: "calendar", path: "/calendar", label: "shell.nav.calendar", Component: CalendarView },
  { id: "chores", path: "/chores", label: "shell.nav.tasks", Component: ChoresBoard },
  {
    id: "meals",
    path: "/meals",
    label: "shell.nav.meals",
    Component: MealsBoard,
    pluginId: "meals-recipes" as PluginId,
    contributionGroup: "routes" as const,
    contributionId: "meals-recipes-api",
  },
] as const;

// Destination identities; AdminShell owns the protected panel-to-destination mapping.
const adminDestinations = [
  { id: "calendar", path: "/admin/calendar" },
  { id: "member-create", path: "/admin" },
  { id: "members", path: "/admin/members" },
  { id: "day-periods", path: "/admin/day-periods" },
  { id: "routines", path: "/admin/routines" },
  { id: "reminders", path: "/admin/reminders" },
  { id: "meals", path: "/admin/meals" },
  { id: "daily-messages", path: "/admin/daily-messages" },
  { id: "daily-briefing", path: "/admin/daily-briefing" },
  { id: "telemetry", path: "/admin/telemetry" },
  { id: "backups", path: "/admin/backups" },
  { id: "time-announcements", path: "/admin/time-announcements" },
  { id: "weather", path: "/admin/weather" },
  { id: "network-devices", path: "/admin/network-devices" },
  { id: "plugins", path: "/admin/plugins" },
  { id: "printing", path: "/admin/printing" },
] as const;

type KnownHouseholdPath = FamilyRoute["path"] | (typeof adminDestinations)[number]["path"];

export type FamilyRoute = (typeof familyRoutes)[number];
export type HouseholdRoute =
  | ({ kind: "family" } & FamilyRoute)
  | ({ kind: "admin" } & (typeof adminDestinations)[number])
  | { kind: "unknown-admin"; path: string }
  | { kind: "unknown-family"; path: string };

/** Accepts a pathname, as supplied by location.pathname (not a URL or query string). */
export function resolveHouseholdRoute(path: string): HouseholdRoute {
  const family = familyRoutes.find((route) => route.path === path);
  if (family) return { kind: "family", ...family };
  const admin = adminDestinations.find((route) => route.path === path);
  if (admin) return { kind: "admin", ...admin };
  return { kind: path.startsWith("/admin/") ? "unknown-admin" : "unknown-family", path };
}

/** Keep the shell's existing popstate seam for same-document navigation and history. */
export function navigateHousehold(path: KnownHouseholdPath): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
