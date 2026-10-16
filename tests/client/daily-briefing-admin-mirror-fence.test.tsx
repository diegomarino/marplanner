import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyBriefingManagement } from "@/admin/DailyBriefingManagement";
import { LanguageProvider } from "@/i18n";
// Tests MAY cross the client/server boundary — the panel hand-mirrors these two server
// constants (it cannot import them at runtime), so this test is the fence that reds when the
// server's source of truth drifts from the panel's copy.
import {
  ALL_BLOCK_TYPES,
  CORPUS_LANGUAGE_AVAILABILITY,
} from "../../src/server/modules/daily-briefing/corpora/block-types";

const activeMembers = [
  {
    id: "member-ada",
    displayName: "Ada",
    colorKey: "blue",
    role: "child",
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    birthDate: null,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function openBlocksTab() {
  fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));
  await screen.findByTestId("daily-briefing-block-matrix");
}

describe("daily-briefing admin panel — server-constant mirror fence", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/settings") {
          return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
        }
        if (url === "/api/members") return jsonResponse(activeMembers);
        if (url === "/api/daily-briefing/opt-in") {
          // Ada opted in: the matrix renders only for an opted-in selected member.
          return jsonResponse([{ memberId: "member-ada", enabled: true }]);
        }
        if (url === "/api/daily-briefing/settings") {
          return jsonResponse({
            generationTime: "06:00",
            autoPrintTrigger: null,
            blockOrder: [],
            memberBlockSettings: [],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("lists exactly the server's ALL_BLOCK_TYPES as matrix rows, in registry order", async () => {
    render(
      <LanguageProvider>
        <DailyBriefingManagement />
      </LanguageProvider>
    );
    await openBlocksTab();
    // blockOrder is [] in the fixture, so the rows fall back to registry order.
    const rows = screen
      .getAllByTestId(/^daily-briefing-admin-block-settings-row-/)
      .map((row) => row.dataset.testid?.replace("daily-briefing-admin-block-settings-row-", ""));
    expect(rows).toEqual([...ALL_BLOCK_TYPES]);
  });

  it("offers exactly the server's CORPUS_LANGUAGE_AVAILABILITY per block type", async () => {
    render(
      <LanguageProvider>
        <DailyBriefingManagement />
      </LanguageProvider>
    );
    await openBlocksTab();
    for (const type of ALL_BLOCK_TYPES) {
      const expected = (CORPUS_LANGUAGE_AVAILABILITY as Record<string, readonly string[]>)[type];
      const control = screen.queryByTestId(`daily-briefing-admin-block-language-${type}`);
      if (!expected) {
        expect(control, `${type} is not corpus-backed — no language control`).toBeNull();
        continue;
      }
      expect(control, `${type} is corpus-backed — language control required`).not.toBeNull();
      const values = Array.from(control!.querySelectorAll("option"))
        .map((option) => option.value)
        .filter((value) => value !== "");
      expect(values, `${type} language options`).toEqual([...expected]);
    }
  });

  it("renders a settings row for every server block type", async () => {
    render(
      <LanguageProvider>
        <DailyBriefingManagement />
      </LanguageProvider>
    );
    await openBlocksTab();
    for (const type of ALL_BLOCK_TYPES) {
      expect(
        screen.queryByTestId(`daily-briefing-admin-block-settings-row-${type}`),
        `missing row for ${type}`
      ).not.toBeNull();
    }
  });
});
