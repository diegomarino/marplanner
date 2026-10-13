import { appUrl, appPathname } from "@/lib/base-path";
import type { ComponentType } from "react";
import { Lock, Monitor, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { AdminOverview } from "./AdminOverview";
import { BackupsManagement } from "./BackupsManagement";
import { CalendarManagement } from "./CalendarManagement";
import { DailyBriefingManagement } from "./DailyBriefingManagement";
import { DailyMessagesManagement } from "./DailyMessagesManagement";
import { DayPeriodsManagement } from "./DayPeriodsManagement";
import { MealsManagement } from "./MealsManagement";
import { MemberCreateForm } from "./MemberCreateForm";
import { MembersManagement } from "./MembersManagement";
import { NetworkDevicesManagement } from "./NetworkDevicesManagement";
import { PrintingManagement } from "./PrintingManagement";
import { RemindersManagement } from "./RemindersManagement";
import { RoutinesManagement } from "./RoutinesManagement";
import { TelemetryManagement } from "./TelemetryManagement";
import { TimeAnnouncementsManagement } from "./TimeAnnouncementsManagement";
import { WeatherManagement } from "./WeatherManagement";
import { PluginManagement } from "@/plugins/PluginManagement";
import { PluginContribution, usePluginContributionActive } from "@/plugins/contributions";
import type { PluginId } from "../../shared/plugins";

type AdminRoute = {
  path: string;
  label: Parameters<ReturnType<typeof useT>>[0];
  testId: string;
  Component: ComponentType;
  pluginId?: PluginId;
  contributionId?: string;
};

/** The complete, ordered protected-capability inventory for the admin subtree. */
export const adminRoutes: readonly AdminRoute[] = [
  {
    path: "/admin/calendar",
    label: "admin.nav.calendar",
    testId: "admin-nav-calendar",
    Component: CalendarManagement,
  },
  {
    path: "/admin/members/new",
    label: "admin.nav.memberCreate",
    testId: "admin-nav-member-create",
    Component: MemberCreateForm,
  },
  {
    path: "/admin/members",
    label: "admin.nav.membersManagement",
    testId: "admin-nav-members-management",
    Component: MembersManagement,
  },
  {
    path: "/admin/day-periods",
    label: "admin.nav.dayPeriods",
    testId: "admin-nav-day-periods",
    Component: DayPeriodsManagement,
  },
  {
    path: "/admin/routines",
    label: "admin.nav.routinesManagement",
    testId: "admin-nav-routines-management",
    Component: RoutinesManagement,
  },
  {
    path: "/admin/reminders",
    label: "admin.nav.remindersManagement",
    testId: "admin-nav-reminders-management",
    Component: RemindersManagement,
    pluginId: "reminders",
    contributionId: "reminders",
  },
  {
    path: "/admin/meals",
    label: "admin.nav.mealsManagement",
    testId: "admin-nav-meals-management",
    Component: MealsManagement,
    pluginId: "meals-recipes",
    contributionId: "meals",
  },
  {
    path: "/admin/daily-messages",
    label: "admin.nav.dailyMessagesManagement",
    testId: "admin-nav-daily-messages-management",
    Component: DailyMessagesManagement,
    pluginId: "daily-messages",
    contributionId: "daily-messages",
  },
  {
    path: "/admin/daily-briefing",
    label: "admin.nav.dailyBriefingManagement",
    testId: "admin-nav-daily-briefing-management",
    Component: DailyBriefingManagement,
    pluginId: "daily-briefing",
    contributionId: "daily-briefing",
  },
  {
    path: "/admin/telemetry",
    label: "admin.nav.telemetry",
    testId: "admin-nav-telemetry",
    Component: TelemetryManagement,
  },
  {
    path: "/admin/backups",
    label: "admin.nav.backups",
    testId: "admin-nav-backups",
    Component: BackupsManagement,
    pluginId: "backups",
    contributionId: "backups",
  },
  {
    path: "/admin/time-announcements",
    label: "admin.nav.timeAnnouncements",
    testId: "admin-nav-time-announcements",
    Component: TimeAnnouncementsManagement,
    pluginId: "time-announcements",
    contributionId: "time-announcements",
  },
  {
    path: "/admin/weather",
    label: "admin.nav.weather",
    testId: "admin-nav-weather",
    Component: WeatherManagement,
    pluginId: "weather",
    contributionId: "weather",
  },
  {
    path: "/admin/network-devices",
    label: "admin.nav.networkDevices",
    testId: "admin-nav-network-devices",
    Component: NetworkDevicesManagement,
    pluginId: "network-devices",
    contributionId: "network-devices",
  },
  {
    path: "/admin/plugins",
    label: "admin.nav.plugins",
    testId: "admin-nav-plugins",
    Component: PluginManagement,
  },
  {
    path: "/admin/printing",
    label: "admin.nav.printing",
    testId: "admin-nav-printing",
    Component: PrintingManagement,
    pluginId: "printing",
    contributionId: "printing",
  },
];

export function navigateAdmin(path: string): void {
  if (appPathname() === path) return;
  window.history.pushState(null, "", appUrl(path));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const OVERVIEW_PATH = "/admin";

type SidebarItem = {
  path: string;
  label: AdminRoute["label"];
  Icon: LucideIcon;
  /** Subsections, shown under the item while it or one of them is open. */
  children?: readonly { path: string; label: AdminRoute["label"] }[];
};
type SidebarSection = { id: string; label?: AdminRoute["label"]; items: readonly SidebarItem[] };

/** The sidebar's sections, in order. A page gets an entry here once it has been redesigned;
 * until then it is reached from the overview's temporary list.
 */
export const adminSidebar: readonly SidebarSection[] = [
  {
    id: "general",
    items: [{ path: OVERVIEW_PATH, label: "admin.nav.overview", Icon: Monitor }],
  },
];

/** The trail for the admin top bar: every registered page on the way to `pathname`. */
export function adminBreadcrumb(pathname: string): { path: string; label: AdminRoute["label"] }[] {
  return adminRoutes
    .filter((route) => pathname === route.path || pathname.startsWith(`${route.path}/`))
    .sort((a, b) => a.path.length - b.path.length)
    .map(({ path, label }) => ({ path, label }));
}

function SidebarLink({
  path,
  label,
  current,
  nested,
  Icon,
}: {
  path: string;
  label: string;
  current: boolean;
  nested?: boolean;
  Icon?: LucideIcon;
}) {
  return (
    <a
      href={appUrl(path)}
      aria-current={current ? "page" : undefined}
      className={cn(
        "text-control text-muted-foreground hover:bg-primary/10 hover:text-foreground flex min-h-[var(--control-height)] items-center gap-3 rounded-xl px-3 font-medium",
        "aria-[current=page]:bg-primary/10 aria-[current=page]:text-foreground aria-[current=page]:font-semibold",
        nested && "ml-7"
      )}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateAdmin(path);
      }}
    >
      {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
      {label}
    </a>
  );
}

function AdminSidebar({ pathname, onLock }: { pathname: string; onLock: () => void }) {
  const t = useT();
  return (
    <aside
      data-testid="admin-sidebar"
      // Pinned beside the page on wide screens, so Lock stays reachable on a long page.
      className="bg-card flex shrink-0 flex-col gap-4 border-b p-3 lg:sticky lg:top-0 lg:h-[calc(100dvh-3.5rem)] lg:w-60 lg:self-start lg:border-r lg:border-b-0"
    >
      <nav aria-label={t("admin.sidebar.label")} className="flex flex-col gap-4">
        {adminSidebar.map((section) => (
          <div key={section.id} className="flex flex-col gap-1">
            {section.label && (
              <h2 className="text-muted-foreground px-3 text-xs font-semibold tracking-wider uppercase">
                {t(section.label)}
              </h2>
            )}
            {section.items.map((item) => {
              const open =
                pathname === item.path ||
                (item.children?.some((child) => child.path === pathname) ?? false);
              return (
                <div key={item.path} className="flex flex-col gap-1">
                  <SidebarLink
                    path={item.path}
                    label={t(item.label)}
                    Icon={item.Icon}
                    current={pathname === item.path}
                  />
                  {open &&
                    item.children?.map((child) => (
                      <SidebarLink
                        key={child.path}
                        path={child.path}
                        label={t(child.label)}
                        current={pathname === child.path}
                        nested
                      />
                    ))}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      <Button
        variant="ghost"
        className="text-muted-foreground justify-start gap-3 px-3 lg:mt-auto"
        data-testid="admin-lock-button"
        onClick={onLock}
      >
        <Lock aria-hidden="true" />
        {t("admin.nav.lock")}
      </Button>
    </aside>
  );
}

/** Every admin page as a button. Temporary: shown on the overview until the sidebar covers them. */
function AdminSectionLinks() {
  const t = useT();
  return (
    <>
      {adminRoutes.map((candidate) =>
        candidate.pluginId && candidate.contributionId ? (
          <PluginAdminNavigation key={candidate.path} route={candidate} />
        ) : (
          <Button
            key={candidate.path}
            variant="outline"
            data-testid={candidate.testId}
            onClick={() => navigateAdmin(candidate.path)}
          >
            {t(candidate.label)}
          </Button>
        )
      )}
    </>
  );
}

export function AdminRoutes({ pathname, onLock }: { pathname: string; onLock: () => void }) {
  const t = useT();
  const route = adminRoutes.find((candidate) => candidate.path === pathname);
  const Panel = route?.Component;

  return (
    <div className="flex w-full flex-col lg:min-h-[calc(100dvh-3.5rem)] lg:flex-row">
      <AdminSidebar pathname={pathname} onLock={onLock} />
      <div className="min-w-0 flex-1 p-4 lg:p-6">
        {pathname === OVERVIEW_PATH ? (
          <AdminOverview
            sections={<AdminSectionLinks />}
            onOpenTelemetry={() => navigateAdmin("/admin/telemetry")}
          />
        ) : !route || !Panel ? (
          <div className="flex w-full flex-col gap-4" data-testid="admin-route-not-found">
            <div>
              <h2 className="text-lg font-semibold">{t("admin.notFound.title")}</h2>
              <p className="text-muted-foreground">{t("admin.notFound.description")}</p>
            </div>
            <Button asChild variant="outline" className="self-start">
              <a
                href={appUrl(OVERVIEW_PATH)}
                onClick={(event) => {
                  event.preventDefault();
                  navigateAdmin(OVERVIEW_PATH);
                }}
              >
                {t("admin.nav.overview")}
              </a>
            </Button>
          </div>
        ) : route.pluginId && route.contributionId ? (
          <PluginContribution
            pluginId={route.pluginId}
            group="admin"
            contributionId={route.contributionId}
            direct
          >
            <Panel />
          </PluginContribution>
        ) : (
          <Panel />
        )}
      </div>
    </div>
  );
}

function PluginAdminNavigation({ route }: { route: AdminRoute }) {
  const t = useT();
  const active = usePluginContributionActive(route.pluginId!, "admin", route.contributionId!);
  if (!active) return null;
  return (
    <Button variant="outline" data-testid={route.testId} onClick={() => navigateAdmin(route.path)}>
      {t(route.label)}
    </Button>
  );
}
