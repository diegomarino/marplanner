import { appUrl } from "@/lib/base-path";
import { isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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

const ADMIN_HOLD_MS = 3_000;

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

/** Persistent presentation only; domain state and global services belong to their owners. */
export function HouseholdChrome({
  children,
  currentPath,
  showWeather,
}: {
  children: ReactNode;
  currentPath: string;
  showWeather: boolean;
}) {
  return (
    <HouseholdChromeContent currentPath={currentPath} showWeather={showWeather}>
      {children}
    </HouseholdChromeContent>
  );
}

function HouseholdChromeContent({
  children,
  currentPath,
  showWeather,
}: {
  children: ReactNode;
  currentPath: string;
  showWeather: boolean;
}) {
  const t = useT();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  const mealsActive = usePluginActive("meals-recipes");
  const adminHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardHoldingRef = useRef(false);
  const [adminHolding, setAdminHolding] = useState(false);
  const { unlocked } = useAdminUnlock();
  // Once admin is unlocked the bar turns into the admin bar: a way home and where you are.
  // The locked PIN screen keeps the household bar, so the kiosk is never a dead end.
  const adminMode =
    (currentPath === "/admin" || currentPath.startsWith("/admin/")) &&
    (unlocked || isAdminPinBypassEnabled());

  const closeOptions = () => {
    if (adminHoldTimerRef.current) clearTimeout(adminHoldTimerRef.current);
    if (keyboardReleaseTimerRef.current) clearTimeout(keyboardReleaseTimerRef.current);
    adminHoldTimerRef.current = null;
    keyboardReleaseTimerRef.current = null;
    keyboardHoldingRef.current = false;
    setAdminHolding(false);
    setOptionsOpen(false);
    optionsTriggerRef.current?.focus();
  };

  const openAdmin = useCallback(() => {
    if (adminHoldTimerRef.current) clearTimeout(adminHoldTimerRef.current);
    if (keyboardReleaseTimerRef.current) clearTimeout(keyboardReleaseTimerRef.current);
    adminHoldTimerRef.current = null;
    keyboardReleaseTimerRef.current = null;
    keyboardHoldingRef.current = false;
    setAdminHolding(false);
    setOptionsOpen(false);
    window.history.pushState({ marplannerAdminReturnPath: currentPath }, "", appUrl("/admin"));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [currentPath]);

  const cancelAdminHold = useCallback(() => {
    if (adminHoldTimerRef.current) clearTimeout(adminHoldTimerRef.current);
    adminHoldTimerRef.current = null;
    setAdminHolding(false);
  }, []);

  const startAdminHold = useCallback(() => {
    if (adminHoldTimerRef.current) return;
    // Dev-only local bypass already unlocks the PIN gate; keep the affordance path
    // frictionless so local work does not wait the deliberate kiosk hold.
    if (isAdminPinBypassEnabled()) {
      openAdmin();
      return;
    }
    setAdminHolding(true);
    adminHoldTimerRef.current = setTimeout(openAdmin, ADMIN_HOLD_MS);
  }, [openAdmin]);

  useEffect(
    () => () => {
      cancelAdminHold();
      if (keyboardReleaseTimerRef.current) clearTimeout(keyboardReleaseTimerRef.current);
    },
    [cancelAdminHold]
  );

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
                {optionsOpen && (
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
                    <Button
                      type="button"
                      variant="outline"
                      className="relative isolate overflow-hidden"
                      data-testid="admin-affordance"
                      data-hold-state={adminHolding ? "holding" : "idle"}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        keyboardHoldingRef.current = false;
                        try {
                          event.currentTarget.setPointerCapture(event.pointerId);
                        } catch {
                          // Pointer capture is unavailable in jsdom and can be rejected by a
                          // browser for an already-cancelled pointer. The timer remains usable.
                        }
                        startAdminHold();
                      }}
                      onPointerUp={cancelAdminHold}
                      onPointerCancel={cancelAdminHold}
                      onLostPointerCapture={cancelAdminHold}
                      onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
                        if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
                        event.preventDefault();
                        keyboardHoldingRef.current = true;
                        startAdminHold();
                      }}
                      onKeyUp={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        cancelAdminHold();
                        keyboardReleaseTimerRef.current = setTimeout(() => {
                          keyboardHoldingRef.current = false;
                          keyboardReleaseTimerRef.current = null;
                        }, 0);
                      }}
                      onBlur={() => {
                        keyboardHoldingRef.current = false;
                        cancelAdminHold();
                      }}
                      onClick={(event) => {
                        if (event.detail !== 0 || keyboardHoldingRef.current) return;
                        openAdmin();
                      }}
                    >
                      <span className="relative z-10">{t("shell.options.admin")}</span>
                      <span
                        aria-hidden="true"
                        data-testid="admin-hold-progress"
                        data-progress-state={adminHolding ? "filling" : "idle"}
                        className={`bg-primary/25 absolute inset-x-0 bottom-0 h-1 origin-left transition-transform duration-[3000ms] ease-linear ${
                          adminHolding ? "scale-x-100" : "scale-x-0"
                        }`}
                      />
                    </Button>
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
