import { appUrl } from "@/lib/base-path";
import { isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
/** How long the "hold to open" hint stays after a press released too early. */
const ADMIN_HOLD_HINT_MS = 2_500;

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
  const adminHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardHoldingRef = useRef(false);
  const [adminHolding, setAdminHolding] = useState(false);
  const holdHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holdHintVisible, setHoldHintVisible] = useState(false);
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

  const hideHoldHint = useCallback(() => {
    if (holdHintTimerRef.current) clearTimeout(holdHintTimerRef.current);
    holdHintTimerRef.current = null;
    setHoldHintVisible(false);
  }, []);

  // A press let go before the hold completed is a tap: say why nothing opened. A cancelled
  // pointer or a lost focus is not a tap, so those go straight to `cancelAdminHold`.
  const releaseAdminHold = useCallback(() => {
    if (adminHoldTimerRef.current) {
      if (holdHintTimerRef.current) clearTimeout(holdHintTimerRef.current);
      setHoldHintVisible(true);
      holdHintTimerRef.current = setTimeout(() => {
        holdHintTimerRef.current = null;
        setHoldHintVisible(false);
      }, ADMIN_HOLD_HINT_MS);
    }
    cancelAdminHold();
  }, [cancelAdminHold]);

  const startAdminHold = useCallback(() => {
    if (adminHoldTimerRef.current) return;
    hideHoldHint();
    // Dev-only local bypass already unlocks the PIN gate; keep the affordance path
    // frictionless so local work does not wait the deliberate kiosk hold.
    if (isAdminPinBypassEnabled()) {
      openAdmin();
      return;
    }
    setAdminHolding(true);
    adminHoldTimerRef.current = setTimeout(openAdmin, ADMIN_HOLD_MS);
  }, [hideHoldHint, openAdmin]);

  useEffect(
    () => () => {
      cancelAdminHold();
      if (keyboardReleaseTimerRef.current) clearTimeout(keyboardReleaseTimerRef.current);
      if (holdHintTimerRef.current) clearTimeout(holdHintTimerRef.current);
    },
    [cancelAdminHold]
  );

  // The long-press Admin entry: the Options button itself while Admin is the only entry,
  // otherwise the first item of the Options menu. Same hold, same testid either way.
  const adminAffordanceProps = {
    "data-testid": "admin-affordance",
    "data-hold-state": adminHolding ? "holding" : "idle",
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      keyboardHoldingRef.current = false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in jsdom and can be rejected by a
        // browser for an already-cancelled pointer. The timer remains usable.
      }
      startAdminHold();
    },
    onPointerUp: releaseAdminHold,
    onPointerCancel: cancelAdminHold,
    onLostPointerCapture: cancelAdminHold,
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      keyboardHoldingRef.current = true;
      startAdminHold();
    },
    onKeyUp: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      releaseAdminHold();
      keyboardReleaseTimerRef.current = setTimeout(() => {
        keyboardHoldingRef.current = false;
        keyboardReleaseTimerRef.current = null;
      }, 0);
    },
    onBlur: () => {
      keyboardHoldingRef.current = false;
      cancelAdminHold();
    },
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.detail !== 0 || keyboardHoldingRef.current) return;
      openAdmin();
    },
  };
  const adminHoldProgress = (
    <span
      aria-hidden="true"
      data-testid="admin-hold-progress"
      data-progress-state={adminHolding ? "filling" : "idle"}
      className={`bg-primary/25 absolute inset-x-0 bottom-0 h-1 origin-left transition-transform duration-[3000ms] ease-linear ${
        adminHolding ? "scale-x-100" : "scale-x-0"
      }`}
    />
  );
  // Under the Options button it floats over the page; inside the menu it is a line of its own.
  const adminHoldHint = (floating: boolean) =>
    holdHintVisible && (
      <span
        role="status"
        data-testid="admin-hold-hint"
        className={
          floating
            ? "bg-popover text-popover-foreground absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded-md border px-2 py-1 text-sm shadow-md"
            : "text-muted-foreground text-sm"
        }
      >
        {t("shell.options.holdHint")}
      </span>
    );
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
                    className="text-muted-foreground relative isolate overflow-hidden"
                    {...adminAffordanceProps}
                  >
                    <span className="relative z-10">{t("shell.options.label")}</span>
                    {adminHoldProgress}
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
                    <Button
                      type="button"
                      variant="outline"
                      className="relative isolate overflow-hidden"
                      {...adminAffordanceProps}
                    >
                      <span className="relative z-10">{t("shell.options.admin")}</span>
                      {adminHoldProgress}
                    </Button>
                    {adminHoldHint(false)}
                    {extraOptions.map((entry) => (
                      <Fragment key={entry.id}>{entry.render()}</Fragment>
                    ))}
                  </div>
                )}
                {adminIsOnlyOption && adminHoldHint(true)}
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
