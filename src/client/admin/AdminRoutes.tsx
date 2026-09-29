import type { ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
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
    path: "/admin",
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

function navigateAdmin(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function AdminRoutes({ pathname, onLock }: { pathname: string; onLock: () => void }) {
  const t = useT();
  const route = adminRoutes.find((candidate) => candidate.path === pathname);

  if (!route) {
    return (
      <div className="flex w-full flex-col gap-4" data-testid="admin-route-not-found">
        <div>
          <h2 className="text-lg font-semibold">{t("admin.notFound.title")}</h2>
          <p className="text-muted-foreground">{t("admin.notFound.description")}</p>
        </div>
        <Button asChild variant="outline">
          <a
            href="/admin"
            onClick={(event) => {
              event.preventDefault();
              navigateAdmin("/admin");
            }}
          >
            {t("admin.nav.memberCreate")}
          </a>
        </Button>
        <Button variant="ghost" data-testid="admin-lock-button" onClick={onLock}>
          {t("admin.nav.lock")}
        </Button>
      </div>
    );
  }

  const Panel = route.Component;
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap gap-2">
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
        <Button variant="ghost" data-testid="admin-lock-button" onClick={onLock}>
          {t("admin.nav.lock")}
        </Button>
      </div>
      {route.pluginId && route.contributionId ? (
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
