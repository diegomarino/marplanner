import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import { NetworkDevicesManagement } from "@/admin/NetworkDevicesManagement";
import type {
  LiveCacheState,
  LiveClient,
  Member,
  NetworkDevicesListResponse,
  RegisteredDevice,
} from "../../src/shared";

/** — NetworkDevicesManagement admin panel jsdom tests (house pattern:
 * useT/authFetch/controlled inputs, see `tests/client/weather-management.test.tsx`).
 * `@/lib/householdSettings` is mocked so `LanguageProvider` resolves synchronously to a fixed
 * household language — no real `/api/settings` fetch racing the panel's own GETs.
 * MAC-shape assertion: `MAC_SHAPED` matches ANY colon-separated hex-pair sextet
 * (case-insensitive) — the same shape used by `tests/boundary/network-devices-routes.test.ts`.
 * The registry list must never render one; the picker's OWN client list is the sole
 * documented exception (see NetworkDevicesManagement.tsx's module comment, FR-013 scope).
 * (Traces: FR-001, FR-009, FR-011, FR-013, FR-022)
 */

const currentSettings = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
  useHouseholdSettingsContext: () => currentSettings,
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

// NOTE: this regex is FIXTURE-dependent — it matches the canonical
// lowercase colon-separated notation every fixture MAC in this file uses (and the shape
// the server always normalizes to, `mac`). It would NOT catch some other
// notation (dashes, no separators, uppercase-only) were one ever produced; it is a scan
// for "did we accidentally render THIS shape", not a general MAC-detector.
const MAC_SHAPED = /([0-9a-f]{2}:){5}[0-9a-f]{2}/i;
const MAC = "aa:bb:cc:dd:ee:ff";

function jsonResponse(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

function renderManagement() {
  render(
    <LanguageProvider>
      <NetworkDevicesManagement />
    </LanguageProvider>
  );
}

function device(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
  return {
    id: "dev-1",
    mac: MAC,
    alias: "Marta's iPad",
    memberId: null,
    memberLabel: null,
    memberInactive: false,
    isBlocked: false,
    beliefDiverged: false,
    lastSeenAt: 1_700_000_000_000,
    liveStatus: "online",
    ...overrides,
  };
}

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "member-1",
    displayName: "Marta",
    colorKey: "blue",
    role: "child" as Member["role"],
    lifecycle: "active",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function devicesListResponse(
  devices: RegisteredDevice[],
  cacheState: LiveCacheState = "fresh"
): NetworkDevicesListResponse {
  return { devices, cacheState };
}

function liveClientsResponse(state: LiveCacheState, clients: LiveClient[] = []) {
  return { state, clients };
}

/** Routes a mocked fetch by method + path, covering every endpoint this panel calls. */
function mockRouter(handlers: {
  devices?: RegisteredDevice[];
  /** Override the devices GET entirely — return a Response (e.g. a 500) or REJECT (throw,
   * simulating a pre-response transport failure like `authFetch` itself rejecting). */
  onDevicesList?: () => Response;
  members?: Member[];
  /** Same override shape as `onDevicesList`, for the independent members GET . */
  onMembersList?: () => Response;
  liveClients?: { state: LiveCacheState; clients: LiveClient[] };
  onRegister?: (body: unknown) => Response;
  onEdit?: (id: string, body: unknown) => Response;
  onDelete?: (id: string) => Response;
  onBlock?: (id: string) => Response;
  onUnblock?: (id: string) => Response;
}) {
  return async (...args: FetchCall) => {
    const [input, init] = args;
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/network-devices" && method === "GET") {
      if (handlers.onDevicesList) return handlers.onDevicesList();
      return jsonResponse(devicesListResponse(handlers.devices ?? []));
    }
    if (url === "/api/members" && method === "GET") {
      if (handlers.onMembersList) return handlers.onMembersList();
      return jsonResponse(handlers.members ?? []);
    }
    if (url === "/api/network-devices/live-clients" && method === "GET") {
      return jsonResponse(
        liveClientsResponse(handlers.liveClients?.state ?? "fresh", handlers.liveClients?.clients)
      );
    }
    if (url === "/api/network-devices" && method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (handlers.onRegister) return handlers.onRegister(body);
      throw new Error("unexpected register call");
    }
    const editMatch = url.match(/^\/api\/network-devices\/([^/]+)$/);
    if (editMatch && method === "PATCH") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (handlers.onEdit) return handlers.onEdit(editMatch[1], body);
      throw new Error("unexpected edit call");
    }
    if (editMatch && method === "DELETE") {
      if (handlers.onDelete) return handlers.onDelete(editMatch[1]);
      throw new Error("unexpected delete call");
    }
    const blockMatch = url.match(/^\/api\/network-devices\/([^/]+)\/block$/);
    if (blockMatch && method === "POST") {
      if (handlers.onBlock) return handlers.onBlock(blockMatch[1]);
      throw new Error("unexpected block call");
    }
    const unblockMatch = url.match(/^\/api\/network-devices\/([^/]+)\/unblock$/);
    if (unblockMatch && method === "POST") {
      if (handlers.onUnblock) return handlers.onUnblock(unblockMatch[1]);
      throw new Error("unexpected unblock call");
    }
    throw new Error(`unexpected fetch: ${url} ${method}`);
  };
}

describe("NetworkDevicesManagement", () => {
  beforeEach(() => {
    currentSettings.language = "en";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("formats last-seen dates using the household's Spanish locale", async () => {
    currentSettings.language = "es";
    const lastSeenAt = Date.parse("2026-01-15T20:00:00Z");
    vi.mocked(globalThis.fetch).mockImplementation(
      mockRouter({ devices: [device({ liveStatus: "unknown", lastSeenAt })], members: [] })
    );
    renderManagement();
    const status = await screen.findByTestId("network-devices-status-dev-1");
    expect(status).toHaveTextContent(new Date(lastSeenAt).toLocaleString("es-ES"));
    expect(status).not.toHaveTextContent(new Date(lastSeenAt).toLocaleString("en-GB"));
  });

  it("renders aliases and NEVER a MAC-shaped string anywhere in the registry list", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({ devices: [device({ alias: "Marta's iPad" })], members: [] })
    );

    renderManagement();

    const list = await screen.findByTestId("network-devices-list");
    expect(within(list).getByText("Marta's iPad")).toBeInTheDocument();
    expect(list.textContent).not.toMatch(MAC_SHAPED);
  });

  it("the MAC-shape scan ALSO holds once a row enters edit mode (PR-E review P2-4)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({ devices: [device({ id: "dev-edit-scan", alias: "Marta's iPad" })], members: [] })
    );

    renderManagement();
    const list = await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-edit-dev-edit-scan"));

    // Re-scan the SAME list container now that it renders the edit form (alias input,
    // member select) instead of the read-only row — the edit draft never seeds a MAC.
    expect(list.textContent).not.toMatch(MAC_SHAPED);
  });

  it("the MAC-shape scan ALSO holds while a row error is displayed (PR-E review P2-4)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-err-scan", alias: "Marta's iPad" })],
        members: [],
        onBlock: () => jsonResponse({ error: "boom", code: "controller_unreachable" }, 502),
      })
    );

    renderManagement();
    const list = await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-err-scan"));
    await screen.findByTestId("network-devices-row-error-dev-err-scan");

    // The row error text itself (an already-localized, MAC-free message) must not
    // introduce a MAC-shaped string into the list either.
    expect(list.textContent).not.toMatch(MAC_SHAPED);
  });

  it("shows the liveStatus label and, for a notDetected/unknown device, a lastSeenAt secondary text (never next to online)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [
          device({ id: "online-1", liveStatus: "online", lastSeenAt: 1_700_000_000_000 }),
          device({ id: "stale-1", liveStatus: "notDetected", lastSeenAt: 1_600_000_000_000 }),
        ],
        members: [],
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    const onlineStatus = screen.getByTestId("network-devices-status-online-1");
    expect(onlineStatus).toHaveTextContent(messages.en["networkDevices.liveStatus.online"]);
    expect(onlineStatus).not.toHaveTextContent(messages.en["networkDevices.row.lastSeenLabel"]);

    const staleStatus = screen.getByTestId("network-devices-status-stale-1");
    expect(staleStatus).toHaveTextContent(messages.en["networkDevices.liveStatus.notDetected"]);
    expect(staleStatus).toHaveTextContent(messages.en["networkDevices.row.lastSeenLabel"]);
  });

  it("PR-E review P3-10: an 'unknown' liveStatus shows the underlying cacheState as secondary text", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/network-devices") {
        return jsonResponse({
          devices: [device({ id: "dev-unknown-cache", liveStatus: "unknown" })],
          cacheState: "stale",
        });
      }
      if (url === "/api/members") return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    await screen.findByTestId("network-devices-list");

    const status = screen.getByTestId("network-devices-status-dev-unknown-cache");
    expect(status).toHaveTextContent(messages.en["networkDevices.row.cacheStateLabel"]);
    expect(status).toHaveTextContent(messages.en["networkDevices.cacheState.stale"]);
  });

  it("PR-E review P3-10: an 'online' liveStatus never shows the cacheState secondary text", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-online-nocache", liveStatus: "online" })],
        members: [],
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    const status = screen.getByTestId("network-devices-status-dev-online-nocache");
    expect(status).not.toHaveTextContent(messages.en["networkDevices.row.cacheStateLabel"]);
  });

  it("shows a belief-diverged affordance (never a confident 'Blocked'/'Unblocked' status) for a row loaded with beliefDiverged=true", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [
          device({
            id: "diverged-1",
            isBlocked: true,
            beliefDiverged: true,
            liveStatus: "unknown",
          }),
        ],
        members: [],
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    // this row arrived already-divergent from the LIST LOAD itself (no local
    // block/unblock action was attempted this session), so the badge must be the NEUTRAL
    // "state confirming" label — NOT a confident "Blocked"/"Unblocked" derived from the
    // response's own (possibly stale) `isBlocked`. See the dedicated load-time-vs-post-action
    // tests below for the full authoritative-vs-stale distinction.
    const status = screen.getByTestId("network-devices-status-diverged-1");
    expect(status).toHaveTextContent(messages.en["networkDevices.badge.stateConfirming"]);
    expect(status).not.toHaveTextContent(messages.en["networkDevices.badge.blocked"]);
  });

  it("shows an inactive-member label while keeping the device editable (FR-011)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [
          device({
            id: "dev-inactive-member",
            memberId: "member-1",
            memberLabel: "Old Member",
            memberInactive: true,
          }),
        ],
        members: [],
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    expect(screen.getByText(/Old Member/)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(messages.en["networkDevices.member.inactive"]))
    ).toBeInTheDocument();
    expect(screen.getByTestId("network-devices-edit-dev-inactive-member")).not.toBeDisabled();
  });

  it("PR-E review P3-9: editing a device linked to an INACTIVE member shows a disabled option naming it (never blank)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [
          device({
            id: "dev-edit-inactive",
            memberId: "member-old",
            memberLabel: "Old Member",
            memberInactive: true,
          }),
        ],
        members: [],
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-edit-dev-edit-inactive"));

    const select = screen.getByTestId(
      "network-devices-edit-member-dev-edit-inactive"
    ) as HTMLSelectElement;
    expect(select.value).toBe("member-old");
    const inactiveOption = within(select).getByText(/Old Member/);
    expect(inactiveOption).toBeInTheDocument();
    expect((inactiveOption as HTMLOptionElement).disabled).toBe(true);
  });

  describe("picker registration — every live-cache state renders its own distinct message", () => {
    const cases: Array<{ state: LiveCacheState; messageKey: keyof typeof messages.en }> = [
      { state: "unconfigured", messageKey: "networkDevices.picker.state.unconfigured" },
      { state: "cold", messageKey: "networkDevices.picker.state.cold" },
      { state: "stale", messageKey: "networkDevices.picker.state.stale" },
      { state: "freshEmpty", messageKey: "networkDevices.picker.state.freshEmpty" },
    ];

    for (const { state, messageKey } of cases) {
      it(`state=${state}`, async () => {
        const mockFetch = vi.mocked(globalThis.fetch);
        mockFetch.mockImplementation(
          mockRouter({ devices: [], members: [], liveClients: { state, clients: [] } })
        );

        renderManagement();
        await screen.findByTestId("network-devices-empty");

        fireEvent.click(screen.getByTestId("network-devices-open-picker"));

        await waitFor(() => {
          expect(screen.getByTestId("network-devices-picker-state")).toHaveTextContent(
            messages.en[messageKey]
          );
        });
      });
    }

    it("state=fresh renders the client list, showing the MAC (picker-only exception) with displayName when present", async () => {
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockImplementation(
        mockRouter({
          devices: [],
          members: [],
          liveClients: {
            state: "fresh",
            clients: [{ mac: MAC, displayName: "Marta's iPad", isBlocked: false }],
          },
        })
      );

      renderManagement();
      await screen.findByTestId("network-devices-empty");
      fireEvent.click(screen.getByTestId("network-devices-open-picker"));

      const clients = await screen.findByTestId("network-devices-picker-clients");
      expect(within(clients).getByText(new RegExp(MAC))).toBeInTheDocument();
      expect(within(clients).getByText(/Marta's iPad/)).toBeInTheDocument();
    });

    it("state=fresh with an unnamed client shows the neutral '(unnamed device)' fallback, never blank", async () => {
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockImplementation(
        mockRouter({
          devices: [],
          members: [],
          liveClients: {
            state: "fresh",
            clients: [{ mac: MAC, displayName: null, isBlocked: false }],
          },
        })
      );

      renderManagement();
      await screen.findByTestId("network-devices-empty");
      fireEvent.click(screen.getByTestId("network-devices-open-picker"));

      const clients = await screen.findByTestId("network-devices-picker-clients");
      expect(
        within(clients).getByText(new RegExp(messages.en["networkDevices.picker.unnamedDevice"]))
      ).toBeInTheDocument();
    });

    it("the picker's POST-selection form (alias/member) never renders the MAC (PR-E review P2-4)", async () => {
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockImplementation(
        mockRouter({
          devices: [],
          members: [],
          liveClients: {
            state: "fresh",
            clients: [{ mac: MAC, displayName: "Marta's iPad", isBlocked: false }],
          },
        })
      );

      renderManagement();
      await screen.findByTestId("network-devices-empty");
      fireEvent.click(screen.getByTestId("network-devices-open-picker"));
      await screen.findByTestId("network-devices-picker-clients");

      fireEvent.click(screen.getByTestId(`network-devices-picker-select-${MAC}`));

      const picker = await screen.findByTestId("network-devices-picker");
      // Selecting a client unmounts the client-list `<ul>` (the picker's ONE documented
      // MAC-rendering surface) in favor of the alias/member form — pin that the whole
      // picker, post-selection, is MAC-free.
      expect(screen.queryByTestId("network-devices-picker-clients")).not.toBeInTheDocument();
      expect(picker.textContent).not.toMatch(MAC_SHAPED);
    });
  });

  it("register: 409 reselect_required renders its OWN dedicated localized message", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [],
        members: [],
        liveClients: {
          state: "fresh",
          clients: [{ mac: MAC, displayName: null, isBlocked: false }],
        },
        onRegister: () =>
          jsonResponse({ error: "not in current cache", code: "reselect_required" }, 409),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-empty");
    fireEvent.click(screen.getByTestId("network-devices-open-picker"));
    await screen.findByTestId("network-devices-picker-clients");

    fireEvent.click(screen.getByTestId(`network-devices-picker-select-${MAC}`));
    fireEvent.change(screen.getByTestId("network-devices-picker-alias-input"), {
      target: { value: "New Alias" },
    });
    fireEvent.click(screen.getByTestId("network-devices-picker-submit"));

    const err = await screen.findByTestId("network-devices-picker-error");
    expect(err).toHaveTextContent(messages.en["networkDevices.error.reselectRequired"]);
  });

  it("register: 409 duplicate_mac renders its OWN dedicated localized message", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [],
        members: [],
        liveClients: {
          state: "fresh",
          clients: [{ mac: MAC, displayName: null, isBlocked: false }],
        },
        onRegister: () => jsonResponse({ error: "already registered", code: "duplicate_mac" }, 409),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-empty");
    fireEvent.click(screen.getByTestId("network-devices-open-picker"));
    await screen.findByTestId("network-devices-picker-clients");

    fireEvent.click(screen.getByTestId(`network-devices-picker-select-${MAC}`));
    fireEvent.change(screen.getByTestId("network-devices-picker-alias-input"), {
      target: { value: "New Alias" },
    });
    fireEvent.click(screen.getByTestId("network-devices-picker-submit"));

    const err = await screen.findByTestId("network-devices-picker-error");
    expect(err).toHaveTextContent(messages.en["networkDevices.error.duplicateMac"]);
  });

  it("register: a successful submission adds the device to the list and closes the picker", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const registered = device({ id: "new-dev", alias: "New Alias" });
    mockFetch.mockImplementation(
      mockRouter({
        devices: [],
        members: [member()],
        liveClients: {
          state: "fresh",
          clients: [{ mac: MAC, displayName: null, isBlocked: false }],
        },
        onRegister: () => jsonResponse(registered, 201),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-empty");
    fireEvent.click(screen.getByTestId("network-devices-open-picker"));
    await screen.findByTestId("network-devices-picker-clients");

    fireEvent.click(screen.getByTestId(`network-devices-picker-select-${MAC}`));
    fireEvent.change(screen.getByTestId("network-devices-picker-alias-input"), {
      target: { value: "New Alias" },
    });
    fireEvent.click(screen.getByTestId("network-devices-picker-submit"));

    await waitFor(() => {
      expect(screen.queryByTestId("network-devices-picker")).not.toBeInTheDocument();
    });
    expect(screen.getByText("New Alias")).toBeInTheDocument();
  });

  it("edit: PATCH updates alias/member and re-renders the row", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const initial = device({ id: "dev-edit", alias: "Old Alias" });
    const updated = device({ id: "dev-edit", alias: "Updated Alias" });
    mockFetch.mockImplementation(
      mockRouter({
        devices: [initial],
        members: [],
        onEdit: () => jsonResponse(updated),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    fireEvent.click(screen.getByTestId("network-devices-edit-dev-edit"));
    fireEvent.change(screen.getByTestId("network-devices-edit-alias-dev-edit"), {
      target: { value: "Updated Alias" },
    });
    fireEvent.click(screen.getByTestId("network-devices-save-dev-edit"));

    await waitFor(() => {
      expect(screen.getByText("Updated Alias")).toBeInTheDocument();
    });
  });

  it("block: on success, updates the row's belief in place", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const initial = device({ id: "dev-block", isBlocked: false });
    const blocked = device({ id: "dev-block", isBlocked: true });
    mockFetch.mockImplementation(
      mockRouter({
        devices: [initial],
        members: [],
        onBlock: () => jsonResponse(blocked),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-block"));

    await waitFor(() => {
      expect(screen.getByTestId("network-devices-status-dev-block")).toHaveTextContent(
        messages.en["networkDevices.badge.blocked"]
      );
    });
  });

  // the divergence badge must reflect the AUTHORITATIVE controller outcome, not
  // whatever (possibly stale) `isBlocked` the response body happens to carry.
  it("block: on success with a STALE isBlocked=false + beliefDiverged=true response, shows the BLOCKED-confirming label (not unblocked)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const initial = device({ id: "dev-diverge-block", isBlocked: false });
    // The controller call itself SUCCEEDED (it targeted "blocked"), but the mirror write
    // failed — the response carries the STALE pre-action belief (isBlocked: false) alongside
    // beliefDiverged: true, which is the exact shape the client must NOT take at face value.
    const staleResponse = device({
      id: "dev-diverge-block",
      isBlocked: false,
      beliefDiverged: true,
    });
    mockFetch.mockImplementation(
      mockRouter({
        devices: [initial],
        members: [],
        onBlock: () => jsonResponse(staleResponse),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-diverge-block"));

    const status = await screen.findByTestId("network-devices-status-dev-diverge-block");
    await waitFor(() => {
      expect(status).toHaveTextContent(messages.en["networkDevices.badge.blockedConfirming"]);
    });
    expect(status).not.toHaveTextContent(messages.en["networkDevices.badge.unblockedConfirming"]);
  });

  it("a device that arrives ALREADY divergent from a list load (no local action taken) shows the NEUTRAL confirming label", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [
          device({
            id: "dev-load-diverged",
            isBlocked: false,
            beliefDiverged: true,
            liveStatus: "unknown",
          }),
        ],
        members: [],
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    const status = screen.getByTestId("network-devices-status-dev-load-diverged");
    expect(status).toHaveTextContent(messages.en["networkDevices.badge.stateConfirming"]);
    expect(status).not.toHaveTextContent(messages.en["networkDevices.badge.blockedConfirming"]);
    expect(status).not.toHaveTextContent(messages.en["networkDevices.badge.unblockedConfirming"]);
  });

  // divergence means the LOCAL mirror may be stale in EITHER direction, so the
  // stranded-upstream-block warning must fire whenever `isBlocked || beliefDiverged`, not just
  // when the (possibly stale) mirror says blocked.
  it("delete: a device with isBlocked=false + beliefDiverged=true ALSO shows the stranded-upstream-block warning", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-del-diverged", isBlocked: false, beliefDiverged: true })],
        members: [],
        onDelete: () => jsonResponse(null, 204),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-delete-dev-del-diverged"));

    expect(confirmSpy).toHaveBeenCalledWith(
      messages.en["networkDevices.action.deleteConfirmBlocked"]
    );

    confirmSpy.mockRestore();
  });

  // a failed/degraded members read must not silently drop the device's CURRENT
  // (active) assignment from the edit select.
  it("edit: with a failing members load, the select PRESERVES an option for the device's current (active) assignment", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [
          device({
            id: "dev-members-fail-assigned",
            memberId: "member-x",
            memberLabel: "Marta",
            memberInactive: false,
          }),
        ],
        onMembersList: () => jsonResponse({ error: "boom" }, 500),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-edit-dev-members-fail-assigned"));

    const select = screen.getByTestId(
      "network-devices-edit-member-dev-members-fail-assigned"
    ) as HTMLSelectElement;
    expect(select.value).toBe("member-x");
    expect(within(select).getByText(/Marta/)).toBeInTheDocument();
  });

  // The four 502 cases below classify PURELY on the response's `code` field (review
  //) — `.message` is deliberately varied/irrelevant across them, proving the client
  // no longer pattern-matches server text (the reviewer's M7 concern: a server message
  // reword can no longer silently misclassify the error).
  it("block: 502 code=controller_unavailable renders its dedicated localized error, list stays intact", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    const initial = device({ id: "dev-502", isBlocked: false });
    mockFetch.mockImplementation(
      mockRouter({
        devices: [initial],
        members: [],
        onBlock: () =>
          jsonResponse(
            { error: "some totally reworded server sentence", code: "controller_unavailable" },
            502
          ),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");

    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-502"));

    const rowErr = await screen.findByTestId("network-devices-row-error-dev-502");
    expect(rowErr).toHaveTextContent(messages.en["networkDevices.error.controllerUnavailable"]);
    // The list is intact — the row is still present and its belief unchanged (no mirror write).
    expect(screen.getByTestId("network-devices-row-dev-502")).toBeInTheDocument();
    expect(screen.getByTestId("network-devices-toggle-block-dev-502")).toHaveTextContent(
      messages.en["networkDevices.action.block"]
    );
  });

  it("block: 502 code=controller_rejected renders its OWN dedicated localized error (message text ignored)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-rejected" })],
        members: [],
        onBlock: () =>
          jsonResponse(
            { error: "The network controller is not configured.", code: "controller_rejected" },
            502
          ),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-rejected"));

    const rowErr = await screen.findByTestId("network-devices-row-error-dev-rejected");
    // The message SAYS "not configured" (the unavailable wording) but the CODE says
    // rejected — the code wins, proving classification is code-based, not text-based.
    expect(rowErr).toHaveTextContent(messages.en["networkDevices.error.controllerRejected"]);
  });

  it("block: 502 code=controller_unreachable renders its OWN dedicated localized error", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-unreachable" })],
        members: [],
        onBlock: () => jsonResponse({ error: "boom", code: "controller_unreachable" }, 502),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-unreachable"));

    const rowErr = await screen.findByTestId("network-devices-row-error-dev-unreachable");
    expect(rowErr).toHaveTextContent(messages.en["networkDevices.error.controllerUnreachable"]);
  });

  it("block: 502 with an absent/unknown code renders the NEUTRAL generic message, never controllerUnavailable", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-unknown-code" })],
        members: [],
        // No `code` at all — an unmapped 502. Must NOT default to "unavailable" (the spec's
        // unset-vs-rejected edge case forbids conflating "no code" with "not configured").
        onBlock: () => jsonResponse({ error: "unexpected upstream failure" }, 502),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-unknown-code"));

    const rowErr = await screen.findByTestId("network-devices-row-error-dev-unknown-code");
    expect(rowErr).toHaveTextContent(messages.en["networkDevices.error.controllerGeneric"]);
    expect(rowErr).not.toHaveTextContent(messages.en["networkDevices.error.controllerUnavailable"]);
  });

  it("PR-E review P2-5: a failed members read degrades ONLY the assignment select — the registry still renders", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-members-down", alias: "Marta's iPad" })],
        onMembersList: () => jsonResponse({ error: "boom" }, 500),
      })
    );

    renderManagement();

    // The registry itself is untouched by the members failure.
    const list = await screen.findByTestId("network-devices-list");
    expect(within(list).getByText("Marta's iPad")).toBeInTheDocument();
    expect(screen.queryByTestId("network-devices-error")).not.toBeInTheDocument();

    // The members failure gets its OWN dedicated message, distinct from the list error.
    const membersErr = await screen.findByTestId("network-devices-members-error");
    expect(membersErr).toHaveTextContent(messages.en["networkDevices.error.membersLoadError"]);
  });

  it("PR-E review P2-5: a failed devices read suppresses the empty-state text (no contradictory 'no devices yet')", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        members: [],
        onDevicesList: () => jsonResponse({ error: "boom" }, 500),
      })
    );

    renderManagement();

    const listErr = await screen.findByTestId("network-devices-error");
    expect(listErr).toHaveTextContent(messages.en["networkDevices.management.loadError"]);
    expect(screen.queryByTestId("network-devices-empty")).not.toBeInTheDocument();
  });

  it("PR-E review P2-3: a pre-response transport failure loading the list renders the localized fallback, never the raw exception", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        members: [],
        onDevicesList: () => {
          throw new TypeError("Failed to fetch");
        },
      })
    );

    renderManagement();

    const listErr = await screen.findByTestId("network-devices-error");
    expect(listErr).toHaveTextContent(messages.en["networkDevices.management.loadError"]);
    expect(listErr).not.toHaveTextContent("Failed to fetch");
  });

  it("PR-E review P2-3: a pre-response transport failure registering a device renders the localized fallback, never the raw exception", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [],
        members: [],
        liveClients: {
          state: "fresh",
          clients: [{ mac: MAC, displayName: null, isBlocked: false }],
        },
        onRegister: () => {
          throw new TypeError("Failed to fetch");
        },
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-empty");
    fireEvent.click(screen.getByTestId("network-devices-open-picker"));
    await screen.findByTestId("network-devices-picker-clients");

    fireEvent.click(screen.getByTestId(`network-devices-picker-select-${MAC}`));
    fireEvent.change(screen.getByTestId("network-devices-picker-alias-input"), {
      target: { value: "New Alias" },
    });
    fireEvent.click(screen.getByTestId("network-devices-picker-submit"));

    const err = await screen.findByTestId("network-devices-picker-error");
    expect(err).toHaveTextContent(messages.en["networkDevices.error.registerGeneric"]);
    expect(err).not.toHaveTextContent("Failed to fetch");
  });

  it("PR-E review P2-3: a pre-response transport failure blocking a device renders the localized fallback, never the raw exception", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-transport-fail" })],
        members: [],
        onBlock: () => {
          throw new TypeError("Failed to fetch");
        },
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-toggle-block-dev-transport-fail"));

    const rowErr = await screen.findByTestId("network-devices-row-error-dev-transport-fail");
    expect(rowErr).toHaveTextContent(messages.en["networkDevices.error.blockGeneric"]);
    expect(rowErr).not.toHaveTextContent("Failed to fetch");
  });

  it("delete: the confirmation for a BLOCKED device names the stranded upstream block", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-del-blocked", isBlocked: true })],
        members: [],
        onDelete: () => jsonResponse(null, 204),
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-delete-dev-del-blocked"));

    expect(confirmSpy).toHaveBeenCalledWith(
      messages.en["networkDevices.action.deleteConfirmBlocked"]
    );
    expect(messages.en["networkDevices.action.deleteConfirmBlocked"].toLowerCase()).toContain(
      "block"
    );

    await waitFor(() => {
      expect(screen.queryByTestId("network-devices-row-dev-del-blocked")).not.toBeInTheDocument();
    });

    confirmSpy.mockRestore();
  });

  it("delete: cancelling the confirmation performs NO request and keeps the row", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(
      mockRouter({
        devices: [device({ id: "dev-keep" })],
        members: [],
        onDelete: () => {
          throw new Error("DELETE must not be called when the confirmation is cancelled");
        },
      })
    );

    renderManagement();
    await screen.findByTestId("network-devices-list");
    fireEvent.click(screen.getByTestId("network-devices-delete-dev-keep"));

    expect(screen.getByTestId("network-devices-row-dev-keep")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
