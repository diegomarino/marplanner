import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AdminRoutes, adminRoutes } from "@/admin/AdminRoutes";

afterEach(cleanup);

describe("AdminRoutes", () => {
  it("renders the directly requested printing destination instead of the member-create default", () => {
    render(<AdminRoutes pathname="/admin/printing" onLock={() => {}} />);

    expect(screen.getByTestId("printing-management")).toBeInTheDocument();
    expect(screen.queryByText("Create Member")).not.toBeInTheDocument();
  });

  it("keeps the complete ordered fifteen-destination inventory", () => {
    expect(adminRoutes.map((route) => route.path)).toEqual([
      "/admin/calendar",
      "/admin/members/new",
      "/admin/members",
      "/admin/day-periods",
      "/admin/routines",
      "/admin/reminders",
      "/admin/meals",
      "/admin/daily-messages",
      "/admin/daily-briefing",
      "/admin/telemetry",
      "/admin/backups",
      "/admin/time-announcements",
      "/admin/weather",
      "/admin/network-devices",
      "/admin/plugins",
      "/admin/printing",
    ]);
  });

  it("shows the localized unknown-admin outcome without mounting a management panel", () => {
    render(<AdminRoutes pathname="/admin/not-a-route" onLock={() => {}} />);

    expect(screen.getByTestId("admin-route-not-found")).toHaveTextContent("Admin page not found");
    expect(
      within(screen.getByTestId("admin-route-not-found")).getByRole("link", { name: "Overview" })
    ).toHaveAttribute("href", "/admin");
    expect(screen.queryByTestId("printing-management")).not.toBeInTheDocument();
  });
});
