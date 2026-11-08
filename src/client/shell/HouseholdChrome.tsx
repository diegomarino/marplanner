import { appUrl } from "@/lib/base-path";
import { isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { ChevronRight, House } from "lucide-react";

import { adminBreadcrumb, navigateAdmin } from "@/admin/AdminRoutes";
import { Button } from "@/components/ui/button";
import { WeatherPill } from "@/home/WeatherPill";
import { useT } from "@/i18n";
import { PrinterAttention } from "@/printing/PrinterAttention";
import { PluginHealthIndicator } from "@/plugins/PluginHealthIndicator";
import { PluginContribution, usePluginActive } from "@/plugins/contributions";
import { familyRoutes, navigateHousehold } from "./routes";

function isUnmodifiedPrimaryClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** An Options entry after Admin, e.g. a future "Print today's briefing". */
export interface OptionsEntry {
  id: string;
  render: () => ReactNode;
}

const NO_EXTRA_OPTIONS: readonly OptionsEntry[] = [];

/** Persistent presentation only; domain state and global services belong to their owners. */
export function HouseholdChrome({
  children,
  currentPath,
  showWeather,
  extraOptions = NO_EXTRA_OPTIONS,
}: {
  children: ReactNode;
  currentPath: string;
  showWeather: boolean;
  /** Entries shown after Admin. With none, the Options button is the Admin affordance itself
   * instead of a one-item menu. */
  extraOptions?: readonly OptionsEntry[];
}) {
  return (
    <HouseholdChromeContent
      currentPath={currentPath}
      showWeather={showWeather}
      extraOptions={extraOptions}
    >
      {children}
    </HouseholdChromeContent>
  );
}

function HouseholdChromeContent({
  children,
  currentPath,
  showWeather,
  extraOptions,
}: {
  children: ReactNode;
  currentPath: string;
  showWeather: boolean;
  extraOptions: readonly OptionsEntry[];
}) {
  const t = useT();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  const mealsActive = usePluginActive("meals-recipes");
  const { unlocked } = useAdminUnlock();
  // Once admin is unlocked the bar turns into the admin bar: a way home and where you are.
  // The locked PIN screen keeps the household bar, so the kiosk is never a dead end.
  const adminMode =
    (currentPath === "/admin" || currentPath.startsWith("/admin/")) &&
    (unlocked || isAdminPinBypassEnabled());

  const closeOptions = () => {
    setOptionsOpen(false);
    optionsTriggerRef.current?.focus();
  };

  const openAdmin = useCallback(() => {
    setOptionsOpen(false);
    // The locked PIN gate keeps this bar, so a second tap (or a double tap) lands here while
    // already on /admin. Pushing again would stack a history entry whose return path is /admin
    // and make Cancel lose the family route the parent came from.
    if (currentPath === "/admin" || currentPath.startsWith("/admin/")) return;
    window.history.pushState({ marplannerAdminReturnPath: currentPath }, "", appUrl("/admin"));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [currentPath]);

  // The Admin entry: the Options button itself while Admin is the only entry, otherwise the
  // first item of the Options menu. A plain activation (tap, click, Enter/Space, or a synthetic
  // AT click) opens the PIN gate; the PIN is the safeguard (ADR-034, ADR-013).
  const adminAffordanceProps = {
    "data-testid": "admin-affordance",
    onClick: openAdmin,
  };
  const adminIsOnlyOption = extraOptions.length === 0;

  useEffect(() => {
    if (!optionsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOptions();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [optionsOpen]);

  return (
    <>
      <header
        className="border-border bg-background min-h-[var(--control-height)] border-b px-4 py-2 shadow-sm"
        data-testid="household-menubar"
      >
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-3">
          {adminMode ? (
            <Button
              variant="ghost"
              size="icon"
              asChild
              aria-label={t("admin.topbar.home")}
              title={t("admin.topbar.home")}
            >
              <a
                href={appUrl("/")}
                data-testid="admin-topbar-home"
                onClick={(event) => {
                  if (!isUnmodifiedPrimaryClick(event)) return;
                  event.preventDefault();
                  navigateHousehold("/");
                }}
              >
                <House aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <nav
              aria-label={t("shell.nav.label")}
              className="flex min-w-0 max-w-full flex-wrap items-center gap-1"
              data-testid="household-nav"
            >
              {familyRoutes
                .filter((route) => !("pluginId" in route) || mealsActive)
                .map((route) => (
                  <Button key={route.id} variant="ghost" size="sm" asChild>
                    <a
                      href={appUrl(route.path)}
                      aria-current={currentPath === route.path ? "page" : undefined}
                      className="aria-[current=page]:bg-primary/10 aria-[current=page]:font-semibold"
                      onClick={(event) => {
                        // Preserve native open-in-new-tab/window behavior for modified clicks.
                        if (!isUnmodifiedPrimaryClick(event)) return;
                        event.preventDefault();
                        navigateHousehold(route.path);
                      }}
                    >
                      {t(route.label)}
                    </a>
                  </Button>
                ))}
            </nav>
          )}
          <div
            className="flex min-w-0 flex-1 items-center justify-center"
            data-testid="household-context"
          >
            {adminMode && <AdminBreadcrumb currentPath={currentPath} />}
            {showWeather && (
              <PluginContribution pluginId="weather" group="widgets" contributionId="weather-pill">
                <WeatherPill />
              </PluginContribution>
            )}
          </div>
          <div
            className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1"
            data-testid="household-actions"
          >
            <PluginContribution
              pluginId="printing"
              group="widgets"
              contributionId="printer-attention"
            >
              <PrinterAttention />
            </PluginContribution>
            <PluginHealthIndicator />
            {!adminMode && (
              <div className="relative">
                {adminIsOnlyOption ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    {...adminAffordanceProps}
                  >
                    {t("shell.options.label")}
                  </Button>
                ) : (
                  <Button
                    ref={optionsTriggerRef}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    aria-expanded={optionsOpen}
                    aria-controls={optionsId}
                    onClick={() => setOptionsOpen((open) => !open)}
                  >
                    {t("shell.options.label")}
                  </Button>
                )}
                {!adminIsOnlyOption && optionsOpen && (
                  <div
                    id={optionsId}
                    role="group"
                    aria-label={t("shell.options.label")}
                    className="bg-popover absolute right-0 z-10 mt-2 flex min-w-48 flex-col gap-2 rounded-md border p-2 shadow-md"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeOptions();
                      }
                    }}
                  >
                    {/* TODO(density): remount with persisted boot density and shell visibility tests;
                        see docs/development/style-guide.md#release-density-behavior. */}
                    <Button type="button" variant="outline" {...adminAffordanceProps}>
                      {t("shell.options.admin")}
                    </Button>
                    {extraOptions.map((entry) => (
                      <Fragment key={entry.id}>{entry.render()}</Fragment>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {children}
    </>
  );
}

/** "Admin > Section > Page" for the admin bar. Every step but the last is a link. */
function AdminBreadcrumb({ currentPath }: { currentPath: string }) {
  const t = useT();
  const trail = [
    { path: "/admin", label: t("admin.topbar.root") },
    ...adminBreadcrumb(currentPath).map(({ path, label }) => ({ path, label: t(label) })),
  ];
  return (
    <nav aria-label={t("admin.topbar.breadcrumb")} data-testid="admin-breadcrumb">
      <ol className="text-control m-0 flex list-none flex-wrap items-center gap-1 p-0">
        {trail.map((step, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={step.path} className="flex items-center gap-1">
              {index > 0 && (
                <ChevronRight aria-hidden="true" className="text-muted-foreground size-4" />
              )}
              {last ? (
                <span aria-current="page" className="font-semibold">
                  {step.label}
                </span>
              ) : (
                <a
                  href={appUrl(step.path)}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={(event) => {
                    if (!isUnmodifiedPrimaryClick(event)) return;
                    event.preventDefault();
                    navigateAdmin(step.path);
                  }}
                >
                  {step.label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function UnknownFamilyRoute() {
  const t = useT();
  return (
    <section className="p-6">
      <h1 className="text-xl font-bold">{t("shell.notFound.title")}</h1>
      <p className="text-muted-foreground">{t("shell.notFound.description")}</p>
    </section>
  );
}
