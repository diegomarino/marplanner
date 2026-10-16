import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import { HouseholdChrome } from "@/shell/HouseholdChrome";

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
    expect(admin).toHaveAttribute("data-hold-state", "idle");
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

  describe("a tap on the Admin affordance", () => {
    function renderChrome() {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(Response.json({ plugins: [] })))
      );
      render(
        <PluginCatalogProvider>
          <HouseholdChrome currentPath="/" showWeather={false}>
            <main />
          </HouseholdChrome>
        </PluginCatalogProvider>
      );
      return screen.getByTestId("admin-affordance");
    }

    it("explains that Admin needs a hold, then hides the hint", async () => {
      const admin = renderChrome();
      vi.useFakeTimers();
      expect(screen.queryByTestId("admin-hold-hint")).not.toBeInTheDocument();

      fireEvent.pointerDown(admin, { pointerId: 1 });
      fireEvent.pointerUp(admin, { pointerId: 1 });
      fireEvent.click(admin, { detail: 1 });

      const hint = screen.getByTestId("admin-hold-hint");
      expect(hint).toHaveTextContent("Hold to open Admin");
      expect(hint).toHaveAttribute("role", "status");
      expect(window.location.pathname).toBe("/");

      await act(() => vi.advanceTimersByTime(2_500));
      expect(screen.queryByTestId("admin-hold-hint")).not.toBeInTheDocument();
    });

    it("shows the hint for an early keyboard release too", () => {
      const admin = renderChrome();
      fireEvent.keyDown(admin, { key: "Enter" });
      fireEvent.keyUp(admin, { key: "Enter" });
      expect(screen.getByTestId("admin-hold-hint")).toHaveTextContent("Hold to open Admin");
      expect(window.location.pathname).toBe("/");
    });

    it("shows no hint after a completed hold", async () => {
      const admin = renderChrome();
      vi.useFakeTimers();
      fireEvent.pointerDown(admin, { pointerId: 2 });
      await act(() => vi.advanceTimersByTime(3_000));
      expect(window.location.pathname).toBe("/admin");
      fireEvent.pointerUp(admin, { pointerId: 2 });
      fireEvent.click(admin, { detail: 1 });
      expect(screen.queryByTestId("admin-hold-hint")).not.toBeInTheDocument();
    });

    it("hides the hint as soon as a new hold starts", () => {
      const admin = renderChrome();
      fireEvent.pointerDown(admin, { pointerId: 3 });
      fireEvent.pointerUp(admin, { pointerId: 3 });
      expect(screen.getByTestId("admin-hold-hint")).toBeInTheDocument();
      fireEvent.pointerDown(admin, { pointerId: 4 });
      expect(screen.queryByTestId("admin-hold-hint")).not.toBeInTheDocument();
    });
  });
});
