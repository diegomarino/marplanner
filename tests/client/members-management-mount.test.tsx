import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MembersManagement } from "@/admin/MembersManagement";

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

/** The active-members list must load on mount, without a manual click on "Refresh".
 * This protects the initial fetch behavior used by the other management panels.
 */
describe("MembersManagement — loads on mount (#683)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/members")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "m1",
                displayName: "Alice",
                role: "child",
                lifecycle: "active",
                createdAt: 0,
                updatedAt: 0,
              },
            ]),
            { status: 200 }
          )
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the members list without clicking Refresh", async () => {
    render(<MembersManagement />);

    // The RED (pre-fix) failure mode: the list never appears because nothing ever calls
    // `/api/members` until a manual Refresh click — this must resolve WITHOUT any interaction.
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/members", expect.anything());
  });
});
