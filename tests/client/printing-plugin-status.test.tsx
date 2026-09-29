import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePrintingPluginActive } from "@/printing/pluginStatus";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import type { PluginCatalogEntry, PluginId, PluginState } from "../../src/shared/plugins";

/** FR-013 client half — `usePrintingPluginActive`'s own fail-safe polarity in
 * isolation, independent of any consumer (`PrintExecutor`/`AdminGate`). See that hook's doc
 * comment (`src/client/printing/pluginStatus.ts`) for the full rationale.
 */
const IDS = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
] as const;

function entry(id: PluginId, state: PluginState): PluginCatalogEntry {
  return {
    id,
    label: id,
    description: id,
    trustTier: "first-party",
    contributions: {
      routes: [],
      admin: [],
      settings: [],
      widgets: [],
      services: id === "printing" ? ["printing-executor"] : [],
      jobs: [],
    },
    requirements: [],
    settingsSchema: [],
    state,
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error: null,
  };
}

describe("usePrintingPluginActive (Slice 026 T010)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return <PluginCatalogProvider>{children}</PluginCatalogProvider>;
  }

  it("defaults to false before the authenticated catalog resolves", () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves within this test
    const { result } = renderHook(() => usePrintingPluginActive(), { wrapper });
    expect(result.current).toBe(false);
  });

  it("derives active state from the shared catalog without polling the Printing status endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          plugins: IDS.map((id) => entry(id, id === "printing" ? "active" : "inactive")),
        }),
        { status: 200 }
      )
    );
    const { result } = renderHook(() => usePrintingPluginActive(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe("/api/plugins");
  });

  it.each(["inactive", "errored"] as const)("stays false when Printing is %s", async (state) => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          plugins: IDS.map((id) => entry(id, id === "printing" ? state : "active")),
        }),
        { status: 200 }
      )
    );
    const { result } = renderHook(() => usePrintingPluginActive(), { wrapper });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
  });
});
