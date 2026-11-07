import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell, ProvisioningScreen, registerShellService } from "@/shell/Shell";
import { authFetch } from "@/lib/credential";
import type { PluginCatalogEntry, PluginId } from "../../src/shared/plugins";

const PLUGIN_IDS: readonly PluginId[] = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
];

function activePlugin(id: PluginId): PluginCatalogEntry {
  const contributions: Record<PluginId, PluginCatalogEntry["contributions"]> = {
    "daily-briefing": {
      routes: ["daily-briefing-api"],
      admin: ["daily-briefing"],
      settings: ["daily-briefing-settings"],
      widgets: [],
      services: ["daily-briefing-generator"],
      jobs: [
        "daily-briefing.generate-all",
        "daily-briefing.retry-15",
        "daily-briefing.retry-30",
        "daily-briefing.auto-print-sweep",
      ],
    },
    printing: {
      routes: ["printing-api"],
      admin: ["printing"],
      settings: [],
      widgets: ["printer-attention"],
      services: ["printing-queue", "printing-executor"],
      jobs: [],
    },
    weather: {
      routes: ["weather-api"],
      admin: ["weather"],
      settings: ["weather-settings"],
      widgets: ["weather-pill"],
      services: ["weather-forecast-provider"],
      jobs: [],
    },
    "time-announcements": {
      routes: ["time-announcements-api"],
      admin: ["time-announcements"],
      settings: [],
      widgets: [],
      services: ["time-announcements-speaker"],
      jobs: [],
    },
    backups: {
      routes: ["backups-api"],
      admin: ["backups"],
      settings: [],
      widgets: [],
      services: [],
      jobs: ["backups.nightly"],
    },
    "network-devices": {
      routes: ["network-devices-api"],
      admin: ["network-devices"],
      settings: [],
      widgets: [],
      services: ["network-devices-controller"],
      jobs: ["network-devices.poll"],
    },
    "meals-recipes": {
      routes: ["meals-recipes-api"],
      admin: ["meals"],
      settings: [],
      widgets: ["today-meals"],
      services: [],
      jobs: [],
    },
    reminders: {
      routes: ["reminders-api"],
      admin: ["reminders"],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
    "daily-messages": {
      routes: ["daily-messages-api"],
      admin: ["daily-messages"],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
  };
  return {
    id,
    label: `plugins.${id}.label`,
    description: `plugins.${id}.description`,
    trustTier: "first-party",
    contributions: contributions[id],
    requirements: [],
    settingsSchema: [],
    state: "active",
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error: null,
  };
}

function pluginCatalogResponse(): Response {
  return Response.json({ plugins: PLUGIN_IDS.map(activePlugin) });
}

function inactivePlugin(id: PluginId): PluginCatalogEntry {
  return {
    ...activePlugin(id),
    state: "inactive",
    contributions: {
      routes: [],
      admin: [],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
  };
}

// Printing's hiding behavior itself is covered by `printing-executor-fr013.test.tsx`, not this
// file. These shell fixtures keep the catalog active so unrelated contribution projection does
// not obscure the shell behavior under test.
vi.mock("@/printing/pluginStatus", () => ({
  usePrintingPluginActive: () => true,
}));

describe("Shell — unprovisioned gate", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);
    // Clear any provisioned marker so each test controls provisioned state (FR-031).
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.history.pushState({}, "", "/");
    cleanup();
  });

  it("renders ProvisioningScreen when no device-provisioned marker cookie is present (FR-031)", async () => {
    render(<Shell />);

    expect(screen.getByRole("heading", { name: "Marplanner Kiosk" })).toBeInTheDocument();
    expect(
      screen.getByText(/Enter the bootstrap key to provision this device/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
    // FR-031: the pre-provisioning screen makes NO authenticated settings probe.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shows the server retry delay for provisioning 429 without automatic retries", async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": "2" } })
    );
    render(<Shell />);
    fireEvent.change(screen.getByLabelText("Bootstrap key"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Provision Device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many failed attempts. Wait at least 2 seconds before trying again."
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Provision Device" })).not.toBeDisabled();
  });

  it.each([null, "garbage", "0", "-1", "1.5", "9007199254740993"])(
    "shows no invented retry duration for unusable Retry-After %s",
    async (header) => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: header === null ? {} : { "Retry-After": header },
        })
      );
      render(<Shell />);
      fireEvent.change(screen.getByLabelText("Bootstrap key"), { target: { value: "wrong" } });
      fireEvent.click(screen.getByRole("button", { name: "Provision Device" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Too many failed attempts. Wait before trying again."
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  );

  it("renders the household shell when the provisioned marker is present (FR-031)", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    render(<Shell />);
    await screen.findByTestId("plugin-health-indicator");
    expect(screen.getByTestId("home-surface")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Provision Device" })).not.toBeInTheDocument();
  });

  it("marks the current family destination and makes Options the Admin affordance while Admin is its only entry", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    window.history.pushState({}, "", "/calendar");
    render(<Shell />);

    expect(await screen.findByRole("link", { name: "Calendar" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    // With Admin as its only entry, Options is the Admin affordance itself, not a one-item menu.
    const options = screen.getByRole("button", { name: "Options" });
    expect(options).toHaveAttribute("data-testid", "admin-affordance");
    expect(options).not.toHaveAttribute("aria-expanded");
    expect(options).not.toHaveAttribute("aria-controls");
    expect(options).not.toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
    fireEvent.click(options, { detail: 1 });
    expect(screen.queryByRole("group", { name: "Options" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin");
    expect(await screen.findByTestId("admin-pin-keypad")).toBeInTheDocument();
  });

  it("organizes the household chrome into compact navigation, contextual center, and secondary actions", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    render(<Shell />);

    const menubar = await screen.findByTestId("household-menubar");
    expect(within(menubar).getByTestId("household-nav")).toHaveClass("min-w-0", "max-w-full");
    expect(within(menubar).getByTestId("household-nav")).not.toHaveClass("shrink-0");
    expect(within(menubar).getByTestId("household-context")).toHaveClass(
      "flex-1",
      "justify-center"
    );
    expect(within(menubar).getByTestId("household-actions")).toHaveClass("min-w-0", "max-w-full");
    expect(within(menubar).getByTestId("household-actions")).not.toHaveClass("shrink-0");
    expect(within(menubar).getByRole("button", { name: "Options" })).toHaveClass(
      "text-muted-foreground"
    );
  });

  it("keeps the unlocked admin subtree mounted when Printing is deactivated", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    window.history.pushState({}, "", "/admin/plugins");
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_DEV_BYPASS_ADMIN_PIN", "1");
    let printingActive = true;
    mockFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/plugins") {
        return Promise.resolve(
          Response.json({
            plugins: PLUGIN_IDS.map((id) =>
              id === "printing" && !printingActive ? inactivePlugin(id) : activePlugin(id)
            ),
          })
        );
      }
      if (url === "/api/plugins/printing/deactivate" && init?.method === "POST") {
        printingActive = false;
        return Promise.resolve(Response.json(inactivePlugin("printing")));
      }
      if (url === "/api/auth/verify-pin") return Promise.resolve(Response.json({ match: true }));
      if (url === "/api/settings") {
        return Promise.resolve(
          Response.json({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } })
        );
      }
      return Promise.resolve(Response.json([]));
    });

    render(<Shell />);
    const deactivate = await screen.findByRole("button", { name: "Printing", pressed: true });
    vi.stubEnv("VITE_DEV_BYPASS_ADMIN_PIN", "0");
    fireEvent.click(deactivate);

    await screen.findByRole("button", { name: "Printing", pressed: false });
    expect(screen.queryByTestId("admin-affordance")).not.toBeInTheDocument();
    expect(screen.getByTestId("plugin-catalog")).toBeInTheDocument();
  });

  it("opens the PIN gate on a plain tap with no hold or progress indicator", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    render(<Shell />);

    await screen.findByTestId("plugin-health-indicator");
    const admin = await screen.findByTestId("admin-affordance");
    expect(screen.queryByTestId("admin-hold-progress")).not.toBeInTheDocument();

    fireEvent.pointerDown(admin, { pointerId: 7, pointerType: "touch" });
    fireEvent.pointerUp(admin, { pointerId: 7, pointerType: "touch" });
    fireEvent.click(admin, { detail: 1 });

    expect(window.location.pathname).toBe("/admin");
    expect(await screen.findByTestId("admin-pin-keypad")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Options" })).not.toBeInTheDocument();
  });

  it("a second Admin activation on the open PIN gate adds no history entry and Cancel returns to the origin", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    window.history.pushState({}, "", "/calendar");
    render(<Shell />);

    await screen.findByTestId("plugin-health-indicator");
    const before = window.history.length;
    fireEvent.click(await screen.findByTestId("admin-affordance"), { detail: 1 });
    expect(await screen.findByTestId("admin-pin-keypad")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("admin-affordance"), { detail: 2 });

    expect(window.history.length).toBe(before + 1);
    expect(window.history.state).toEqual({ marplannerAdminReturnPath: "/calendar" });

    fireEvent.click(screen.getByTestId("admin-pin-cancel"));
    await waitFor(() => expect(window.location.pathname).toBe("/calendar"));
  });

  it("opens admin immediately when the local PIN bypass flag is enabled", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_DEV_BYPASS_ADMIN_PIN", "1");
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    render(<Shell />);

    await screen.findByTestId("plugin-health-indicator");
    const admin = await screen.findByTestId("admin-affordance");

    fireEvent.click(admin, { detail: 1 });

    expect(window.location.pathname).toBe("/admin");
    expect(await screen.findByTestId("admin-nav-calendar")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-pin-keypad")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Options" })).not.toBeInTheDocument();
  });

  it("opens the PIN gate from keyboard and synthetic AT activation", async () => {
    document.cookie = "mp_provisioned=1; path=/";
    mockFetch.mockImplementation((url) => {
      const value = String(url).includes("/api/settings")
        ? { locale: { timezone: "UTC", language: "en", weekStartDay: 1 } }
        : [];
      return Promise.resolve(Response.json(value));
    });
    render(<Shell />);

    for (const key of ["Enter", " "]) {
      const admin = await screen.findByTestId("admin-affordance");
      admin.focus();
      // A focused button turns Enter/Space into a click carrying `detail: 0`.
      fireEvent.keyDown(admin, { key });
      fireEvent.click(admin, { detail: 0 });
      expect(window.location.pathname).toBe("/admin");
      expect(await screen.findByTestId("admin-pin-keypad")).toBeInTheDocument();

      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  });

  it("does NOT bypass the provisioning gate at /calendar (fail-closed, FR-031/ADR-059)", () => {
    // Regression guard (verify-): an unprovisioned device navigating
    // directly to /calendar must STILL hit the ProvisioningScreen. The /calendar
    // surface renders only AFTER the provisioning gate — never pre-empting it.
    window.history.pushState({}, "", "/calendar");
    try {
      render(<Shell />);
      expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
      // FR-031: no authenticated probe pre-provisioning, even on the /calendar path.
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });
});

describe("Shell — stale mp_provisioned marker recovery (FR-013)", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let unregister: () => void;

  /** A stand-in for AdminGate/MemberCreateForm: makes one authenticated call. */
  function AuthenticatedChild() {
    return (
      <button
        onClick={() => {
          void authFetch("/api/members", { method: "POST" });
        }}
      >
        Do authenticated thing
      </button>
    );
  }

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);
    // A stale marker: present client-side, but the device key behind it is
    // revoked/expired server-side — every /api/* call will 401/403.
    document.cookie = "mp_provisioned=1; path=/";
    // Exercise credential recovery through the public global-service seam. Unknown routes
    // are closed now and no longer accept arbitrary child content.
    window.history.pushState({}, "", "/admin/printing");
    unregister = registerShellService(AuthenticatedChild);
  });

  afterEach(() => {
    unregister();
    vi.unstubAllGlobals();
    document.cookie = "mp_provisioned=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.history.pushState({}, "", "/");
    cleanup();
  });

  it("falls back to the provisioning gate when an authenticated call 401s (no manual refresh needed)", async () => {
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/settings") {
        return Promise.resolve(
          Response.json({ locale: { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 } })
        );
      }
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    render(<Shell />);

    // Renders provisioned (stale marker present) — the rejected call hasn't
    // happened yet.
    expect(await screen.findByText("Do authenticated thing")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Do authenticated thing"));

    // FR-013: on the rejected authenticated call, the shell returns to the
    // access-gate/provisioning screen — no manual refresh required.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Do authenticated thing")).not.toBeInTheDocument();

    // The stale marker itself is gone, so a REAL refresh would also land here.
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);
  });

  it("falls back to the provisioning gate on a 403 (revoked key) the same way", async () => {
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/settings") {
        return Promise.resolve(
          Response.json({ locale: { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 } })
        );
      }
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      return Promise.resolve(new Response(null, { status: 403 }));
    });

    render(<Shell />);

    fireEvent.click(await screen.findByText("Do authenticated thing"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
    });
  });

  it("stays provisioned when the authenticated call succeeds", async () => {
    mockFetch.mockImplementation((url) => {
      if (String(url) === "/api/settings") {
        return Promise.resolve(
          Response.json({ locale: { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 } })
        );
      }
      if (String(url) === "/api/plugins") return Promise.resolve(pluginCatalogResponse());
      return Promise.resolve(Response.json({}, { status: 201 }));
    });

    render(<Shell />);

    fireEvent.click(await screen.findByText("Do authenticated thing"));

    // Give any (absent) state transition a tick to happen, then assert it didn't.
    await Promise.resolve();
    expect(screen.getByText("Do authenticated thing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Provision Device" })).not.toBeInTheDocument();
  });
});

describe("ProvisioningScreen — action exists", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("calls onProvision with the key when the button is clicked", () => {
    const onProvision = vi.fn();
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ provisioned: true }), { status: 200 })
    );

    render(<ProvisioningScreen onProvision={onProvision} provisioning={false} error={false} />);

    //: the label/input association now runs through `Field` (a real
    // `<label htmlFor>`/`id` pair), so this is discovered by accessible name, not a raw
    // `[aria-label]` attribute selector.
    const input = screen.getByLabelText("Bootstrap key");
    fireEvent.change(input, { target: { value: "mpk-test-key" } });

    fireEvent.click(screen.getByRole("button", { name: "Provision Device" }));

    expect(onProvision).toHaveBeenCalledWith("mpk-test-key");
  });

  it("disables the button when no key is entered", () => {
    render(<ProvisioningScreen onProvision={vi.fn()} provisioning={false} error={false} />);

    expect(screen.getByRole("button", { name: "Provision Device" })).toBeDisabled();
  });

  it("shows the one localized, friendly error copy when the error flag is set (FR-019 — no raw fetch/Error detail is ever rendered)", () => {
    render(<ProvisioningScreen onProvision={vi.fn()} provisioning={false} error={true} />);

    expect(
      screen.getByText("Provisioning failed. Check the bootstrap key and try again.")
    ).toBeInTheDocument();
  });
});
