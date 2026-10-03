/** AdminPanel spec (FR-005 — Wiring/Accessibility).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AdminPanel } from "@/components/AdminPanel";
import { Button } from "@/components/ui/button";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("AdminPanel", () => {
  it("renders a landmark region whose aria-labelledby points at its own heading", () => {
    render(
      <AdminPanel title="Backups Management">
        <p>body</p>
      </AdminPanel>
    );
    const region = screen.getByRole("region", { name: "Backups Management" });
    const heading = screen.getByRole("heading", { name: "Backups Management" });
    expect(region).toHaveAttribute("aria-labelledby", heading.id);
    expect(heading.id).toBeTruthy();
  });

  it("renders the description under the title when provided", () => {
    render(
      <AdminPanel title="Backups Management" description="Manage household backups.">
        <p>body</p>
      </AdminPanel>
    );
    expect(screen.getByText("Manage household backups.")).toBeInTheDocument();
  });

  it("renders trailing actions beside the title", () => {
    render(
      <AdminPanel title="Backups Management" actions={<button type="button">Refresh</button>}>
        <p>body</p>
      </AdminPanel>
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("deliberate negative — two panels never collide on the same heading id", () => {
    render(
      <>
        <AdminPanel title="Panel One">
          <p>a</p>
        </AdminPanel>
        <AdminPanel title="Panel Two">
          <p>b</p>
        </AdminPanel>
      </>
    );
    const [regionOne, regionTwo] = screen.getAllByRole("region");
    expect(regionOne.getAttribute("aria-labelledby")).not.toBe(
      regionTwo.getAttribute("aria-labelledby")
    );
  });

  it("defaults to an h2 heading (correct for a panel nested inside a page with its own h1, e.g. MealsManagement)", () => {
    render(
      <AdminPanel title="Backups Management">
        <p>body</p>
      </AdminPanel>
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Backups Management" })
    ).toBeInTheDocument();
  });

 it("renders an h1 when headingLevel='h1' — for a panel that IS the page-level surface for a whole route ( review, PR #777, finding F6: CalendarView adopts this so /calendar has exactly one h1, matching ChoresBoard/MealsBoard/DailyBriefingView)", () => {
    render(
      <AdminPanel title="Calendar" headingLevel="h1">
        <p>body</p>
      </AdminPanel>
    );
    expect(screen.getByRole("heading", { level: 1, name: "Calendar" })).toBeInTheDocument();
  });

  it("meets kiosk density for a real control rendered inside it", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <AdminPanel title="Backups Management">
          <Button>Refresh</Button>
        </AdminPanel>
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
