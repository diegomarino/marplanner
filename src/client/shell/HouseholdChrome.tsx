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

import { Button } from "@/components/ui/button";
import { WeatherPill } from "@/home/WeatherPill";
import { useT } from "@/i18n";
import { PrinterAttention } from "@/printing/PrinterAttention";
import { PluginHealthIndicator } from "@/plugins/PluginHealthIndicator";
import { PluginContribution, usePluginActive } from "@/plugins/contributions";
import { DensityControl } from "./DensityControl";
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
    window.history.pushState({ marplannerAdminReturnPath: currentPath }, "", "/admin");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [currentPath]);

  const cancelAdminHold = useCallback(() => {
    if (adminHoldTimerRef.current) clearTimeout(adminHoldTimerRef.current);
    adminHoldTimerRef.current = null;
    setAdminHolding(false);
  }, []);

  const startAdminHold = useCallback(() => {
    if (adminHoldTimerRef.current) return;
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
                    href={route.path}
                    aria-current={currentPath === route.path ? "page" : undefined}
                    className="aria-[current=page]:bg-muted aria-[current=page]:font-semibold"
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
          <div
            className="flex min-w-0 flex-1 items-center justify-center"
            data-testid="household-context"
          >
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
                  <DensityControl />
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
          </div>
        </div>
      </header>
      {children}
    </>
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
