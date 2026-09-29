import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoresBoard } from "@/chores/ChoresBoard";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";

/** — GET /api/chores/board with zero active children renders the
 * `noChildren` empty state (FR-017/018, docs/features/routines-chores.md), not
 * the board grid. Previously only covered at the API layer
 * (tests/boundary/routines-board.test.ts) and by i18n-string-presence
 * (tests/client/routines-i18n-parity.test.ts) — neither renders
 * `<ChoresBoard/>`. Mirrors the mock-fetch shape used by
 * tests/client/meals-board.test.tsx.
 */
describe("ChoresBoard — zero-active-children empty state (#415)", () => {
  function settingsResponse(timezone = "UTC") {
    return new Response(JSON.stringify({ locale: { timezone } }), { status: 200 });
  }

  function boardResponse() {
    return new Response(JSON.stringify([]), { status: 200 });
  }

  function mockFetch() {
    return vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/settings")) return Promise.resolve(settingsResponse());
      if (url.includes("/api/chores/board")) return Promise.resolve(boardResponse());
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the noChildren message and omits the board grid", async () => {
    vi.stubGlobal("fetch", mockFetch());

    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <ChoresBoard />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );

    expect(
      await screen.findByText("No active children yet. Add a child in Members Management.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chores-board")).not.toBeInTheDocument();
  });
});
