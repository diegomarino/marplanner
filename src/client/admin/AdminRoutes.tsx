import { appUrl, appPathname } from "@/lib/base-path";
import type { ComponentType } from "react";
import {
  Bell,
  CalendarDays,
  Clock,
  Database,
  ListChecks,
  Lock,
  MessageSquare,
  Monitor,
  Newspaper,
  Printer,
  Puzzle,
  ScrollText,
  Settings,
  Users,
  Utensils,
  Wifi,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { AdminOverview } from "./AdminOverview";
import { BackupsManagement } from "./BackupsManagement";
import { CalendarManagement } from "./CalendarManagement";
import { DailyBriefingManagement } from "./DailyBriefingManagement";
import { DailyMessagesManagement } from "./DailyMessagesManagement";
import { MealsManagement } from "./MealsManagement";
import { MembersManagement } from "./MembersManagement";
import { NetworkDevicesManagement } from "./NetworkDevicesManagement";
import { PrintingManagement } from "./PrintingManagement";
import { RemindersManagement } from "./RemindersManagement";
import { RoutinesManagement } from "./RoutinesManagement";
import { SettingsManagement } from "./SettingsManagement";
import { TelemetryManagement } from "./TelemetryManagement";
import { TimeAnnouncementsManagement } from "./TimeAnnouncementsManagement";
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
    path: "/admin/members",
    label: "admin.nav.membersManagement",
    testId: "admin-nav-members-management",
    Component: MembersManagement,
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
  {
    path: "/admin/settings",
    label: "admin.nav.settings",
    testId: "admin-nav-settings",
    Component: SettingsManagement,
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
  testId?: string;
  /** Subsections, shown under the item while it or one of them is open. */
  children?: readonly { path: string; label: AdminRoute["label"] }[];
};
type SidebarSection = { id: string; label?: AdminRoute["label"]; items: readonly SidebarItem[] };

/** The sidebar's sections, in order. */
export const adminSidebar: readonly SidebarSection[] = [
  {
    id: "general",
    items: [{ path: OVERVIEW_PATH, label: "admin.nav.overview", Icon: Monitor }],
  },
  {
    id: "household",
    label: "admin.sidebar.household",
    items: [
      { path: "/admin/members", label: "admin.sidebar.members", Icon: Users },
      { path: "/admin/network-devices", label: "admin.sidebar.networkDevices", Icon: Wifi },
      { path: "/admin/calendar", label: "admin.sidebar.calendar", Icon: CalendarDays },
      { path: "/admin/routines", label: "admin.sidebar.routines", Icon: ListChecks },
      { path: "/admin/time-announcements", label: "admin.sidebar.timeAnnouncements", Icon: Clock },
      { path: "/admin/meals", label: "admin.sidebar.meals", Icon: Utensils },
    ],
  },
  {
    id: "daily-briefing",
    label: "admin.sidebar.dailyBriefing",
    items: [
      { path: "/admin/daily-briefing", label: "admin.sidebar.briefing", Icon: Newspaper },
      { path: "/admin/daily-messages", label: "admin.sidebar.messages", Icon: MessageSquare },
      { path: "/admin/reminders", label: "admin.sidebar.reminders", Icon: Bell },
      { path: "/admin/printing", label: "admin.sidebar.printer", Icon: Printer },
    ],
  },
  {
    id: "system",
    label: "admin.sidebar.system",
    items: [
      { path: "/admin/settings", label: "admin.sidebar.settings", Icon: Settings },
      { path: "/admin/backups", label: "admin.sidebar.backups", Icon: Database },
      { path: "/admin/plugins", label: "admin.sidebar.plugins", Icon: Puzzle },
      { path: "/admin/telemetry", label: "admin.sidebar.logs", Icon: ScrollText },
    ],
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
  testId,
}: {
  path: string;
  label: string;
  current: boolean;
  nested?: boolean;
  Icon?: LucideIcon;
  testId?: string;
}) {
  return (
    <a
      href={appUrl(path)}
      aria-current={current ? "page" : undefined}
      data-testid={testId}
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

/** One sidebar item with its subsections. An entry owned by a plugin disappears with it. */
function SidebarEntry({ item, pathname }: { item: SidebarItem; pathname: string }) {
  const t = useT();
  const route = adminRoutes.find((candidate) => candidate.path === item.path);
  // The hook needs a contribution either way; a core page is always shown.
  const pluginActive = usePluginContributionActive(
    route?.pluginId ?? "printing",
    "admin",
    route?.contributionId ?? ""
  );
  if (route?.pluginId && route.contributionId && !pluginActive) return null;
  const open =
    pathname === item.path || (item.children?.some((child) => child.path === pathname) ?? false);
  return (
    <div className="flex flex-col gap-1">
      <SidebarLink
        path={item.path}
        label={t(item.label)}
        Icon={item.Icon}
        testId={item.testId ?? route?.testId}
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
}

export function AdminSidebar({
  pathname,
  onLock,
  sections = adminSidebar,
}: {
  pathname: string;
  onLock: () => void;
  /** The entries to draw; the registered sidebar unless a caller supplies its own. */
  sections?: readonly SidebarSection[];
}) {
  const t = useT();
  return (
    <aside
      data-testid="admin-sidebar"
      // Pinned beside the page on wide screens, so Lock stays reachable on a long page; a short
      // screen scrolls the list itself.
      className="bg-card flex shrink-0 flex-col gap-4 border-b p-3 lg:sticky lg:top-0 lg:h-[calc(100dvh-3.5rem)] lg:w-60 lg:self-start lg:overflow-y-auto lg:border-r lg:border-b-0"
    >
      <nav aria-label={t("admin.sidebar.label")} className="flex flex-col gap-4">
        {sections.map((section) => (
          <div key={section.id} className="flex flex-col">
            {section.label && (
              <h2 className="text-foreground px-3 pb-1 text-sm font-semibold">
                {t(section.label)}
              </h2>
            )}
            {section.items.map((item) => (
              <SidebarEntry key={item.path} item={item} pathname={pathname} />
            ))}
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

export function AdminRoutes({ pathname, onLock }: { pathname: string; onLock: () => void }) {
  const t = useT();
  const route = adminRoutes.find((candidate) => candidate.path === pathname);
  const Panel = route?.Component;

  return (
    <div className="flex w-full flex-col lg:min-h-[calc(100dvh-3.5rem)] lg:flex-row">
      <AdminSidebar pathname={pathname} onLock={onLock} />
      <div className="min-w-0 flex-1 p-4 lg:p-6">
        {pathname === OVERVIEW_PATH ? (
          <AdminOverview onOpenTelemetry={() => navigateAdmin("/admin/telemetry")} />
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
