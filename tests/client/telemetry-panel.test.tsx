import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryManagement } from "@/admin/TelemetryManagement";
import { LanguageProvider } from "@/i18n";

/** — TelemetryManagement panel: renders the page, filters trigger a fetch with the expected
 * query, and a hostile row (active HTML/script in BOTH `message` and `data`) renders inert — no
 * element is injected into the DOM. A source-level grep assertion pins the
 * no-`dangerouslySetInnerHTML` invariant directly (row content flows through React text nodes
 * only).
 * review (fixes): Load-more must paginate against the APPLIED filter snapshot,
 * never a live-but-unapplied draft edit; and overlapping requests (an in-flight Apply superseded
 * by a newer one, or an Apply racing a Load-more) must never let a stale response clobber fresher
 * state.
 */

type FetchCall = Parameters<typeof globalThis.fetch>;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function renderPanel() {
  render(
    <LanguageProvider>
      <TelemetryManagement />
    </LanguageProvider>
  );
}

const settingsUrl = "/api/settings";
const telemetryUrl = "/api/telemetry/client-log";

describe("TelemetryManagement", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the page and the initial page of rows", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === settingsUrl) {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url.startsWith(telemetryUrl)) {
        return jsonResponse({
          rows: [
            {
              id: "row-1",
              eventId: "event-1",
              eventTime: null,
              receivedAt: 1000,
              level: "error",
              component: "client.global",
              message: "fetch failed",
              data: '{"status":500}',
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderPanel();

    expect(await screen.findByTestId("telemetry-management")).toBeInTheDocument();
    const row = await screen.findByTestId("telemetry-row-row-1");
    expect(row).toHaveTextContent("error");
    expect(row).toHaveTextContent("client.global");
    expect(row).toHaveTextContent("fetch failed");
    expect(row).toHaveTextContent('{"status":500}');
  });

  it("Apply filters triggers a fetch carrying the selected level + component query params", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === settingsUrl) {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url.startsWith(telemetryUrl)) {
        return jsonResponse({ rows: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderPanel();
    await screen.findByTestId("telemetry-empty");

    fireEvent.change(screen.getByTestId("telemetry-filter-level"), {
      target: { value: "warn" },
    });
    fireEvent.change(screen.getByTestId("telemetry-filter-component"), {
      target: { value: "kiosk.fetch" },
    });
    fireEvent.click(screen.getByTestId("telemetry-apply-filters"));

    await waitFor(() => {
      const calls = (mockFetch.mock.calls as FetchCall[])
        .map(([input]) => String(input))
        .filter((url) => url.startsWith(telemetryUrl));
      expect(calls.some((url) => url.includes("level=warn"))).toBe(true);
      expect(calls.some((url) => url.includes("component=kiosk.fetch"))).toBe(true);
    });
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-11: a hostile row (active HTML/script in message AND data) renders inert — no element is injected", async () => {
    const hostileMessage = '<img src=x onerror="window.__pwned=true">';
    const hostileData = '{"payload":"<script>window.__pwned=true</script>"}';
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === settingsUrl) {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url.startsWith(telemetryUrl)) {
        return jsonResponse({
          rows: [
            {
              id: "hostile-row",
              eventId: "event-hostile",
              eventTime: null,
              receivedAt: 2000,
              level: "warn",
              component: "hostile.component",
              message: hostileMessage,
              data: hostileData,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderPanel();

    const messageCell = await screen.findByTestId("telemetry-row-message-hostile-row");
    const dataCell = await screen.findByTestId("telemetry-row-data-hostile-row");

    // Rendered as escaped text — the literal markup is visible as TEXT, not parsed into elements.
    expect(messageCell).toHaveTextContent(hostileMessage);
    expect(dataCell).toHaveTextContent(hostileData);
    expect(messageCell.querySelector("img")).toBeNull();
    expect(dataCell.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("P2-1: Load more paginates against the APPLIED filters, not a live-but-unapplied draft edit", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === settingsUrl) {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url.startsWith(telemetryUrl)) {
        if (url.includes("cursor=")) {
          return jsonResponse({
            rows: [
              {
                id: "row-2",
                eventId: "event-2",
                eventTime: null,
                receivedAt: 900,
                level: "info",
                component: "client.global",
                message: "second page",
                data: null,
              },
            ],
            nextCursor: null,
          });
        }
        return jsonResponse({
          rows: [
            {
              id: "row-1",
              eventId: "event-1",
              eventTime: null,
              receivedAt: 1000,
              level: "info",
              component: "client.global",
              message: "first page",
              data: null,
            },
          ],
          nextCursor: "cursor-1",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderPanel();
    await screen.findByTestId("telemetry-row-row-1");

    // Edit a filter WITHOUT clicking "Apply filters" — the draft state changes, but nothing has
    // been applied yet.
    fireEvent.change(screen.getByTestId("telemetry-filter-level"), {
      target: { value: "warn" },
    });

    fireEvent.click(screen.getByTestId("telemetry-load-more"));
    await screen.findByTestId("telemetry-row-row-2");

    const loadMoreCall = (mockFetch.mock.calls as FetchCall[])
      .map(([input]) => String(input))
      .find((url) => url.startsWith(telemetryUrl) && url.includes("cursor="));
    expect(loadMoreCall).toBeDefined();
    // The edited-but-unapplied "warn" draft must NOT leak into the Load-more request — it must
    // still carry the APPLIED (empty) filter snapshot from the initial load.
    expect(loadMoreCall).not.toContain("level=warn");
    expect(loadMoreCall).toContain("cursor=cursor-1");

    // Both pages' rows are present — the continuation correctly appended onto the same query.
    expect(screen.getByTestId("telemetry-row-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("telemetry-row-row-2")).toBeInTheDocument();
  });

  it("P2-2: busy disables BOTH actions, and a stale response arriving after a newer Apply is discarded", async () => {
    type Resolver = (value: Response) => void;
    const pending: Resolver[] = [];

    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation((...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === settingsUrl) {
        return Promise.resolve(
          jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } })
        );
      }
      if (url.startsWith(telemetryUrl)) {
        return new Promise<Response>((resolve) => {
          pending.push(resolve);
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderPanel();

    // Let the initial mount's telemetry request settle with a page + a cursor, so "Load more" is
    // visible for the disabled-button assertion below.
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0](
      jsonResponse({
        rows: [
          {
            id: "row-seed",
            eventId: "event-seed",
            eventTime: null,
            receivedAt: 1000,
            level: "info",
            component: "client.global",
            message: "seed page",
            data: null,
          },
        ],
        nextCursor: "cursor-seed",
      })
    );
    await screen.findByTestId("telemetry-row-row-seed");

    const applyButton = screen.getByTestId("telemetry-apply-filters") as HTMLButtonElement;
    expect(applyButton.disabled).toBe(false);
    expect(screen.getByTestId("telemetry-load-more")).toBeInTheDocument();

    // A single, ordinary Apply click — while it is in flight, BOTH actions must be gated, not
    // just Apply's own flag (the UI-gating half of the fix). Apply is disabled; "Load more"
    // is gone entirely, since a first-page request invalidates the OLD cursor immediately (the
    // follow-up fix — see the dedicated cursor-invalidation test below).
    fireEvent.click(applyButton);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(applyButton.disabled).toBe(true);
    expect(screen.queryByTestId("telemetry-load-more")).toBeNull();

    // Settle it, returning to an idle, non-busy baseline.
    pending[1](
      jsonResponse({
        rows: [
          {
            id: "row-baseline",
            eventId: "event-baseline",
            eventTime: null,
            receivedAt: 2000,
            level: "info",
            component: "client.global",
            message: "baseline page",
            data: null,
          },
        ],
        nextCursor: null,
      })
    );
    await screen.findByTestId("telemetry-row-row-baseline");
    await waitFor(() => expect(applyButton.disabled).toBe(false));

    // Now the race: fire TWO Apply clicks back-to-back inside a SINGLE React batch. No commit —
    // and therefore no re-check of the (still-enabled) `disabled` prop — happens between them, so
    // both dispatch despite the fix's disable-while-busy gate, faithfully reproducing the tight
    // window the request-generation guard exists to close (a real double-click landing inside one
    // browser event-processing turn, ahead of React's next paint).
    act(() => {
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(pending).toHaveLength(4));

    // Resolve the NEWER (second, index 3) request FIRST, then let the STALE (first, index 2)
    // request arrive late.
    pending[3](
      jsonResponse({
        rows: [
          {
            id: "row-newer",
            eventId: "event-newer",
            eventTime: null,
            receivedAt: 3000,
            level: "info",
            component: "client.global",
            message: "newer result",
            data: null,
          },
        ],
        nextCursor: null,
      })
    );
    await screen.findByTestId("telemetry-row-row-newer");

    pending[2](
      jsonResponse({
        rows: [
          {
            id: "row-stale",
            eventId: "event-stale",
            eventTime: null,
            receivedAt: 2500,
            level: "info",
            component: "client.global",
            message: "stale result",
            data: null,
          },
        ],
        nextCursor: null,
      })
    );

    // Give the stale response's promise chain (response.json + the resulting React commit) a
    // full turn of the event loop to run — two bare microtask awaits are NOT enough for that
    // chain to reach setRows, which would make this assertion pass vacuously (it holds because
    // the write hasn't happened YET, not because the guard blocked it).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // The stale response must NEVER have overwritten the newer result.
    expect(screen.queryByTestId("telemetry-row-row-stale")).toBeNull();
    expect(screen.getByTestId("telemetry-row-row-newer")).toBeInTheDocument();
  });

  it("a failed Apply invalidates the OLD cursor — Load more disappears instead of blending new filters with a stale cursor", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    let telemetryCalls = 0;
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === settingsUrl) {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url.startsWith(telemetryUrl)) {
        telemetryCalls += 1;
        if (telemetryCalls === 1) {
          // Initial mount — succeeds WITH a cursor, so "Load more" is initially visible.
          return jsonResponse({
            rows: [
              {
                id: "row-seed",
                eventId: "event-seed",
                eventTime: null,
                receivedAt: 1000,
                level: "info",
                component: "client.global",
                message: "seed page",
                data: null,
              },
            ],
            nextCursor: "cursor-seed",
          });
        }
        // The subsequent Apply — fails.
        return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderPanel();
    await screen.findByTestId("telemetry-row-row-seed");
    expect(screen.getByTestId("telemetry-load-more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("telemetry-apply-filters"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // The failed Apply must have invalidated the OLD cursor — "Load more" is gone, so a
    // subsequent click can never send the (now-applied) new filters together with the stale
    // pre-Apply cursor.
    expect(screen.queryByTestId("telemetry-load-more")).toBeNull();
  });

  it("never uses dangerouslySetInnerHTML anywhere in the panel source (grep assertion)", () => {
    const source = readFileSync(
      join(__dirname, "../../src/client/admin/TelemetryManagement.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

it.each(["en", "es"] as const)(
  "localizes filter-load failures without displaying server prose (%s)",
  async (language) => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        if (String(input) === settingsUrl) return jsonResponse({ locale: { language } });
        requests++;
        if (requests === 1) return jsonResponse({ rows: [], nextCursor: null });
        return new Response(
          JSON.stringify({
            error: "validation_error",
            message: "Private English filter diagnostics",
          }),
          { status: 400 }
        );
      })
    );
    try {
      renderPanel();
      await screen.findByRole("button", {
        name: language === "es" ? "Aplicar filtros" : "Apply filters",
      });
      await waitFor(() => expect(screen.getByTestId("telemetry-apply-filters")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("telemetry-apply-filters"));
      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent(
        language === "es" ? "Error al cargar la telemetría." : "Failed to load telemetry."
      );
      expect(notice).not.toHaveTextContent("Private English");
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  }
);

it("sends both date boundaries when applying a telemetry range", async () => {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const url = String(input);
      if (url === settingsUrl) return jsonResponse({ locale: { language: "en" } });
      requested.push(url);
      return jsonResponse({ rows: [], nextCursor: null });
    })
  );
  try {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("telemetry-apply-filters")).not.toBeDisabled());
    fireEvent.change(screen.getByTestId("telemetry-filter-from"), { target: { value: "1000" } });
    fireEvent.change(screen.getByTestId("telemetry-filter-to"), { target: { value: "2000" } });
    fireEvent.click(screen.getByTestId("telemetry-apply-filters"));
    await waitFor(() => {
      const query = new URL(requested.at(-1)!, "http://localhost").searchParams;
      expect(query.get("from")).toBe("1000");
      expect(query.get("to")).toBe("2000");
    });
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});
