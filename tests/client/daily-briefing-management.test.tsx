import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyBriefingManagement } from "@/admin/DailyBriefingManagement";
import type { BlockMatrixProps } from "@/daily-briefing/admin/BlockMatrix";
import { LanguageProvider } from "@/i18n";

type FetchCall = Parameters<typeof globalThis.fetch>;

// Pass-through mock: the real matrix renders, and the page's last props are captured so a test
// can drive `onReorder` directly (dnd-kit's sensors need layout rects, which jsdom lacks; the
// real drag is covered by tests/e2e/daily-briefing.spec.ts).
const matrix = vi.hoisted(() => ({ props: null as BlockMatrixProps | null }));
vi.mock("@/daily-briefing/admin/BlockMatrix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/daily-briefing/admin/BlockMatrix")>();
  return {
    BlockMatrix: (props: BlockMatrixProps) => {
      matrix.props = props;
      return <actual.BlockMatrix {...props} />;
    },
  };
});

const activeMembers = [
  {
    id: "member-ada",
    displayName: "Ada",
    colorKey: "blue",
    role: "parent",
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    birthDate: null,
  },
  {
    id: "member-ben",
    displayName: "Ben",
    colorKey: "teal",
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

function settingsResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    generationTime: "06:00",
    autoPrintTrigger: null,
    blockOrder: [],
    memberBlockSettings: [],
    memberSchedules: [],
    ...overrides,
  });
}

/** The Briefings workspace's reads (history, stored briefing, image, Printing status). */
function workspaceResponse(url: string): Response | undefined {
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
  return undefined;
}

interface Backend {
  optIns?: string[];
  settings?: () => Response;
  handle?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
}

/** Common page reads; `handle` answers the writes a test cares about first. */
function mockBackend({ optIns = [], settings = () => settingsResponse(), handle }: Backend = {}) {
  const mockFetch = vi.mocked(globalThis.fetch);
  mockFetch.mockImplementation(async (...args: FetchCall) => {
    const [input, init] = args;
    const url = String(input);
    const handled = handle?.(url, init);
    if (handled) return handled;
    if (url === "/api/settings") {
      return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
    }
    if (url === "/api/members") return jsonResponse(activeMembers);
    if (url === "/api/daily-briefing/opt-in") {
      return jsonResponse(optIns.map((memberId) => ({ memberId, enabled: true })));
    }
    if (url === "/api/daily-briefing/settings") return settings();
    const workspace = workspaceResponse(url);
    if (workspace) return workspace;
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  return mockFetch;
}

function callsTo(url: string, method = "GET") {
  return (vi.mocked(globalThis.fetch).mock.calls as FetchCall[]).filter(
    ([input, init]) => String(input) === url && (init?.method ?? "GET") === method
  );
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
    matrix.props = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("opens on Schedule and offers Blocks and Briefings tabs for the selected member", async () => {
    mockBackend({ optIns: ["member-ada"] });
    renderManagement();

    const scheduleTab = await screen.findByTestId("daily-briefing-tab-schedule");
    expect(scheduleTab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("daily-briefing-member-row-member-ada")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-member-row-member-ben")).toBeVisible();

    fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
    expect(screen.getByTestId("daily-briefing-member-pill-member-ada")).toBeChecked();
    expect(await screen.findByTestId("daily-briefing-block-matrix")).toBeVisible();
    for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
      expect(screen.getByTestId(`daily-briefing-block-weekday-heading-${day}`)).toBeVisible();
    }

    fireEvent.click(screen.getByTestId("daily-briefing-tab-preview"));
    expect(screen.getByTestId("daily-briefing-tab-preview")).toHaveTextContent("Briefings");
    expect(screen.getByTestId("daily-briefing-member-pill-member-ada")).toBeChecked();
    expect(screen.getByTestId("daily-briefing-generate")).toBeVisible();
    expect(screen.queryByTestId("daily-briefing-admin-preview-show")).not.toBeInTheDocument();
  });

  it("keyboard reorder persists the complete effective order and reverts on failure", async () => {
    let savedOrder: Array<{ type: string }> | undefined;
    let failOrder = false;
    mockBackend({
      optIns: ["member-ada"],
      settings: () => settingsResponse({ blockOrder: [{ type: "shotgun" }, { type: "weather" }] }),
      handle: (url, init) => {
        if (url !== "/api/daily-briefing/block-order" || init?.method !== "PUT") return undefined;
        if (failOrder) return jsonResponse({ error: "validation_failed", message: "bad" }, 400);
        savedOrder = JSON.parse(String(init.body));
        return jsonResponse({ blockOrder: savedOrder });
      },
    });
    renderManagement();
    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));
    await screen.findByTestId("daily-briefing-block-matrix");
    const firstRow = () =>
      screen.getAllByTestId(/^daily-briefing-admin-block-settings-row-/)[0]?.dataset.testid;

    act(() => matrix.props?.onReorder("weather", "shotgun"));
    await waitFor(() => expect(savedOrder?.[0]).toEqual({ type: "weather" }));
    expect(savedOrder).toHaveLength(21);
    expect(firstRow()).toBe("daily-briefing-admin-block-settings-row-weather");

    failOrder = true;
    act(() => matrix.props?.onReorder("shotgun", "weather"));
    expect(await screen.findByTestId("daily-briefing-blocks-error")).toBeVisible();
    expect(firstRow()).toBe("daily-briefing-admin-block-settings-row-weather");
  });

  it("posts the empty Generate-all body and renders every returned member status", async () => {
    const mockFetch = mockBackend({
      optIns: ["member-ada", "member-ben"],
      handle: (url) =>
        url === "/api/daily-briefing/generate-all"
          ? jsonResponse({
              status: "completed",
              count: 2,
              generated: [
                { memberId: "member-ada", status: "ready" },
                { memberId: "member-ben", status: "partial" },
              ],
            })
          : undefined,
    });
    renderManagement();

    const generateAll = await screen.findByTestId("daily-briefing-generate-all");
    await waitFor(() => expect(generateAll).toBeEnabled());
    fireEvent.click(generateAll);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/daily-briefing/generate-all", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    });
    expect(await screen.findByTestId("daily-briefing-member-status-member-ada")).toHaveTextContent(
      "Ready"
    );
    expect(screen.getByTestId("daily-briefing-member-status-member-ben")).toHaveTextContent(
      "Partial"
    );
    expect(screen.queryByTestId("daily-briefing-generate-all-info")).not.toBeInTheDocument();
  });

  it("Generate for all members on another date sends that date and marks paused members", async () => {
    let body: string | undefined;
    mockBackend({
      optIns: ["member-ada", "member-ben"],
      settings: () =>
        settingsResponse({
          memberSchedules: [
            { memberId: "member-ben", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
          ],
        }),
      handle: (url, init) => {
        if (url !== "/api/daily-briefing/generate-all") return undefined;
        body = String(init?.body);
        return jsonResponse({
          status: "completed",
          count: 1,
          generated: [{ memberId: "member-ada", status: "ready" }],
        });
      },
    });
    renderManagement();

    const generateAll = await screen.findByTestId("daily-briefing-generate-all");
    await screen.findByTestId("daily-briefing-admin-generation-time");
    fireEvent.change(screen.getByTestId("daily-briefing-generate-date"), {
      target: { value: "2026-10-18" },
    });
    fireEvent.click(generateAll);

    await waitFor(() => expect(body).toBe(JSON.stringify({ date: "2026-10-18" })));
    expect(await screen.findByTestId("daily-briefing-member-status-member-ben")).toHaveTextContent(
      "Paused"
    );
    expect(screen.getByTestId("daily-briefing-member-status-member-ada")).toHaveTextContent(
      "Ready"
    );
  });

  it("renders an already_running Generate-all response as a non-error informational message", async () => {
    mockBackend({
      optIns: ["member-ada", "member-ben"],
      handle: (url) => {
        if (url === "/api/daily-briefing/generate-all") {
          return jsonResponse({ status: "already_running" });
        }
        if (url === "/api/daily-briefing/generate") {
          return jsonResponse({
            id: "briefing-1",
            memberId: "member-ada",
            date: "2026-10-15",
            status: "ready",
            payload: {
              schemaVersion: 1,
              member: { id: "member-ada", displayName: "Ada" },
              date: "2026-10-15",
              blocks: [],
            },
            createdAt: 1,
            updatedAt: 1,
          });
        }
        return undefined;
      },
    });
    renderManagement();

    const generateAll = await screen.findByTestId("daily-briefing-generate-all");
    await waitFor(() => expect(generateAll).toBeEnabled());
    fireEvent.click(generateAll);

    const info = await screen.findByTestId("daily-briefing-generate-all-info");
    expect(info).toHaveTextContent(
      "A Daily Briefing generation is already running — try again shortly."
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("daily-briefing-member-status-member-ada")).toHaveTextContent("—");

    // Nit 5: a single-member Generate clears the stale
    // already_running note instead of leaving it next to the fresh status.
    fireEvent.click(screen.getByTestId("daily-briefing-tab-preview"));
    await screen.findByTestId("daily-briefing-history-empty");
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    await waitFor(() =>
      expect(screen.queryByTestId("daily-briefing-generate-all-info")).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("daily-briefing-member-status-member-ada")).toHaveTextContent(
      "Ready"
    );
  });

  it("keeps Generate-all disabled while an earlier opt-in PUT is still pending", async () => {
    let resolveBenOptIn: ((response: Response) => void) | undefined;
    const benOptInPending = new Promise<Response>((resolve) => {
      resolveBenOptIn = resolve;
    });
    mockBackend({
      optIns: ["member-ada", "member-ben"],
      handle: (url, init) =>
        url === "/api/daily-briefing/opt-in/member-ben" && init?.method === "PUT"
          ? benOptInPending
          : undefined,
    });
    renderManagement();

    const generateAll = await screen.findByTestId("daily-briefing-generate-all");
    await waitFor(() => expect(generateAll).toBeEnabled());
    fireEvent.click(screen.getByTestId("daily-briefing-opt-in-member-ben"));
    await waitFor(() =>
      expect(callsTo("/api/daily-briefing/opt-in/member-ben", "PUT")).toHaveLength(1)
    );

    expect(generateAll).toBeDisabled();
    fireEvent.click(generateAll);

    fireEvent.click(screen.getByTestId("daily-briefing-tab-preview"));
    expect(screen.getByTestId("daily-briefing-member-pill-member-ada")).toBeChecked();
    const generate = screen.getByTestId("daily-briefing-generate");
    expect(generate).toBeDisabled();
    fireEvent.click(generate);

    expect(callsTo("/api/daily-briefing/generate-all", "POST")).toHaveLength(0);
    expect(callsTo("/api/daily-briefing/generate", "POST")).toHaveLength(0);

    resolveBenOptIn?.(jsonResponse({ memberId: "member-ben", enabled: false }));
    await waitFor(() => expect(generate).toBeEnabled());
  });

  it("pauses a weekday for the selected member, disables that column and shows the notice", async () => {
    let scheduleBody: unknown;
    mockBackend({
      optIns: ["member-ada"],
      settings: () =>
        settingsResponse({
          memberSchedules: [
            { memberId: "member-ada", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
          ],
        }),
      handle: (url, init) => {
        if (url !== "/api/daily-briefing/schedule/member-ada" || init?.method !== "PUT") {
          return undefined;
        }
        scheduleBody = JSON.parse(String(init.body));
        return jsonResponse({ memberId: "member-ada", ...(scheduleBody as object) });
      },
    });
    renderManagement();
    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));

    const sunday = await screen.findByTestId("daily-briefing-schedule-day-sun");
    expect(sunday).not.toBeChecked();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-sun")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-mon")).toBeEnabled();

    fireEvent.click(screen.getByTestId("daily-briefing-schedule-day-mon"));
    await waitFor(() => expect(scheduleBody).toEqual({ weekdays: ["tue", "wed", "thu", "fri"] }));
    expect(await screen.findByTestId("daily-briefing-settings-changed")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-mon")).toBeDisabled();

    fireEvent.click(screen.getByTestId("daily-briefing-settings-changed-open"));
    expect(screen.getByTestId("daily-briefing-tab-preview")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("an opted-out member is gated on Blocks and Briefings until turned on", async () => {
    let benOn = false;
    mockBackend({
      optIns: ["member-ada"],
      handle: (url, init) => {
        if (url !== "/api/daily-briefing/opt-in/member-ben" || init?.method !== "PUT") {
          return undefined;
        }
        benOn = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
        return jsonResponse({ memberId: "member-ben", enabled: benOn });
      },
    });
    renderManagement();
    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));
    await screen.findByTestId("daily-briefing-block-matrix");

    fireEvent.click(screen.getByTestId("daily-briefing-member-pill-member-ben"));
    expect(screen.getByTestId("daily-briefing-opted-out")).toHaveTextContent(
      "The daily briefing is off for Ben."
    );
    expect(screen.queryByTestId("daily-briefing-block-matrix")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("daily-briefing-tab-preview"));
    expect(screen.getByTestId("daily-briefing-opted-out")).toBeVisible();
    expect(screen.queryByTestId("daily-briefing-generate")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
    fireEvent.click(screen.getByTestId("daily-briefing-turn-on"));
    expect(await screen.findByTestId("daily-briefing-block-matrix")).toBeVisible();
    expect(benOn).toBe(true);
    expect(screen.queryByTestId("daily-briefing-opted-out")).not.toBeInTheDocument();
    expect(callsTo("/api/daily-briefing/settings")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("daily-briefing-tab-schedule"));
    fireEvent.click(screen.getByTestId("daily-briefing-opt-in-member-ben"));
    await waitFor(() => expect(benOn).toBe(false));
    fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
    expect(await screen.findByTestId("daily-briefing-opted-out")).toBeVisible();
    expect(screen.queryByTestId("daily-briefing-block-matrix")).not.toBeInTheDocument();
  });

  it("toggling a cell writes the effective day set for that block", async () => {
    let cellBody: unknown;
    mockBackend({
      optIns: ["member-ada"],
      settings: () =>
        settingsResponse({
          memberBlockSettings: [
            {
              memberId: "member-ada",
              blockType: "dadJoke",
              enabled: false,
              weekdays: ["mon"],
              params: null,
              updatedAt: 1,
            },
          ],
        }),
      handle: (url, init) => {
        if (url !== "/api/daily-briefing/block-settings/member-ada/dadJoke") return undefined;
        cellBody = JSON.parse(String(init?.body));
        return jsonResponse({
          memberId: "member-ada",
          blockType: "dadJoke",
          params: null,
          updatedAt: 2,
          ...(cellBody as object),
        });
      },
    });
    renderManagement();
    fireEvent.click(await screen.findByTestId("daily-briefing-tab-blocks"));

    const friday = await screen.findByTestId("daily-briefing-block-cell-dadJoke-fri");
    expect(screen.getByTestId("daily-briefing-block-cell-dadJoke-mon")).not.toBeChecked();
    fireEvent.click(friday);
    await waitFor(() => expect(cellBody).toEqual({ enabled: true, weekdays: ["fri"] }));
    await waitFor(() => expect(friday).toBeChecked());
  });

  it("offers Retry when members fail to load, and when settings fail to load", async () => {
    let membersFail = true;
    let settingsFail = true;
    mockBackend({
      optIns: ["member-ada"],
      settings: () => (settingsFail ? new Response("{}", { status: 500 }) : settingsResponse()),
      handle: (url) =>
        url === "/api/members" && membersFail ? new Response("{}", { status: 500 }) : undefined,
    });
    renderManagement();

    membersFail = false;
    fireEvent.click(await screen.findByTestId("daily-briefing-retry"));
    expect(await screen.findByTestId("daily-briefing-member-row-member-ben")).toBeVisible();

    expect(screen.getByTestId("daily-briefing-settings-load-error")).toBeVisible();
    settingsFail = false;
    fireEvent.click(screen.getByTestId("daily-briefing-settings-retry"));
    fireEvent.click(screen.getByTestId("daily-briefing-tab-blocks"));
    expect(await screen.findByTestId("daily-briefing-block-matrix")).toBeVisible();
  });

  it("titles the page with its sidebar label", async () => {
    mockBackend();
    renderManagement();
    expect(await screen.findByRole("heading", { name: /^Briefing$/ })).toBeVisible();
  });
});
