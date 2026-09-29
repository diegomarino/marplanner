import * as React from "react";

import { cn } from "@/lib/utils";

/** L2 composed component (FR-005 — wiring and accessibility).
 * Every admin surface today repeats the same header shape by hand, e.g.
 * `admin/BackupsManagement.tsx`:
 * <section className="p-4" data-testid="...">
 * <h2 className="text-xl font-bold">{t("...title")}</h2>
 * <p className="text-sm text-gray-600 mb-4">{t("...description")}</p>
 *...
 * </section>
 * — with `text-gray-600` a raw scale-class debt item (SC-004) repeated per surface, and no
 * relationship at all between the heading and its container: a screen reader's landmark
 * navigation cannot jump to "Backups Management" as a region, because nothing marks the section
 * as one or points it at its own heading.
 * Admission test: * Wiring* — generates a stable id and links it from the container's
 * `aria-labelledby` to the heading, a relationship every one of ~13 admin surfaces would
 * otherwise have to invent (and today none do). * Accessibility* — `role="region"` turns that
 * link into a real landmark, not just a visual heading.
 */
export interface AdminPanelProps {
  /** Localized panel title (call-site-owned). */
  title: string;
  /** Localized panel description, rendered under the title. */
  description?: string;
  /** Trailing controls rendered beside the title (e.g. a refresh button). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Heading level for the panel's title. Defaults to `"h2"` — correct when this panel is NESTED
   * inside a page that already renders its own `<h1>` elsewhere (e.g. `MealsManagement`, opened
   * as an admin sub-panel inside `AdminGate`'s own menu, on top of a route — `/meals`,
   * `/chores`, … — whose own top-level surface already renders an `<h1>`).
   * Pass `"h1"` when this component IS the page-level surface for a whole kiosk route, mirroring
   * the `<h1>` every other top-level surface renders directly (`ChoresBoard`/`MealsBoard`/
   * `DailyBriefingView`). This also ensures `CalendarView`
   * is mounted exactly like those three — as the sole route content for `/calendar`, sibling to
   * `AdminGate`, not nested inside it — but rendered its title through `AdminPanel`'s `<h2>` with
   * no `<h1>` anywhere else on the page. A real browser DOM dump of `/calendar` showed
   * `HEADINGS = ["H2:Calendario"]` — zero `<h1>` elements on the page at all. Page-level callers
   * such as `CalendarView` should pass `headingLevel="h1"`; nested panels keep the `"h2"` default.
   */
  headingLevel?: "h1" | "h2";
  "data-testid"?: string;
}

export function AdminPanel({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = "h2",
  ...rest
}: AdminPanelProps) {
  const autoId = React.useId();
  const headingId = `admin-panel-${autoId}`;
  const Heading = headingLevel;

  return (
    <section
      role="region"
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-4 p-4", className)}
      {...rest}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Heading id={headingId} className="text-xl font-bold">
            {title}
          </Heading>
          {description && (
            <p className="text-muted-foreground text-[length:var(--control-font-size)]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
