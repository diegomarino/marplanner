import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyBriefingManagement } from "@/admin/DailyBriefingManagement";
import { LanguageProvider } from "@/i18n";

/** — the daily-briefing ADMIN panel settings-layer extensions (FR-022): schedule +
 * trigger BINDING, block order, and per-member per-block settings. The existing generate/opt-in
 * flow is covered by daily-briefing-management.test.tsx; this file covers only the new surfaces.
 */

type FetchCall = Parameters<typeof globalThis.fetch>;

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

function defaultSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    generationTime: "06:00",
    autoPrintTrigger: null,
    blockOrder: [],
    memberBlockSettings: [],
    ...overrides,
  };
}

function renderManagement() {
  render(
    <LanguageProvider>
      <DailyBriefingManagement />
    </LanguageProvider>
  );
}

/** No test in this file may ever hit generate/generate-all — settings writes only write
 * (FR-022): never regenerate or invalidate a briefing implicitly. */
function assertNoImplicitRegenerate(mockFetch: ReturnType<typeof vi.fn>) {
  const calls = mockFetch.mock.calls as FetchCall[];
  const hitGenerate = calls.some(([input]) => {
    const url = String(input);
    return url === "/api/daily-briefing/generate" || url === "/api/daily-briefing/generate-all";
  });
  expect(hitGenerate).toBe(false);
}

describe("DailyBriefingManagement — admin settings-layer extensions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("loads settings and saves generation time + trigger binding as morning_complete/null", async () => {
    let putBody: unknown;
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings" && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return jsonResponse({
          generationTime: "07:30",
          autoPrintTrigger: (putBody as { autoPrintTrigger: unknown }).autoPrintTrigger,
          updatedAt: 1000,
        });
      }
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}${init?.method ? ` (${init.method})` : ""}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    const timeInput = await screen.findByTestId("daily-briefing-admin-generation-time");
    fireEvent.change(timeInput, { target: { value: "07:30" } });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-trigger-binding"));
    fireEvent.click(screen.getByTestId("daily-briefing-admin-settings-save"));

    await waitFor(() => {
      expect(putBody).toEqual({ generationTime: "07:30", autoPrintTrigger: "morning_complete" });
    });
    expect(
      await screen.findByTestId("daily-briefing-admin-trigger-binding-state")
    ).toHaveTextContent("Bound");

    // Unbind: must send null, never false.
    fireEvent.click(screen.getByTestId("daily-briefing-admin-trigger-binding"));
    fireEvent.click(screen.getByTestId("daily-briefing-admin-settings-save"));
    await waitFor(() => {
      expect(putBody).toEqual({ generationTime: "07:30", autoPrintTrigger: null });
    });
    expect(typeof (putBody as { autoPrintTrigger: unknown }).autoPrintTrigger).not.toBe("boolean");

    assertNoImplicitRegenerate(mockFetch);
  });

  it("surfaces a validation error from the settings save", async () => {
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings" && init?.method === "PUT") {
        return jsonResponse(
          { error: "validation_error", message: 'Invalid generationTime "99:99"' },
          400
        );
      }
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.change(await screen.findByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "07:30" },
    });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-settings-save"));

    expect(await screen.findByTestId("daily-briefing-admin-settings-error")).toHaveTextContent(
      "Failed to save Daily Briefing settings."
    );
    assertNoImplicitRegenerate(mockFetch);
  });

  it("block order editor sends the ordered array including a repeated type", async () => {
    let putBody: unknown;
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/block-order" && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return jsonResponse({ blockOrder: putBody });
      }
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    const addSelect = await screen.findByTestId("daily-briefing-admin-block-order-add-select");
    fireEvent.change(addSelect, { target: { value: "dadJoke" } });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-order-add-button"));
    fireEvent.change(addSelect, { target: { value: "dadJoke" } });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-order-add-button"));
    fireEvent.change(addSelect, { target: { value: "wordOfDay" } });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-order-add-button"));

    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-order-save"));

    await waitFor(() => {
      expect(putBody).toEqual([{ type: "dadJoke" }, { type: "dadJoke" }, { type: "wordOfDay" }]);
    });
    assertNoImplicitRegenerate(mockFetch);
  });

  it("language select is absent on a non-corpus type and offers only the available languages", async () => {
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.change(
      await screen.findByTestId("daily-briefing-admin-block-settings-member-select"),
      { target: { value: "member-ada" } }
    );

    // "message" is not corpus-backed — no language override control at all (FR-008).
    expect(
      screen.queryByTestId("daily-briefing-admin-block-language-message")
    ).not.toBeInTheDocument();

    // "wordSearch" is corpus-backed but ships English-only — only "en" is offered, never "es".
    const wordSearchLanguage = screen.getByTestId("daily-briefing-admin-block-language-wordSearch");
    const wordSearchOptions = Array.from(wordSearchLanguage.querySelectorAll("option")).map(
      (option) => option.value
    );
    expect(wordSearchOptions).toEqual(["", "en"]);

    // "animalFact" ships both — the availability map's full list is offered.
    const animalFactLanguage = screen.getByTestId("daily-briefing-admin-block-language-animalFact");
    const animalFactOptions = Array.from(animalFactLanguage.querySelectorAll("option")).map(
      (option) => option.value
    );
    expect(animalFactOptions).toEqual(["", "en", "es"]);

    assertNoImplicitRegenerate(mockFetch);
  });

  it("weekday toggles always send the canonical mon..sun order regardless of click order", async () => {
    let putBody: unknown;
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      if (
        url === "/api/daily-briefing/block-settings/member-ada/wordOfDay" &&
        init?.method === "PUT"
      ) {
        putBody = JSON.parse(String(init.body));
        return jsonResponse({
          memberId: "member-ada",
          blockType: "wordOfDay",
          enabled: true,
          weekdays: (putBody as { weekdays: unknown }).weekdays,
          params: null,
          updatedAt: 1,
        });
      }
      throw new Error(`unexpected fetch: ${url}${init?.method ? ` (${init.method})` : ""}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.change(
      await screen.findByTestId("daily-briefing-admin-block-settings-member-select"),
      { target: { value: "member-ada" } }
    );

    // All 7 start checked (weekdays: null = all days). Uncheck in a non-canonical click order:
    // fri, then mon — the resulting persisted array must still read mon..sun canonically.
    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-weekday-wordOfDay-fri"));
    await waitFor(() => {
      expect(putBody).toEqual({ weekdays: ["mon", "tue", "wed", "thu", "sat", "sun"] });
    });

    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-weekday-wordOfDay-mon"));
    await waitFor(() => {
      expect(putBody).toEqual({ weekdays: ["tue", "wed", "thu", "sat", "sun"] });
    });

    //: re-check fri (mon still unchecked) — the re-added day must land back
    // in its canonical mon..sun slot (between thu and sat), never appended at the end.
    fireEvent.click(screen.getByTestId("daily-briefing-admin-block-weekday-wordOfDay-fri"));
    await waitFor(() => {
      expect(putBody).toEqual({ weekdays: ["tue", "wed", "thu", "fri", "sat", "sun"] });
    });

    assertNoImplicitRegenerate(mockFetch);
  });

  it("surfaces onThisDay's default-disabled reality on its row", async () => {
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.change(
      await screen.findByTestId("daily-briefing-admin-block-settings-member-select"),
      { target: { value: "member-ada" } }
    );

    expect(
      await screen.findByTestId("daily-briefing-admin-block-default-disabled-onThisDay")
    ).toBeInTheDocument();
    const onThisDayEnabled = screen.getByTestId(
      "daily-briefing-admin-block-enabled-onThisDay"
    ) as HTMLInputElement;
    expect(onThisDayEnabled.checked).toBe(false);

    // Every other type defaults enabled — spot-check one.
    const dadJokeEnabled = screen.getByTestId(
      "daily-briefing-admin-block-enabled-dadJoke"
    ) as HTMLInputElement;
    expect(dadJokeEnabled.checked).toBe(true);

    assertNoImplicitRegenerate(mockFetch);
  });

  // ── FOLD-A — admin PNG preview ──────────────────────────────────────────────

  it("preview fetches the stored image for the selected member/date, honouring the base path", async () => {
    URL.createObjectURL = vi.fn(() => "blob:briefing");
    URL.revokeObjectURL = vi.fn();
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input).replace(/^\/family\/planner/, "");
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      if (url === "/api/printing/status") return jsonResponse({ active: true });
      if (url.startsWith("/api/daily-briefing/history/")) {
        return jsonResponse({ today: "2026-10-15", entries: [] });
      }
      if (/^\/api\/daily-briefing\/[^/]+\/[^/]+\/preview\.png/.test(url)) {
        return new Response("{}", { status: 404 });
      }
      if (/^\/api\/daily-briefing\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(url)) {
        return jsonResponse({ generated: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.click(await screen.findByTestId("daily-briefing-tab-preview"));
    fireEvent.change(await screen.findByTestId("daily-briefing-admin-preview-date"), {
      target: { value: "2026-09-07" },
    });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-preview-show"));

    const previewCalls = (pattern: RegExp) =>
      (mockFetch.mock.calls as FetchCall[]).filter(([input]) => pattern.test(String(input)));
    await waitFor(() =>
      expect(
        previewCalls(/^\/api\/daily-briefing\/member-ada\/2026-09-07\/preview\.png\?v=/)
      ).not.toHaveLength(0)
    );

    const mount = document.createElement("meta");
    mount.name = "mp-base-path";
    mount.content = "/family/planner";
    document.head.append(mount);
    try {
      fireEvent.click(screen.getByTestId("daily-briefing-admin-preview-show"));
      await waitFor(() =>
        expect(
          previewCalls(
            /^\/family\/planner\/api\/daily-briefing\/member-ada\/2026-09-07\/preview\.png\?v=/
          )
        ).not.toHaveLength(0)
      );
    } finally {
      mount.remove();
    }

    assertNoImplicitRegenerate(mockFetch);
  });

  // ── FOLD-B — data-loss gate: no write derives from an unloaded snapshot ──────

  it("block order Save is disabled while the settings GET is pending, then enabled once it resolves", async () => {
    let resolveSettingsGet: ((response: Response) => void) | undefined;
    const settingsGetPending = new Promise<Response>((resolve) => {
      resolveSettingsGet = resolve;
    });
    const mockFetch = vi.fn((...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(
          jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } })
        );
      }
      if (url === "/api/members") return Promise.resolve(jsonResponse(activeMembers));
      if (url === "/api/daily-briefing/opt-in") return Promise.resolve(jsonResponse([]));
      if (url === "/api/daily-briefing/settings") return settingsGetPending;
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    // The block-order Add/Save controls render unconditionally (this is the exact bug: they are
    // NOT gated behind the same "still loading" placeholder the Settings card itself uses).
    const saveButton = await screen.findByTestId("daily-briefing-admin-block-order-save");
    expect(saveButton).toBeDisabled();
    // The Settings card's own Save button is behind a loading placeholder until the GET
    // resolves, so it isn't in the DOM yet — that placeholder-vs-gate distinction is exactly why
    // the block-order card needed its OWN independent gate on `settingsLoaded`.
    expect(screen.queryByTestId("daily-briefing-admin-settings-save")).not.toBeInTheDocument();

    resolveSettingsGet?.(jsonResponse(defaultSettings()));

    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });
    expect(await screen.findByTestId("daily-briefing-admin-settings-save")).not.toBeDisabled();
  });

  it("block order Save stays disabled after the settings GET fails", async () => {
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings")
        return jsonResponse({ error: "internal_error" }, 500);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    const saveButton = await screen.findByTestId("daily-briefing-admin-block-order-save");
    await waitFor(() => {
      expect(screen.getByTestId("daily-briefing-admin-settings-error")).toBeInTheDocument();
    });
    expect(saveButton).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-admin-settings-save")).toBeDisabled();

    // A click while disabled must never reach the network — the concrete data-loss scenario
    // (a PUT built from empty local state after a failed GET) never fires.
    fireEvent.click(saveButton);
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(([input, init]) => {
        return String(input) === "/api/daily-briefing/block-order" && init?.method === "PUT";
      })
    ).toHaveLength(0);
  });
});

it.each(["en", "es"] as const)(
  "translates block and parameter labels without changing persisted identifiers (%s)",
  async (language) => {
    let saved: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url === "/api/settings")
          return jsonResponse({ locale: { language, timezone: "UTC", weekStartDay: 1 } });
        if (url === "/api/members") return jsonResponse(activeMembers);
        if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
        if (url === "/api/daily-briefing/settings")
          return jsonResponse(
            defaultSettings({ blockOrder: [{ type: "animalFact" }, { type: "trivia" }] })
          );
        if (url.endsWith("/member-ada/trivia") && init?.method === "PUT") {
          saved = JSON.parse(init.body as string);
          return jsonResponse({
            memberId: "member-ada",
            blockType: "trivia",
            enabled: true,
            weekdays: null,
            params: { difficulty: "hard" },
            updatedAt: 1,
          });
        }
        throw new Error(`Unexpected request ${url}`);
      })
    );
    try {
      renderManagement();
      const select = await screen.findByTestId("daily-briefing-admin-block-order-add-select");
      await waitFor(() =>
        expect(select.querySelector('option[value="animalFact"]')).toHaveTextContent(
          language === "es" ? "Curiosidad animal" : "Animal fact"
        )
      );
      expect(select.querySelector('option[value="shotgun"]')).toHaveTextContent(
        language === "es" ? "Copiloto" : "Shotgun"
      );
      const difficulty = screen.getByTestId("daily-briefing-admin-block-difficulty-trivia");
      expect(difficulty.querySelector('option[value="hard"]')).toHaveTextContent(
        language === "es" ? "Difícil" : "Hard"
      );
      fireEvent.change(difficulty, { target: { value: "hard" } });
      await waitFor(() => expect(saved).toEqual({ params: { difficulty: "hard" } }));
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  }
);
