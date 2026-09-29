import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminGate } from "@/admin/AdminGate";
import { AdminUnlockProvider } from "@/lib/adminUnlock";

/** ADR-061 invariant (lines 60-66): the settings-backed LanguageProvider mounts INSIDE the
 * admin-unlock subtree; the shell performs NO boot-time /api probe. Pre-unlock surfaces
 * (the long-press affordance + the PIN gate) must therefore issue NO authenticated
 * GET /api/settings. Re-hoisting the provider causes this regression test to fail.
 */
describe("AdminGate — ADR-061: no boot-time /api/settings probe pre-unlock", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ locale: { language: "es" } }), { status: 200 }))
    );
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  const settingsCalls = () =>
    mockFetch.mock.calls.filter(([url]) => String(url).includes("/api/settings"));

  it("shows the PIN keypad directly without issuing GET /api/settings", () => {
    render(
      <AdminUnlockProvider>
        <AdminGate />
      </AdminUnlockProvider>
    );

    expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PIN")).not.toBeInTheDocument();
    expect(settingsCalls()).toHaveLength(0);
  });
});
