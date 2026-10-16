import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import { HouseholdChrome } from "@/shell/HouseholdChrome";

afterEach(() => {
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
});
