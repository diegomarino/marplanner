import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import { HouseholdChrome } from "@/shell/HouseholdChrome";
import { AdminUnlockProvider } from "@/lib/adminUnlock";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("HouseholdChrome — Options menu", () => {
  it("opens a menu holding Admin and every extra entry once there is more than one", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ plugins: [] })))
    );
    render(
      <PluginCatalogProvider>
        <HouseholdChrome
          currentPath="/"
          showWeather={false}
          extraOptions={[{ id: "print", render: () => <button type="button">Print</button> }]}
        >
          <main />
        </HouseholdChrome>
      </PluginCatalogProvider>
    );

    const options = screen.getByRole("button", { name: "Options" });
    expect(options).not.toHaveAttribute("data-testid", "admin-affordance");
    expect(options).toHaveAttribute("aria-expanded", "false");
    expect(options).toHaveAttribute("aria-controls");
    fireEvent.click(options);

    const panel = screen.getByRole("group", { name: "Options" });
    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAttribute("id", options.getAttribute("aria-controls"));
    const admin = within(panel).getByRole("button", { name: "Admin" });
    expect(admin).toHaveAttribute("data-testid", "admin-affordance");
    expect(Array.from(panel.querySelectorAll("button, a"))).toEqual([
      admin,
      within(panel).getByRole("button", { name: "Print" }),
    ]);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Options" })).not.toBeInTheDocument();
    expect(options).toHaveFocus();

    fireEvent.click(options);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Options" })).not.toBeInTheDocument();
  });

  describe("the Admin affordance", () => {
    function renderChrome() {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(Response.json({ plugins: [] })))
      );
      render(
        <PluginCatalogProvider>
          <HouseholdChrome currentPath="/calendar" showWeather={false}>
            <main />
          </HouseholdChrome>
        </PluginCatalogProvider>
      );
      return screen.getByTestId("admin-affordance");
    }

    it("opens Admin on a plain tap, with no hold timer or hint", () => {
      const admin = renderChrome();
      vi.useFakeTimers();
      fireEvent.pointerDown(admin, { pointerId: 1, pointerType: "touch" });
      fireEvent.pointerUp(admin, { pointerId: 1, pointerType: "touch" });
      expect(window.location.pathname).toBe("/");
      fireEvent.click(admin, { detail: 1 });

      expect(window.location.pathname).toBe("/admin");
      expect(window.history.state).toEqual({ marplannerAdminReturnPath: "/calendar" });
      expect(admin).not.toHaveAttribute("data-hold-state");
      expect(screen.queryByTestId("admin-hold-progress")).not.toBeInTheDocument();
      expect(screen.queryByTestId("admin-hold-hint")).not.toBeInTheDocument();
    });

    it("opens Admin from the menu entry on a plain tap and closes the menu", () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(Response.json({ plugins: [] })))
      );
      render(
        <PluginCatalogProvider>
          <HouseholdChrome
            currentPath="/"
            showWeather={false}
            extraOptions={[{ id: "print", render: () => <button type="button">Print</button> }]}
          >
            <main />
          </HouseholdChrome>
        </PluginCatalogProvider>
      );
      fireEvent.click(screen.getByRole("button", { name: "Options" }));
      fireEvent.click(screen.getByRole("button", { name: "Admin" }), { detail: 1 });

      expect(window.location.pathname).toBe("/admin");
      expect(screen.queryByRole("group", { name: "Options" })).not.toBeInTheDocument();
    });

    it("opens Admin from keyboard and assistive-technology activation", () => {
      const admin = renderChrome();
      // A focused button turns Enter/Space into a click with `detail: 0`; so do switch, voice and
      // screen-reader activations.
      fireEvent.keyDown(admin, { key: "Enter" });
      fireEvent.click(admin, { detail: 0 });
      expect(window.location.pathname).toBe("/admin");
    });
  });

  describe("the unlocked admin bar", () => {
    it("navigates Home and up the breadcrumb on a plain click, and leaves modified clicks native", () => {
      vi.stubEnv("MODE", "development");
      vi.stubEnv("VITE_DEV_BYPASS_ADMIN_PIN", "1");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(Response.json({ plugins: [] })))
      );
      window.history.replaceState({}, "", "/admin/members");
      try {
        render(
          <AdminUnlockProvider>
            <PluginCatalogProvider>
              <HouseholdChrome currentPath="/admin/members" showWeather={false}>
                <main />
              </HouseholdChrome>
            </PluginCatalogProvider>
          </AdminUnlockProvider>
        );

        const breadcrumb = screen.getByTestId("admin-breadcrumb");
        const root = within(breadcrumb).getAllByRole("link")[0];
        fireEvent.click(root, { ctrlKey: true });
        expect(window.location.pathname).toBe("/admin/members");
        fireEvent.click(root);
        expect(window.location.pathname).toBe("/admin");

        const home = screen.getByTestId("admin-topbar-home");
        fireEvent.click(home, { metaKey: true });
        expect(window.location.pathname).toBe("/admin");
        fireEvent.click(home);
        expect(window.location.pathname).toBe("/");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
