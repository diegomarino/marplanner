import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyBriefingManagement } from "@/admin/DailyBriefingManagement";
import { LanguageProvider } from "@/i18n";

type FetchCall = Parameters<typeof globalThis.fetch>;

const activeMembers = [
  {
    id: "member-ada",
    displayName: "Ada",
    role: "parent",
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    birthDate: null,
  },
  {
    id: "member-ben",
    displayName: "Ben",
    role: "child",
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    birthDate: null,
  },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function renderManagement() {
  render(
    <LanguageProvider>
      <DailyBriefingManagement />
    </LanguageProvider>
  );
}

describe("DailyBriefingManagement — Generate-all opt-in interlock (#555)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("restores the v1-like Blocks and Preview / Generate workspaces", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") {
        return jsonResponse([
          { memberId: "member-ada", enabled: true },
          { memberId: "member-ben", enabled: true },
        ]);
      }
      if (url === "/api/daily-briefing/settings") {
        return jsonResponse({
          generationTime: "06:00",
          autoPrintTrigger: null,
          blockOrder: [{ type: "message" }],
          memberBlockSettings: [],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    const blocksTab = await screen.findByTestId("daily-briefing-tab-blocks");
    const previewTab = screen.getByTestId("daily-briefing-tab-preview");
    expect(blocksTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("daily-briefing-blocks-workspace")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-preview-workspace")).not.toBeVisible();

    expect(screen.getByTestId("daily-briefing-block-member-member-ada")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-block-member-member-ben")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-block-member-member-ada")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByTestId("daily-briefing-block-matrix")).toBeVisible();
    for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
      expect(screen.getByTestId(`daily-briefing-block-weekday-heading-${day}`)).toBeVisible();
    }

    fireEvent.click(previewTab);

    expect(previewTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("daily-briefing-blocks-workspace")).not.toBeVisible();
    expect(screen.getByTestId("daily-briefing-preview-workspace")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-preview-member-member-ada")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-preview-member-member-ben")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-generate")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-admin-preview-show")).toBeVisible();
  });

  it("reorders block rows by drag and persists the complete effective order", async () => {
    let savedOrder: Array<{ type: string; params?: Record<string, unknown> }> | undefined;
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
      if (url === "/api/daily-briefing/settings") {
        return jsonResponse({
          generationTime: "06:00",
          autoPrintTrigger: null,
          blockOrder: [{ type: "message" }, { type: "weather" }],
          memberBlockSettings: [],
        });
      }
      if (url === "/api/daily-briefing/block-order" && init?.method === "PUT") {
        savedOrder = JSON.parse(String(init.body));
        return jsonResponse({ blockOrder: savedOrder });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    const messageHandle = await screen.findByTestId("daily-briefing-admin-block-drag-message");
    const weatherRow = screen.getByTestId("daily-briefing-admin-block-settings-row-weather");
    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      getData: (type: string) => dragData.get(type) ?? "",
      setData: (type: string, value: string) => dragData.set(type, value),
    };
    fireEvent.dragStart(messageHandle, { dataTransfer });
    fireEvent.dragOver(weatherRow, { dataTransfer });
    fireEvent.drop(weatherRow, { dataTransfer });

    await waitFor(() => {
      expect(savedOrder?.slice(0, 2)).toEqual([{ type: "weather" }, { type: "message" }]);
    });
    expect(savedOrder).toHaveLength(21);
    expect(screen.getAllByTestId(/daily-briefing-admin-block-settings-row-/)[0]).toHaveAttribute(
      "data-testid",
      "daily-briefing-admin-block-settings-row-weather"
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("posts the empty Generate-all body and renders every returned member status", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") {
        return jsonResponse([
          { memberId: "member-ada", enabled: true },
          { memberId: "member-ben", enabled: true },
        ]);
      }
      if (url === "/api/daily-briefing/settings") {
        return jsonResponse({
          generationTime: "06:00",
          autoPrintTrigger: null,
          blockOrder: [],
          memberBlockSettings: [],
        });
      }
      if (url === "/api/daily-briefing/generate-all") {
        return jsonResponse({
          status: "completed",
          count: 2,
          generated: [
            { memberId: "member-ada", status: "ready" },
            { memberId: "member-ben", status: "partial" },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    fireEvent.click(await screen.findByTestId("daily-briefing-generate-all"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/daily-briefing/generate-all", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    });
    expect(await screen.findByTestId("daily-briefing-member-status-member-ada")).toHaveTextContent(
      "Ada: Ready"
    );
    expect(screen.getByTestId("daily-briefing-member-status-member-ben")).toHaveTextContent(
      "Ben: Partial"
    );
    expect(screen.queryByTestId("daily-briefing-generate-all-info")).not.toBeInTheDocument();
  });

  it("renders an already_running Generate-all response as a non-error informational message (slice-012 T009)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/members") return jsonResponse(activeMembers);
      if (url === "/api/daily-briefing/opt-in") {
        return jsonResponse([
          { memberId: "member-ada", enabled: true },
          { memberId: "member-ben", enabled: true },
        ]);
      }
      if (url === "/api/daily-briefing/settings") {
        return jsonResponse({
          generationTime: "06:00",
          autoPrintTrigger: null,
          blockOrder: [],
          memberBlockSettings: [],
        });
      }
      if (url === "/api/daily-briefing/generate-all") {
        return jsonResponse({ status: "already_running" });
      }
      if (url === "/api/daily-briefing/generate") {
        return jsonResponse({
          id: "briefing-1",
          memberId: "member-ada",
          date: "2026-08-21",
          status: "ready",
          payload: {
            schemaVersion: 1,
            member: { id: "member-ada", displayName: "Ada" },
            date: "2026-08-21",
            blocks: [],
          },
          createdAt: 1,
          updatedAt: 1,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    fireEvent.click(await screen.findByTestId("daily-briefing-generate-all"));

    const info = await screen.findByTestId("daily-briefing-generate-all-info");
    expect(info).toHaveTextContent(
      "A Daily Briefing generation is already running — try again shortly."
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("daily-briefing-member-statuses")).not.toBeInTheDocument();

    // Nit 5: a single-member Generate clears the stale
    // already_running note instead of leaving it next to the fresh status.
    fireEvent.change(screen.getByTestId("daily-briefing-member-select"), {
      target: { value: "member-ada" },
    });
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    await screen.findByTestId("daily-briefing-status");
    expect(screen.queryByTestId("daily-briefing-generate-all-info")).not.toBeInTheDocument();
  });

  it("keeps Generate-all disabled while an earlier opt-in PUT is still pending", async () => {
    let resolveAdaOptIn: ((response: Response) => void) | undefined;
    let resolveBenOptIn: ((response: Response) => void) | undefined;
    const adaOptInPending = new Promise<Response>((resolve) => {
      resolveAdaOptIn = resolve;
    });
    const benOptInPending = new Promise<Response>((resolve) => {
      resolveBenOptIn = resolve;
    });
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation((...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(
          jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } })
        );
      }
      if (url === "/api/members") return Promise.resolve(jsonResponse(activeMembers));
      if (url === "/api/daily-briefing/opt-in") {
        return Promise.resolve(
          jsonResponse([
            { memberId: "member-ada", enabled: true },
            { memberId: "member-ben", enabled: true },
          ])
        );
      }
      if (url === "/api/daily-briefing/settings") {
        return Promise.resolve(
          jsonResponse({
            generationTime: "06:00",
            autoPrintTrigger: null,
            blockOrder: [],
            memberBlockSettings: [],
          })
        );
      }
      if (url === "/api/daily-briefing/opt-in/member-ada" && init?.method === "PUT") {
        return adaOptInPending;
      }
      if (url === "/api/daily-briefing/opt-in/member-ben" && init?.method === "PUT") {
        return benOptInPending;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    const generateAll = await screen.findByTestId("daily-briefing-generate-all");
    const generate = screen.getByTestId("daily-briefing-generate");
    fireEvent.change(screen.getByTestId("daily-briefing-member-select"), {
      target: { value: "member-ada" },
    });
    expect(generate).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("daily-briefing-opt-in-member-ada"));
    fireEvent.click(screen.getByTestId("daily-briefing-opt-in-member-ben"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/daily-briefing/opt-in/member-ada",
        expect.objectContaining({ method: "PUT" })
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/daily-briefing/opt-in/member-ben",
        expect.objectContaining({ method: "PUT" })
      );
    });

    resolveBenOptIn?.(jsonResponse({ memberId: "member-ben", enabled: false }));

    await waitFor(() => {
      expect(generateAll).toBeDisabled();
      expect(generate).toBeDisabled();
    });
    fireEvent.click(generateAll);
    fireEvent.click(generate);
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([input]) => String(input) === "/api/daily-briefing/generate-all"
      )
    ).toHaveLength(0);
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([input]) => String(input) === "/api/daily-briefing/generate"
      )
    ).toHaveLength(0);

    resolveAdaOptIn?.(jsonResponse({ memberId: "member-ada", enabled: false }));
  });
});
