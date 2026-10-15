import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFRESH_MS,
  controllerErrorMessageKey,
  loadFailureMessageKey,
  useNetworkDevicesData,
} from "@/admin/network-devices/data";
import { AUTH_SCOPE_DENIED_CODE } from "../../src/shared";
import type { RegisteredDevice } from "../../src/shared";

function dev(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
  return {
    id: "dev-1",
    mac: "aa:bb:cc:dd:ee:ff",
    alias: "iPad",
    memberId: null,
    memberLabel: null,
    memberInactive: false,
    isBlocked: false,
    beliefDiverged: false,
    lastSeenAt: 1,
    liveStatus: "online",
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("network-devices data helpers", () => {
  it("maps the three controller codes and falls back to the neutral generic key", () => {
    expect(controllerErrorMessageKey("controller_unavailable")).toBe(
      "networkDevices.error.controllerUnavailable"
    );
    expect(controllerErrorMessageKey("controller_rejected")).toBe(
      "networkDevices.error.controllerRejected"
    );
    expect(controllerErrorMessageKey("controller_unreachable")).toBe(
      "networkDevices.error.controllerUnreachable"
    );
    expect(controllerErrorMessageKey(undefined)).toBe("networkDevices.error.controllerGeneric");
    expect(controllerErrorMessageKey("whatever")).toBe("networkDevices.error.controllerGeneric");
  });

  it("only a scope-denied 403 maps to the management-required message", () => {
    const generic = "networkDevices.management.loadError" as const;
    expect(loadFailureMessageKey(403, AUTH_SCOPE_DENIED_CODE, generic)).toBe(
      "networkDevices.error.managementRequired"
    );
    expect(loadFailureMessageKey(403, undefined, generic)).toBe(generic);
    expect(loadFailureMessageKey(500, AUTH_SCOPE_DENIED_CODE, generic)).toBe(generic);
  });
});

describe("useNetworkDevicesData", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  function route(handlers: {
    devices: () => Response | Promise<Response>;
    members?: () => Response;
  }) {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/network-devices") return handlers.devices();
      if (url === "/api/members") return handlers.members ? handlers.members() : json([]);
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("loads devices, cache state and only ACTIVE members", async () => {
    route({
      devices: () => json({ devices: [dev()], cacheState: "fresh" }),
      members: () =>
        json([
          { id: "m1", displayName: "A", lifecycle: "active" },
          { id: "m2", displayName: "B", lifecycle: "archived" },
        ]),
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.devices).toHaveLength(1);
    expect(result.current.cacheState).toBe("fresh");
    expect(result.current.members.map((m) => m.id)).toEqual(["m1"]);
  });

  it("a scope-denied 403 on the list sets the management-required key; a members failure stays independent", async () => {
    route({
      devices: () => json({ error: "forbidden", code: AUTH_SCOPE_DENIED_CODE }, 403),
      members: () => json(null, 500),
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.listErrorKey).toBe("networkDevices.error.managementRequired");
    expect(result.current.membersErrorKey).toBe("networkDevices.error.membersLoadError");
  });

  it("refreshes silently every REFRESH_MS, without flipping loading", async () => {
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        return json({ devices: [dev({ alias: `v${calls}` })], cacheState: "fresh" });
      },
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.devices[0]?.alias).toBe("v1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    await waitFor(() => expect(result.current.devices[0]?.alias).toBe("v2"));
    expect(result.current.loading).toBe(false);
  });

  it("skips the refresh while the tab is hidden", async () => {
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        return json({ devices: [dev()], cacheState: "fresh" });
      },
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
    });
    expect(calls).toBe(1);
  });

  it("discards a refresh that was in flight while a mutation happened", async () => {
    let release: (r: Response) => void = () => {};
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        if (calls === 1) return json({ devices: [dev({ isBlocked: false })], cacheState: "fresh" });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    // The user blocks the device while the refresh GET is still pending.
    act(() => {
      result.current.markMutation();
      result.current.applyDevice(dev({ isBlocked: true }));
    });
    await act(async () => {
      release(json({ devices: [dev({ isBlocked: false })], cacheState: "fresh" }));
    });
    expect(result.current.devices[0].isBlocked).toBe(true);
  });

  it("stops refreshing after unmount", async () => {
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        return json({ devices: [], cacheState: "fresh" });
      },
    });
    const { result, unmount } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(calls).toBe(1);
  });
});
