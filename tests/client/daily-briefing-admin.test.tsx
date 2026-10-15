import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyBriefingManagement } from "@/admin/DailyBriefingManagement";
import { LanguageProvider } from "@/i18n";

/** — the daily-briefing ADMIN panel settings-layer extensions (FR-022): schedule +
 * trigger BINDING (Schedule tab), the blocks × weekdays matrix (Blocks tab, opted-in member
 * only) and the stored-image preview (Briefings tab). The existing generate/opt-in flow is
 * covered by daily-briefing-management.test.tsx; this file covers only the settings surfaces.
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

/** Ada opted in: the Blocks matrix and the Briefings workspace render only for an opted-in
 * selected member, and the default selection is the first opted-in one. */
const ADA_OPTED_IN = [{ memberId: "member-ada", enabled: true }];

/** Applies one automation edit; Save turning enabled proves the draft is dirty. */
async function editAutomation(edit: () => void, applied: () => void) {
  edit();
  applied();
  await waitFor(() =>
    expect(screen.getByTestId("daily-briefing-admin-settings-save")).toBeEnabled()
  );
}

function changeGenerationTime(value: string) {
  return editAutomation(
    () =>
      fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
        target: { value },
      }),
    () => expect(screen.getByTestId("daily-briefing-admin-generation-time")).toHaveValue(value)
  );
}

function setTriggerBinding(bound: boolean) {
  const checkbox = () => screen.getByTestId("daily-briefing-admin-trigger-binding");
  return editAutomation(
    () => fireEvent.click(checkbox()),
    () => expect((checkbox() as HTMLInputElement).checked).toBe(bound)
  );
}

function putCalls(mockFetch: ReturnType<typeof vi.fn>) {
  return (mockFetch.mock.calls as FetchCall[]).filter(([, init]) => init?.method === "PUT");
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

    await screen.findByTestId("daily-briefing-admin-generation-time");
    await changeGenerationTime("07:30");
    await setTriggerBinding(true);
    fireEvent.click(screen.getByTestId("daily-briefing-admin-settings-save"));

    await waitFor(() => {
      expect(putBody).toEqual({ generationTime: "07:30", autoPrintTrigger: "morning_complete" });
    });
    // Saved: the draft equals the stored values again, so Save is disabled until the next change.
    await waitFor(() => {
      expect(screen.getByTestId("daily-briefing-admin-trigger-binding")).toBeEnabled();
      expect(screen.getByTestId("daily-briefing-admin-settings-save")).toBeDisabled();
    });
    expect(screen.getByTestId("daily-briefing-admin-trigger-binding")).toBeChecked();

    // Unbind: must send null, never false.
    await setTriggerBinding(false);
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

    await screen.findByTestId("daily-briefing-admin-generation-time");
    await changeGenerationTime("07:30");
    fireEvent.click(screen.getByTestId("daily-briefing-admin-settings-save"));

    expect(await screen.findByTestId("daily-briefing-admin-settings-error")).toHaveTextContent(
      "Failed to save Daily Briefing settings."
    );
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
      if (url === "/api/daily-briefing/opt-in") return jsonResponse(ADA_OPTED_IN);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));
    await screen.findByTestId("daily-briefing-block-matrix");

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
    const putBodies: unknown[] = [];
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse(ADA_OPTED_IN);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      if (
        url === "/api/daily-briefing/block-settings/member-ada/wordOfDay" &&
        init?.method === "PUT"
      ) {
        const body = JSON.parse(String(init.body)) as object;
        putBodies.push(body);
        // Echo the body into the stored row, so the next click starts from it.
        return jsonResponse({
          memberId: "member-ada",
          blockType: "wordOfDay",
          params: null,
          updatedAt: 1,
          ...body,
        });
      }
      throw new Error(`unexpected fetch: ${url}${init?.method ? ` (${init.method})` : ""}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));
    const cell = (day: string) => screen.getByTestId(`daily-briefing-block-cell-wordOfDay-${day}`);
    await screen.findByTestId("daily-briefing-block-matrix");

    // All 7 start checked (weekdays: null = all days). Uncheck in a non-canonical click order:
    // fri, then mon — the resulting persisted array must still read mon..sun canonically.
    fireEvent.click(cell("fri"));
    await waitFor(() => {
      expect(putBodies.at(-1)).toEqual({
        enabled: true,
        weekdays: ["mon", "tue", "wed", "thu", "sat", "sun"],
      });
    });
    await waitFor(() => expect(cell("fri")).not.toBeChecked());
    await waitFor(() => expect(cell("mon")).toBeEnabled());

    fireEvent.click(cell("mon"));
    await waitFor(() => {
      expect(putBodies.at(-1)).toEqual({
        enabled: true,
        weekdays: ["tue", "wed", "thu", "sat", "sun"],
      });
    });
    await waitFor(() => expect(cell("mon")).not.toBeChecked());
    await waitFor(() => expect(cell("fri")).toBeEnabled());

    // Re-check fri (mon still unchecked) — the re-added day must land back
    // in its canonical mon..sun slot (between thu and sat), never appended at the end.
    fireEvent.click(cell("fri"));
    await waitFor(() => {
      expect(putBodies.at(-1)).toEqual({
        enabled: true,
        weekdays: ["tue", "wed", "thu", "fri", "sat", "sun"],
      });
    });
    expect(putBodies).toHaveLength(3);

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
      if (url === "/api/daily-briefing/opt-in") return jsonResponse(ADA_OPTED_IN);
      if (url === "/api/daily-briefing/settings") return jsonResponse(defaultSettings());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));

    expect(
      await screen.findByTestId("daily-briefing-admin-block-default-disabled-onThisDay")
    ).toBeVisible();
    // Every other type defaults enabled on every day — dadJoke stands in for them.
    for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
      expect(screen.getByTestId(`daily-briefing-block-cell-onThisDay-${day}`)).not.toBeChecked();
      expect(screen.getByTestId(`daily-briefing-block-cell-dadJoke-${day}`)).toBeChecked();
    }

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
      if (url === "/api/daily-briefing/opt-in") return jsonResponse(ADA_OPTED_IN);
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
      // The date input loads on change (no Show button): step away and back to refetch.
      const dateInput = screen.getByTestId("daily-briefing-admin-preview-date");
      fireEvent.change(dateInput, { target: { value: "2026-09-08" } });
      fireEvent.change(dateInput, { target: { value: "2026-09-07" } });
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

  it("automation and matrix stay absent while the settings GET is pending, then appear", async () => {
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
      if (url === "/api/daily-briefing/opt-in") return Promise.resolve(jsonResponse(ADA_OPTED_IN));
      if (url === "/api/daily-briefing/settings") return settingsGetPending;
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    // No write may derive from an unloaded snapshot: neither the automation card's Save nor the
    // matrix exists until the settings GET resolves.
    await screen.findByTestId("daily-briefing-opt-in-member-ada");
    expect(screen.queryByTestId("daily-briefing-admin-settings-save")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
    expect(screen.getByTestId("daily-briefing-blocks-workspace")).toBeVisible();
    expect(screen.queryByTestId("daily-briefing-block-matrix")).not.toBeInTheDocument();
    expect(putCalls(mockFetch)).toHaveLength(0);

    resolveSettingsGet?.(jsonResponse(defaultSettings()));

    expect(await screen.findByTestId("daily-briefing-block-matrix")).toBeVisible();
    fireEvent.click(screen.getByTestId("daily-briefing-tab-schedule"));
    // Present, and disabled until the draft differs from the loaded values.
    expect(await screen.findByTestId("daily-briefing-admin-settings-save")).toBeDisabled();
    expect(putCalls(mockFetch)).toHaveLength(0);
    assertNoImplicitRegenerate(mockFetch);
  });

  it("after the settings GET fails nothing can be written and Retry recovers", async () => {
    let settingsFail = true;
    const mockFetch = vi.fn(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse(ADA_OPTED_IN);
      if (url === "/api/daily-briefing/settings") {
        return settingsFail
          ? jsonResponse({ error: "internal_error" }, 500)
          : jsonResponse(defaultSettings());
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    renderManagement();

    const loadError = await screen.findByTestId("daily-briefing-settings-load-error");
    expect(loadError).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("daily-briefing-admin-settings-save")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
    expect(screen.queryByTestId("daily-briefing-block-matrix")).not.toBeInTheDocument();
    // The concrete data-loss scenario (a PUT built from empty local state after a failed GET)
    // has no control to start it from.
    expect(putCalls(mockFetch)).toHaveLength(0);

    settingsFail = false;
    fireEvent.click(screen.getByTestId("daily-briefing-settings-retry"));
    expect(await screen.findByTestId("daily-briefing-block-matrix")).toBeVisible();
    expect(screen.queryByTestId("daily-briefing-settings-load-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("daily-briefing-tab-schedule"));
    expect(await screen.findByTestId("daily-briefing-admin-settings-save")).toBeDisabled();
    expect(putCalls(mockFetch)).toHaveLength(0);
    assertNoImplicitRegenerate(mockFetch);
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
        if (url === "/api/daily-briefing/opt-in") return jsonResponse(ADA_OPTED_IN);
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
      fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));
      const animalFactRow = await screen.findByTestId(
        "daily-briefing-admin-block-settings-row-animalFact"
      );
      await waitFor(() =>
        expect(animalFactRow).toHaveTextContent(
          language === "es" ? "Curiosidad animal" : "Animal fact"
        )
      );
      expect(
        screen.getByTestId("daily-briefing-admin-block-settings-row-shotgun")
      ).toHaveTextContent(language === "es" ? "Copiloto" : "Shotgun");
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
