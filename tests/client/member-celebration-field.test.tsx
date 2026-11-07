/** The member dialog's Celebration field (#92): preset choice, a custom set built and trimmed
 * with the emoji picker, the preview, and who gets the field.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MembersManagement } from "@/admin/MembersManagement";
import { resetCelebrationSoundForTests } from "@/chores/celebration-sound";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

const CHILD = {
  id: "m1",
  displayName: "Ari",
  colorKey: "violet",
  role: "child",
  lifecycle: "active",
  createdAt: 0,
  updatedAt: 0,
  birthDate: null,
  celebration: { preset: "stars" },
};
const PARENT = { ...CHILD, id: "m2", displayName: "Noor", colorKey: "sky", role: "parent" };

function mockBackend(sound = true) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/settings")) {
      return Promise.resolve(
        json({
          locale: { timezone: "UTC", language: "en", weekStartDay: 1 },
          celebration: { sound },
        })
      );
    }
    if (url.startsWith("/api/members") && method === "GET") {
      return Promise.resolve(json([CHILD, PARENT]));
    }
    if (url.startsWith("/api/members/") && method === "PATCH") {
      return Promise.resolve(json({ ...CHILD, ...JSON.parse(String(init?.body)) }));
    }
    throw new Error(`unexpected fetch: ${url} (${method})`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function patchBody(mockFetch: ReturnType<typeof mockBackend>) {
  const call = mockFetch.mock.calls.find(([, init]) => init?.method === "PATCH");
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

async function openMember(id: string) {
  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <MembersManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
  fireEvent.click(await screen.findByTestId(`member-card-${id}`));
  return screen.findByTestId("member-form-dialog");
}

describe("member celebration field", () => {
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    resetCelebrationSoundForTests();
    play = vi.fn<() => Promise<void>>(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the member's preset and saves another one", async () => {
    const mockFetch = mockBackend();
    await openMember("m1");
    expect(screen.getByTestId("member-celebration-preset-stars")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    fireEvent.click(screen.getByTestId("member-celebration-preset-soccer"));
    expect(screen.getByTestId("member-celebration-preset-soccer")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    fireEvent.click(screen.getByTestId("member-save"));
    await waitFor(() => expect(patchBody(mockFetch).celebration).toEqual({ preset: "soccer" }));
  });

  it("moves between presets with the arrow keys", async () => {
    mockBackend();
    await openMember("m1");
    fireEvent.keyDown(screen.getByTestId("member-celebration-preset-stars"), {
      key: "ArrowRight",
    });
    expect(screen.getByTestId("member-celebration-preset-videogames")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    fireEvent.keyDown(screen.getByTestId("member-celebration-preset-videogames"), { key: "End" });
    expect(screen.getByTestId("member-celebration-preset-custom")).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("builds a custom set from the current one, adds and removes emojis, and saves it", async () => {
    const mockFetch = mockBackend();
    await openMember("m1");
    fireEvent.click(screen.getByTestId("member-celebration-preset-custom"));
    const custom = screen.getByTestId("member-celebration-custom");
    expect(screen.getByTestId("member-celebration-custom-hint")).toHaveTextContent("4 of 6 emojis");

    // Remove the first emoji (⭐).
    fireEvent.click(within(custom).getByRole("button", { name: /Celebration emoji: ⭐/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove this emoji" }));
    // Add a unicorn.
    fireEvent.click(within(custom).getByRole("button", { name: "Add a celebration emoji" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search icons" }), {
      target: { value: "unicorn" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Select Unicorn/ }));

    fireEvent.click(screen.getByTestId("member-save"));
    await waitFor(() =>
      expect(patchBody(mockFetch).celebration).toEqual({
        preset: "custom",
        emojis: ["🌟", "✨", "💫", "🦄"],
      })
    );
  });

  it("blocks saving an empty custom set", async () => {
    mockBackend();
    await openMember("m1");
    fireEvent.click(screen.getByTestId("member-celebration-preset-confetti"));
    fireEvent.click(screen.getByTestId("member-celebration-preset-custom"));
    expect(screen.getByTestId("member-celebration-custom-hint")).toHaveTextContent(
      "Pick at least one emoji."
    );
    expect(screen.getByTestId("member-save")).toBeDisabled();
    expect(screen.getByTestId("member-celebration-preview")).toBeDisabled();
  });

  it("previews the celebration in place, with the household sound", async () => {
    mockBackend(true);
    await openMember("m1");
    fireEvent.click(screen.getByTestId("member-celebration-preview"));
    const overlay = await screen.findByTestId("completion-celebration");
    expect(
      new Set(
        within(overlay)
          .getAllByTestId("completion-celebration-particle")
          .map((particle) => particle.getAttribute("data-symbol"))
      )
    ).toEqual(new Set(["⭐", "🌟", "✨", "💫"]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });

  it("previews silently when the household sound is off", async () => {
    mockBackend(false);
    await openMember("m1");
    // The settings read must land before the preview reads the switch.
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/settings")).toBe(
        true
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByTestId("member-celebration-preview"));
    await screen.findByTestId("completion-celebration");
    expect(play).not.toHaveBeenCalled();
  });

  it("offers no celebration to a parent, who has no column on the board", async () => {
    const mockFetch = mockBackend();
    await openMember("m2");
    expect(screen.queryByTestId("member-celebration-field")).toBeNull();
    expect(screen.getByTestId("member-celebration-unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("member-save"));
    await waitFor(() => expect(patchBody(mockFetch)).not.toHaveProperty("celebration"));
  });
});
