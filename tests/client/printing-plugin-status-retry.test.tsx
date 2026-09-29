import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePrintingPluginActive } from "@/printing/pluginStatus";

/** on — `usePrintingPluginActive`'s transient-failure retry.
 * Distinguishes the two "false" paths (see the hook's own doc comment,
 * `src/client/printing/pluginStatus.ts`): a server-ANSWERED `active: false` is authoritative
 * (boot-constant, no retry); a FAILED read (network/non-2xx/malformed — e.g. a 503 while
 * `/api/*` is quiesced mid backup-restore, a real state on a 24/7 kiosk) retries with backoff
 * (5s, 15s, 60s, then every 5min) until a read succeeds, without ever reloading the page.
 */
describe("usePrintingPluginActive — transient-failure retry (Codex #700)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("(1) a transient 503 retries after backoff and flips active true on the next successful read, cleaning up its timer", async () => {
    // First read: a transient 503 (e.g. mid backup-restore quiesce) — a REAL body, not null,
    // so this proves the retry path is driven by `!res.ok`, not by a `.json` parse failure.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 503 })
    );
    // Second read (after the first backoff step): the server is back.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 200 })
    );

    const { result } = renderHook(() => usePrintingPluginActive());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toBe(false); // hidden — the first read failed
    expect(vi.getTimerCount()).toBe(1); // a retry is scheduled

    // Advance past the FIRST backoff step (5s) — this also flushes the microtasks the timer's
    // own retry read spawns (vi.advanceTimersByTimeAsync's documented behavior).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(result.current).toBe(true); // flipped active WITHOUT any page reload
    expect(vi.getTimerCount()).toBe(0); // no leftover timer once a read succeeds
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("(2) a server-answered active: false is authoritative — no retry timer is ever scheduled", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: false }), { status: 200 })
    );

    const { result } = renderHook(() => usePrintingPluginActive());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // boot-constant — nothing scheduled to re-check it

    // Advancing time by even the longest backoff step must never trigger a second read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("(3) unmounting mid-backoff clears the pending timer and never sets state after unmount", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ active: true }), { status: 503 }));

    const { unmount } = renderHook(() => usePrintingPluginActive());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1); // a retry is pending

    // No React "state update on an unmounted component" warning must fire here — the hook's own
    // `cancelled` guard is what prevents it; vi.unstubAllGlobals/cleanup in afterEach would
    // not by itself catch a late setState the way this assertion + the timer-count check do.
    unmount();
    expect(vi.getTimerCount()).toBe(0); // the pending retry timer was cleared on unmount

    const callsBeforeAdvance = mockFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(mockFetch.mock.calls.length).toBe(callsBeforeAdvance); // no read after unmount
  });
});
