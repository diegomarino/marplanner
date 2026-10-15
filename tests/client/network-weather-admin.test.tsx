/** NetworkDevicesManagement + WeatherManagement spec (FR-009).
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), across every distinct phase each surface can render (a
 * per-phase control census, including a test proving the census count reacts to a control's
 * removal — i.e. the count is not vacuous), records a deliberate negative proving the assertion
 * can fail on a REAL control from each surface, asserts each surface's `AdminPanel` region AND
 * heading (the L2-adoption clause — anchored on loaded, fixture-specific content so a loading
 * skeleton sharing the same panel title cannot satisfy it by accident), and asserts every
 * distinct error CHANNEL either surface can render is announced through the shared `ErrorNotice`
 * live region (SC-011).
 * Component adoption for this module (recorded in full in each surface file's own header, cited
 * not restated here): `AdminPanel`/`ErrorNotice`/`Button`/`Input` are adopted on both surfaces.
 * `StatusToggle`/`WeekdayPicker`/`CheckboxField`/`RadioField` are NOT adopted on either surface
 * (the `StatusToggle` non-adoption on `NetworkDevicesManagement` is e2e-load-bearing:
 * `tests/e2e/network-devices.spec.ts` depends on the block/unblock button's accessible name being
 * the action word, not a state-invariant name). `ConfirmDialog` IS adopted for delete on
 * `NetworkDevicesManagement` (it replaced `window.confirm`; the e2e spec drives the dialog), and
 * edit/register use `Dialog`.
 * Neither surface declares an `as MessageKey`-cast label map (SC-007 does not apply — the debt
 * counter measured zero `translationCasts` in both files before this migration), so there is no
 * label map to pin here.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkDevicesManagement } from "@/admin/NetworkDevicesManagement";
import { WeatherManagement, type WeatherFormState } from "@/admin/WeatherManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { Role } from "../../src/shared";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

const SETTINGS_BODY = {
  locale: { timezone: "UTC", language: "en", weekStartDay: 1 },
  weather: { lat: null, lon: null },
};

const MEMBER_ARI = {
  id: "m1",
  displayName: "Ari",
  role: Role.child,
  lifecycle: "active" as const,
  createdAt: 0,
  updatedAt: 0,
};

const DEVICE_TABLET = {
  id: "d1",
  mac: "aa:bb:cc:dd:ee:01",
  alias: "Kid's Tablet",
  memberId: "m1",
  memberLabel: "Ari",
  memberInactive: false,
  isBlocked: false,
  beliefDiverged: false,
  lastSeenAt: null,
  liveStatus: "online" as const,
};

const DEVICE_LAPTOP = {
  id: "d2",
  mac: "aa:bb:cc:dd:ee:02",
  alias: "Old Laptop",
  memberId: null,
  memberLabel: null,
  memberInactive: false,
  isBlocked: true,
  beliefDiverged: false,
  lastSeenAt: 1_700_000_000_000,
  liveStatus: "notDetected" as const,
};

const LIVE_CLIENT_PHONE = {
  mac: "aa:bb:cc:dd:ee:03",
  displayName: "Unnamed Phone",
  isBlocked: false,
};

/** A fully-loaded, happy-path mock backend. `overrides` lets a single test redirect one
 * endpoint to a failure without re-declaring the rest — mirrors `members-admin.test.tsx`'s own
 * `mockBackend` shape. */
function mockNetworkDevicesBackend(
  overrides: Partial<{
    devices: () => Response;
    members: () => Response;
    liveClients: () => Response;
    block: () => Response;
    unblock: () => Response;
    register: () => Response;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/settings")) {
      return Promise.resolve(json(SETTINGS_BODY));
    }
    if (url === "/api/network-devices" && method === "GET") {
      return Promise.resolve(
        overrides.devices
          ? overrides.devices()
          : json({ devices: [DEVICE_TABLET, DEVICE_LAPTOP], cacheState: "fresh" })
      );
    }
    if (url === "/api/members" && method === "GET") {
      return Promise.resolve(overrides.members ? overrides.members() : json([MEMBER_ARI]));
    }
    if (url === "/api/network-devices/live-clients") {
      return Promise.resolve(
        overrides.liveClients
          ? overrides.liveClients()
          : json({ state: "fresh", clients: [LIVE_CLIENT_PHONE] })
      );
    }
    if (url === "/api/network-devices" && method === "POST") {
      return Promise.resolve(
        overrides.register
          ? overrides.register()
          : json({ ...DEVICE_TABLET, id: "new", alias: "New Device" }, 201)
      );
    }
    if (/\/api\/network-devices\/[^/]+$/.test(url) && method === "PATCH") {
      return Promise.resolve(json({ ...DEVICE_TABLET, alias: "Renamed" }));
    }
    if (/\/api\/network-devices\/[^/]+$/.test(url) && method === "DELETE") {
      return Promise.resolve(json(null, 204));
    }
    if (url.endsWith("/block") && method === "POST") {
      return Promise.resolve(
        overrides.block ? overrides.block() : json({ ...DEVICE_TABLET, isBlocked: true })
      );
    }
    if (url.endsWith("/unblock") && method === "POST") {
      return Promise.resolve(
        overrides.unblock ? overrides.unblock() : json({ ...DEVICE_LAPTOP, isBlocked: false })
      );
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderNetworkDevices() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <NetworkDevicesManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

function WeatherHarness({ initial }: { initial: WeatherFormState }) {
  const [value, setValue] = useState(initial);
  return (
    <WeatherManagement value={value} onChange={(patch) => setValue((c) => ({ ...c, ...patch }))} />
  );
}

function renderWeather(initial: WeatherFormState = { lat: "10", lon: "20", label: "" }) {
  return render(
    <LanguageProvider>
      <WeatherHarness initial={initial} />
    </LanguageProvider>
  );
}

/** Counts the surface's own interactive controls — the same tag set the frozen density helper
 * collects (`button, input, select`; neither surface renders `a[href]`/ARIA-role controls). Used
 * by the per-phase census assertions below, pinned to an EXACT number so a control silently
 * dropped from a phase is caught, not just "at least one control exists". */
function countControls(container: Element): number {
  return container.querySelectorAll("button, input, select").length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("NetworkDevicesManagement — kiosk density (SC-001, SC-002)", () => {
  it("meets kiosk density across the collapsed list, an open edit row, and the registration picker (both before and after selecting a client)", async () => {
    mockNetworkDevicesBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderNetworkDevices();
      await screen.findByText("Kid's Tablet");

      // Phase A: collapsed list — Add device + the two tabs + (Edit, Block/Unblock, Delete) per
      // device (2 devices).
      expect(countControls(container)).toBe(9);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase B: the edit Dialog open. It renders in a portal under document.body, so the census
      // reads the body: the 9 page controls (unchanged, now behind the dialog) + the dialog's
      // alias input, member select, Save, Cancel and its close button.
      fireEvent.click(screen.getByTestId("network-devices-edit-d1"));
      await screen.findByTestId("network-devices-save-d1");
      expect(countControls(document.body)).toBe(14);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
      fireEvent.click(screen.getByTestId("network-devices-cancel-edit-d1"));
      await waitFor(() => expect(screen.queryByTestId("network-devices-save-d1")).toBeNull());

      // Phase C: the Add tab, before a client is selected — the "Add device" header button is
      // hidden on this tab, leaving the two tabs + Refresh + the two sort headers + one Select
      // button per live client (one fixture).
      fireEvent.click(screen.getByTestId("network-devices-open-picker"));
      await screen.findByTestId("network-devices-picker");
      await screen.findByTestId(`network-devices-picker-client-${LIVE_CLIENT_PHONE.mac}`);
      expect(countControls(container)).toBe(6);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase D: a client selected — the register Dialog (portal) adds alias input, member
      // select, Submit, Cancel and its close button to the 6 table-tab controls.
      fireEvent.click(screen.getByTestId(`network-devices-picker-select-${LIVE_CLIENT_PHONE.mac}`));
      await screen.findByTestId("network-devices-picker-submit");
      expect(countControls(document.body)).toBe(11);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Register button below the kiosk minimum makes the assertion fail", async () => {
    mockNetworkDevicesBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderNetworkDevices();
      const registerButton = await screen.findByTestId("network-devices-open-picker");

      // A real control from this surface, not a synthetic fixture.
      registerButton.style.height = "10px";
      registerButton.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      // Recorded verbatim in this module's report — proof the helper actually rejects a real
      // undersized control on THIS surface, not merely on the helper's own synthetic fixtures.
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);

      // Revert — the rest of this file (and any test after it) must see a compliant surface.
      registerButton.style.height = "";
      registerButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("the collapsed-list census count reacts to a control's removal (proves the count is not vacuous)", async () => {
    mockNetworkDevicesBackend();
    const { container } = renderNetworkDevices();
    await screen.findByText("Kid's Tablet");

    expect(countControls(container)).toBe(9);
    screen.getByTestId("network-devices-delete-d2").remove();
    expect(countControls(container)).toBe(8);
  });
});

describe("NetworkDevicesManagement — adopts the AdminPanel L2 frame (per-batch DoD)", () => {
  it("wraps the surface in a landmark region labelled by its own title, anchored on LOADED content", async () => {
    mockNetworkDevicesBackend();
    renderNetworkDevices();

    // Anchor on fixture-specific, loaded-only content FIRST — the loading skeleton renders the
    // SAME AdminPanel title ("Network devices"), so asserting the region/heading before this
    // would pass vacuously against the skeleton (verification policy's own documented trap).
    await screen.findByText("Kid's Tablet");

    // A bare `<div>` in place of `AdminPanel` passes every functional test in this file — this
    // is the only assertion that would catch it (mirrors `members-admin.test.tsx`).
    expect(await screen.findByRole("region", { name: "Network devices" })).toBeInTheDocument();
    // Region alone is bypassable: `AdminPanel` names its region via `aria-labelledby` pointing
    // at its own heading, so a hand-rolled `<section aria-label="Network devices">` with NO
    // heading reproduces the landmark and its name and passes. The heading is the half a
    // substitute would have to reproduce the component to satisfy (verification policy).
    expect(screen.getByRole("heading", { name: "Network devices" })).toBeInTheDocument();
  });
});

describe("NetworkDevicesManagement — every error channel is announced (SC-011)", () => {
  it("announces a devices-list load failure through ErrorNotice's live region", async () => {
    mockNetworkDevicesBackend({ devices: () => json(null, 500) });
    renderNetworkDevices();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load network devices.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("data-testid", "network-devices-error");
  });

  it("announces a members-list load failure (its OWN, independent error channel) through ErrorNotice's live region", async () => {
    mockNetworkDevicesBackend({ members: () => json(null, 500) });
    renderNetworkDevices();

    await screen.findByText("Kid's Tablet");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Failed to load members; assigning a device to a member is unavailable for now."
    );
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("data-testid", "network-devices-members-error");
  });

  it("announces a row-scoped action failure (block) through ErrorNotice's live region", async () => {
    mockNetworkDevicesBackend({ block: () => json(null, 500) });
    renderNetworkDevices();

    await screen.findByText("Kid's Tablet");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-d1"));

    const alert = await screen.findByTestId("network-devices-row-error-d1");
    expect(alert).toHaveTextContent("Failed to block the device.");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces the picker's alias-required validation error through ErrorNotice's live region", async () => {
    mockNetworkDevicesBackend();
    renderNetworkDevices();

    await screen.findByText("Kid's Tablet");
    fireEvent.click(screen.getByTestId("network-devices-open-picker"));
    fireEvent.click(
      await screen.findByTestId(`network-devices-picker-select-${LIVE_CLIENT_PHONE.mac}`)
    );
    // The dialog prefills the alias from the client name: clear it to hit the validation.
    fireEvent.change(await screen.findByTestId("network-devices-picker-alias-input"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("network-devices-picker-submit"));

    const alert = await screen.findByTestId("network-devices-picker-error");
    expect(alert).toHaveTextContent("Please enter an alias.");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces the picker's live-clients load failure through ErrorNotice's live region", async () => {
    mockNetworkDevicesBackend({ liveClients: () => json(null, 500) });
    renderNetworkDevices();

    await screen.findByText("Kid's Tablet");
    fireEvent.click(screen.getByTestId("network-devices-open-picker"));

    // The picker mounts in its "loading" phase FIRST (same testid, different text) before the
    // mocked fetch rejects — `findByText` polls past that transient state to the settled error.
    await screen.findByText("Failed to load the current device list.");
    const alert = screen.getByTestId("network-devices-picker-state");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("NetworkDevicesManagement — unchanged behaviour after migration (regression guard)", () => {
  it("still confirms delete before deleting (ConfirmDialog)", async () => {
    mockNetworkDevicesBackend();
    renderNetworkDevices();

    await screen.findByText("Kid's Tablet");
    fireEvent.click(screen.getByTestId("network-devices-delete-d1"));

    expect(
      await screen.findByText("Delete this device? This cannot be undone.")
    ).toBeInTheDocument();
    // Nothing is deleted until the dialog is confirmed.
    expect(screen.getByText("Kid's Tablet")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("network-devices-delete-confirm"));
    await waitFor(() => expect(screen.queryByText("Kid's Tablet")).toBeNull());
  });

  it("still locates Block/Unblock by the ACTION word (StatusToggle deliberately NOT adopted, e2e-load-bearing)", async () => {
    mockNetworkDevicesBackend();
    renderNetworkDevices();

    await screen.findByText("Kid's Tablet");
    // d1 is unblocked -> "Block"; d2 is blocked -> "Unblock". Both are ACTION words, not a
    // state-invariant name — exactly what `tests/e2e/network-devices.spec.ts` locates by.
    expect(screen.getByTestId("network-devices-toggle-block-d1")).toHaveAccessibleName("Block");
    expect(screen.getByTestId("network-devices-toggle-block-d2")).toHaveAccessibleName("Unblock");
  });
});

describe("WeatherManagement — kiosk density (SC-001, SC-002)", () => {
  it("meets kiosk density across its single, static control set", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderWeather();
      await screen.findByTestId("weather-lat-input");

      expect(countControls(container)).toBe(5); // 3 inputs + Locate/Clear
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Clear button below the kiosk minimum makes the assertion fail", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderWeather();
      const clearButton = await screen.findByTestId("weather-clear");

      clearButton.style.height = "10px";
      clearButton.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);

      clearButton.style.height = "";
      clearButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("the census control count reacts to a control's removal (proves the count is not vacuous)", async () => {
    const { container } = renderWeather();
    await screen.findByTestId("weather-lat-input");

    expect(countControls(container)).toBe(5);
    screen.getByTestId("weather-clear").remove();
    expect(countControls(container)).toBe(4);
  });
});

describe("WeatherManagement — adopts the AdminPanel L2 frame (per-batch DoD)", () => {
  it("wraps the surface in a landmark region labelled by its own title", async () => {
    renderWeather();

    await screen.findByTestId("weather-lat-input");

    expect(await screen.findByRole("region", { name: "Weather" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Weather" })).toBeInTheDocument();
  });
});

describe("WeatherManagement — every error state is announced (SC-011)", () => {
  it("announces a refused geolocation through ErrorNotice's live region", async () => {
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: (_ok: unknown, fail: () => void) => fail() },
      configurable: true,
    });
    try {
      renderWeather();
      fireEvent.click(await screen.findByTestId("weather-locate"));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveAttribute("aria-live", "assertive");
      expect(alert).toHaveAttribute("data-testid", "weather-error");
    } finally {
      Reflect.deleteProperty(navigator, "geolocation");
    }
  });
});
