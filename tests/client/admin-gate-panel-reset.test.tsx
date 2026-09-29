import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminGate } from "@/admin/AdminGate";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import type { PluginCatalogEntry, PluginId } from "../../src/shared/plugins";
import type { HouseholdSettingsValue } from "@/lib/householdSettings";

/** replaces local boolean panel state with destinations. This regression fence stays
 * table-driven: every route is both left and entered once, so changing destination unmounts the
 * previous panel rather than leaving it alongside the new one.
 * Each panel's mount marker is either its own root `data-testid` (where the panel
 * declares one) or its unique `management.description` text (unambiguous — distinct
 * from the nav button's own label, which repeats the shorter `admin.nav.*` string).
 * Panels gate their content behind a `loading` flag that ALWAYS resolves to `false` in
 * a `finally` block regardless of fetch success/shape (the house pattern, verified
 * against `WeatherManagement`/`NetworkDevicesManagement`/others) — the generic
 * `/api/settings`-shaped 200 response below is enough to settle every panel past its
 * loading gate and reach its title/description header, even where the panel's OWN
 * fetch payload doesn't match what it expects (any resulting parse error is caught
 * internally and only affects that panel's error text, never the header).
 * `unlocked: true` is mocked directly (skips the long-press + PIN flow — irrelevant to
 * this fence) and `@/lib/householdSettings` is mocked so `LanguageProvider` resolves
 * synchronously, matching the house pattern in the other AdminGate/panel tests.
 */
vi.mock("@/lib/adminUnlock", () => ({
  isAdminPinBypassEnabled: () => false,
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

const MOCK_SETTINGS = {
  timezone: "Europe/Madrid",
  language: "en",
  weekStartDay: 1,
  weatherLat: null,
  weatherLon: null,
  weatherLabel: null,
} satisfies HouseholdSettingsValue;

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => MOCK_SETTINGS,
  useHouseholdSettingsContext: () => MOCK_SETTINGS,
}));

interface PanelSpec {
  /** The `admin-nav-*` testid that navigates to this destination. */
  nav: string;
  path: string;
  /** Root `data-testid` the panel itself declares, when it has one. */
  testId?: string;
  /** Unique heading when the panel has neither a root test id nor persistent description. */
  heading?: string;
  /** Unique text (this panel's `*.management.description`/`*.create.description`) when
   * the panel declares no root testid of its own. */
  text?: string;
}

/** Every protected destination, in the same order the AdminRoutes table renders it. */
const PANELS: PanelSpec[] = [
  {
    nav: "admin-nav-calendar",
    path: "/admin/calendar",
    testId: "calendar-management",
  },
  {
    nav: "admin-nav-member-create",
    path: "/admin",
    text: "Add a new member to the household. Admin role is not available.",
  },
  {
    nav: "admin-nav-members-management",
    path: "/admin/members",
    heading: "Members Management",
  },
  {
    nav: "admin-nav-day-periods",
    path: "/admin/day-periods",
    text: "Configure the four fixed day periods (morning, afternoon, evening, night).",
  },
  {
    nav: "admin-nav-routines-management",
    path: "/admin/routines",
    text: "Configure routines, chores, and weekday assignments.",
  },
  {
    nav: "admin-nav-reminders-management",
    path: "/admin/reminders",
    text: "Author scheduled reminders — apply to all members on shared weekdays, or target specific members on their own weekdays via the assignment matrix.",
  },
  {
    nav: "admin-nav-meals-management",
    path: "/admin/meals",
    text: "Manage recipes, author one-off meal entries, and view the derived daily menu.",
  },
  {
    nav: "admin-nav-daily-messages-management",
    path: "/admin/daily-messages",
    text: "Author, replace, and remove per-member daily messages over a date window.",
  },
  {
    nav: "admin-nav-daily-briefing-management",
    path: "/admin/daily-briefing",
    testId: "daily-briefing-management",
  },
  { nav: "admin-nav-telemetry", path: "/admin/telemetry", testId: "telemetry-management" },
  { nav: "admin-nav-backups", path: "/admin/backups", testId: "backups-management" },
  {
    nav: "admin-nav-time-announcements",
    path: "/admin/time-announcements",
    testId: "time-announcements-management",
  },
  { nav: "admin-nav-weather", path: "/admin/weather", testId: "weather-management" },
  {
    nav: "admin-nav-network-devices",
    path: "/admin/network-devices",
    testId: "network-devices-management",
  },
  { nav: "admin-nav-plugins", path: "/admin/plugins", testId: "plugin-catalog" },
  { nav: "admin-nav-printing", path: "/admin/printing", testId: "printing-management" },
];

async function findMounted(panel: PanelSpec) {
  if (panel.testId) return screen.findByTestId(panel.testId);
  if (panel.heading) return screen.findByRole("heading", { name: panel.heading });
  return screen.findByText(panel.text!);
}

function queryMounted(panel: PanelSpec) {
  if (panel.testId) return screen.queryByTestId(panel.testId);
  if (panel.heading) return screen.queryByRole("heading", { name: panel.heading });
  return screen.queryByText(panel.text!);
}

const SETTINGS_BODY = {
  locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
  weather: { lat: null, lon: null },
};

const PLUGIN_ADMIN_IDS: Record<PluginId, string> = {
  "daily-briefing": "daily-briefing",
  printing: "printing",
  weather: "weather",
  "time-announcements": "time-announcements",
  backups: "backups",
  "network-devices": "network-devices",
  "meals-recipes": "meals",
  reminders: "reminders",
  "daily-messages": "daily-messages",
};

function pluginCatalog(): PluginCatalogEntry[] {
  return (Object.keys(PLUGIN_ADMIN_IDS) as PluginId[]).map((id) => ({
    id,
    label: `plugins.${id}.label`,
    description: `plugins.${id}.description`,
    trustTier: "first-party",
    contributions: {
      routes: [],
      admin: [PLUGIN_ADMIN_IDS[id]],
      settings: [],
      widgets: [],
      services: [],
      jobs: [],
    },
    requirements: [],
    settingsSchema: [],
    state: "active",
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error: null,
  }));
}

function renderAdminGate() {
  return render(
    <PluginCatalogProvider>
      <AdminGate />
    </PluginCatalogProvider>
  );
}

async function waitForPluginCatalog(): Promise<void> {
  await screen.findByTestId("admin-nav-reminders-management");
}

/** Every panel's mount fetch(es), keyed by path prefix — checked in order, first match
 * wins. Each panel's OWN loading gate resolves to `false` in a `finally` block
 * regardless of response shape (the house pattern), so the goal here is only to give
 * each endpoint a shape its OWN component can destructure/iterate without throwing
 * (an unhandled render-time exception, not a caught fetch error, is the one failure
 * mode that would actually crash the panel before reaching its header) — not to model
 * real backend behavior.
 */
function respondFor(url: string): unknown {
  if (url === "/api/plugins") return { plugins: pluginCatalog() };
  if (url === "/api/settings") return SETTINGS_BODY;
  if (url.startsWith("/api/network-devices/live-clients")) {
    return { state: "fresh", clients: [] };
  }
  if (url.startsWith("/api/network-devices")) return { devices: [], cacheState: "fresh" };
  if (url.startsWith("/api/telemetry/client-log")) return { rows: [], nextCursor: null };
  if (url.startsWith("/api/backups")) return { backups: [] };
  if (url.startsWith("/api/printing/jobs")) return { jobs: [] };
  if (url.startsWith("/api/menu/week")) return {};
  // Every other endpoint this suite touches (members, reminders, routines, day-periods,
  // recipes, meal-plans, menu, daily-messages, daily-briefing/opt-in, time-announcements)
  // expects an array.
  return [];
}

describe("AdminGate — hideAllPanels resets every panel on switch (review P1-1, table-driven)", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
        return new Response(JSON.stringify(respondFor(String(input))), { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("covers every registered admin-nav-* destination (fence would silently pass for an unregistered route)", async () => {
    renderAdminGate();
    await waitForPluginCatalog();
    for (const panel of PANELS) {
      expect(screen.getByTestId(panel.nav)).toBeInTheDocument();
    }
    // If a new admin-nav-* button exists that ISN'T in PANELS, this repo has grown a
    // another panel without updating this fence — fail loudly rather than silently skip it.
    const renderedNavCount = screen
      .getAllByRole("button")
      .filter((el) => el.getAttribute("data-testid")?.startsWith("admin-nav-")).length;
    expect(renderedNavCount).toBe(PANELS.length);
  });

  const transitions = PANELS.map((panel, i) => ({
    from: panel,
    to: PANELS[(i + 1) % PANELS.length],
  }));

  it.each(transitions)(
    "navigating from $from.path to $to.path removes the first panel entirely",
    async ({ from, to }) => {
      renderAdminGate();
      await waitForPluginCatalog();

      fireEvent.click(screen.getByTestId(from.nav));
      await findMounted(from);

      fireEvent.click(screen.getByTestId(to.nav));
      await findMounted(to);

      expect(window.location.pathname).toBe(to.path);
      expect(queryMounted(from)).not.toBeInTheDocument();
    }
  );
});
