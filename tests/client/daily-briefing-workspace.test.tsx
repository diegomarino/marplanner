import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BriefingWorkspace } from "@/daily-briefing/admin/BriefingWorkspace";
import { LanguageProvider } from "@/i18n";
import { Role } from "../../src/shared";
import type { Briefing, MemberDTO } from "../../src/shared";

type FetchCall = Parameters<typeof globalThis.fetch>;

const ben: MemberDTO = {
  id: "member-ben",
  displayName: "Ben",
  colorKey: "teal",
  role: Role.child,
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
};

const TODAY = "2026-10-15";
const PAST = "2026-10-14";

function briefing(date: string, status: Briefing["status"] = "ready"): Briefing {
  return {
    id: `b-${date}`,
    memberId: "member-ben",
    date,
    status,
    payload: {
      schemaVersion: 2,
      member: { id: "member-ben", displayName: "Ben" },
      date,
      blocks: [],
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

interface Backend {
  printingActive?: boolean;
  historyFails?: boolean;
  previewStatus?: Record<string, number>;
  generate?: (body: Record<string, unknown>) => Response;
  print?: () => Response;
  /** Holds the read of a date until the promise resolves. */
  readGate?: Record<string, Promise<void>>;
}

function mockBackend(backend: Backend = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let historyFailures = backend.historyFails ? 1 : 0;
  const fetchMock = vi.fn(async (...args: FetchCall) => {
    const [input, init] = args;
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/settings") return json({ locale: { timezone: "UTC", language: "en" } });
    if (url === "/api/printing/status") return json({ active: backend.printingActive ?? true });
    if (url.startsWith("/api/daily-briefing/history/")) {
      if (historyFailures > 0) {
        historyFailures -= 1;
        return json({ error: "internal_error", message: "x" }, 500);
      }
      return json({
        today: TODAY,
        entries: url.endsWith("member-ben")
          ? [
              { id: "b1", date: TODAY, status: "ready", updatedAt: 2 },
              { id: "b0", date: PAST, status: "render-failed", updatedAt: 1 },
            ]
          : [],
      });
    }
    const preview = url.match(/^\/api\/daily-briefing\/[^/]+\/(\d{4}-\d{2}-\d{2})\/preview\.png/);
    if (preview) {
      const status = backend.previewStatus?.[preview[1]] ?? 200;
      return status === 200
        ? new Response(new Blob([new Uint8Array([137, 80, 78, 71])]), { status })
        : json(status === 202 ? { status: "rendering" } : { error: "x", message: "x" }, status);
    }
    if (url === "/api/daily-briefing/generate" && method === "POST") {
      return backend.generate?.(JSON.parse(String(init?.body))) ?? json(briefing(TODAY));
    }
    const print = url.match(/^\/api\/daily-briefing\/[^/]+\/[^/]+\/print$/);
    if (print && method === "POST")
      return backend.print?.() ?? json({ jobId: "j1", enqueued: true });
    const read = url.match(/^\/api\/daily-briefing\/member-(ben|cleo)\/(\d{4}-\d{2}-\d{2})$/);
    if (read) {
      await backend.readGate?.[read[2]];
      return read[1] === "ben"
        ? json({
            generated: true,
            // Same status as the history entry for that date.
            briefing: briefing(read[2], read[2] === PAST ? "render-failed" : "ready"),
            printedStatus: "none",
          })
        : json({ generated: false });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

type WorkspaceProps = Parameters<typeof BriefingWorkspace>[0];

function renderWorkspace(props: Partial<WorkspaceProps> = {}) {
  const onGenerated = vi.fn();
  const onOpenBlocks = vi.fn();
  const onDateChange = vi.fn();
  // The page owns the date: a small stateful harness lets date changes flow back.
  function Harness() {
    const [date, setDate] = useState<string | null>(null);
    return (
      <BriefingWorkspace
        member={ben}
        date={date}
        today={null}
        onDateChange={(next) => {
          onDateChange(next);
          setDate(next);
        }}
        active
        blocked={false}
        refreshKey={0}
        onGenerated={onGenerated}
        onBusyChange={() => {}}
        onOpenBlocks={onOpenBlocks}
        {...props}
      />
    );
  }
  render(
    <LanguageProvider>
      <Harness />
    </LanguageProvider>
  );
  return { onGenerated, onOpenBlocks, onDateChange };
}

describe("BriefingWorkspace", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:briefing");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows the first member's history, today's payload and image", async () => {
    mockBackend();
    renderWorkspace();
    expect(await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByTestId(`daily-briefing-history-entry-${PAST}`)).toHaveTextContent(
      "Render failed"
    );
    expect(await screen.findByTestId("daily-briefing-generated-payload")).toHaveTextContent(
      `"date": "${TODAY}"`
    );
    expect(screen.getByTestId("daily-briefing-status")).toHaveTextContent("Ready");
    expect(await screen.findByTestId("daily-briefing-admin-preview-image")).toHaveAttribute(
      "src",
      "blob:briefing"
    );
    expect(screen.getByTestId("daily-briefing-generate")).toHaveTextContent("Regenerate");
  });

  it("selecting a past entry loads it; a 409 on a render-failed briefing says so", async () => {
    mockBackend({ previewStatus: { [PAST]: 409 } });
    renderWorkspace();
    fireEvent.click(await screen.findByTestId(`daily-briefing-history-entry-${PAST}`));
    await waitFor(() =>
      expect(screen.getByTestId("daily-briefing-generated-payload")).toHaveTextContent(
        `"date": "${PAST}"`
      )
    );
    const state = await screen.findByTestId("daily-briefing-image-state");
    await waitFor(() => expect(state).toHaveAttribute("data-state", "noRaster"));
    expect(state).toHaveTextContent("Render failed for this briefing.");
  });

  it("regenerates today with only memberId, and a past date with the date", async () => {
    const calls = mockBackend({
      generate: (body) => json(briefing((body.date as string | undefined) ?? TODAY)),
    });
    const { onGenerated } = renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId(`daily-briefing-history-entry-${PAST}`));
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(2));
    expect(
      calls.filter((call) => call.url === "/api/daily-briefing/generate").map((c) => c.body)
    ).toEqual([{ memberId: "member-ben" }, { memberId: "member-ben", date: PAST }]);
  });

  it("reports a paused day instead of generating", async () => {
    mockBackend({
      generate: () =>
        json({ skipped: true, reason: "paused", memberId: "member-ben", date: TODAY }),
    });
    const { onGenerated } = renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    expect(await screen.findByTestId("daily-briefing-paused-notice")).toHaveTextContent(
      `Ben is paused on ${TODAY}`
    );
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("prints through the queue and says so; Print is disabled when Printing is off", async () => {
    const calls = mockBackend();
    renderWorkspace();
    await screen.findByTestId("daily-briefing-generated-payload");
    await waitFor(() => expect(screen.getByTestId("daily-briefing-print")).toBeEnabled());
    fireEvent.click(screen.getByTestId("daily-briefing-print"));
    expect(await screen.findByTestId("daily-briefing-print-notice")).toHaveTextContent(
      "Sent to the printer queue."
    );
    expect(calls.some((c) => c.url === `/api/daily-briefing/member-ben/${TODAY}/print`)).toBe(true);

    cleanup();
    mockBackend({ printingActive: false });
    renderWorkspace();
    await screen.findByTestId("daily-briefing-generated-payload");
    expect(screen.getByTestId("daily-briefing-print")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-print-unavailable")).toBeVisible();
  });

  it("shows still-rendering with a Retry that refetches", async () => {
    mockBackend({ previewStatus: { [TODAY]: 202 } });
    renderWorkspace();
    const state = await screen.findByTestId("daily-briefing-image-state");
    await waitFor(() => expect(state).toHaveAttribute("data-state", "rendering"));
    const fetchMock = vi.mocked(globalThis.fetch);
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes("preview.png")).length;
    fireEvent.click(screen.getByTestId("daily-briefing-image-retry"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("preview.png")).length).toBe(
        before + 1
      )
    );
  });

  it("offers Retry when the history fails to load", async () => {
    mockBackend({ historyFails: true });
    renderWorkspace();
    expect(await screen.findByTestId("daily-briefing-history-error")).toBeVisible();
    fireEvent.click(screen.getByTestId("daily-briefing-history-retry"));
    expect(await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`)).toBeVisible();
  });

  it("offers Open Blocks from the paused notice", async () => {
    mockBackend({
      generate: () =>
        json({ skipped: true, reason: "paused", memberId: "member-ben", date: TODAY }),
    });
    const { onOpenBlocks } = renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    expect(await screen.findByTestId("daily-briefing-paused-notice")).toHaveTextContent(
      /in Blocks to generate/
    );
    fireEvent.click(screen.getByTestId("daily-briefing-paused-open-blocks"));
    expect(onOpenBlocks).toHaveBeenCalledTimes(1);
  });

  it("changing the date loads that date and refetches the image", async () => {
    const calls = mockBackend();
    renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.change(screen.getByTestId("daily-briefing-admin-preview-date"), {
      target: { value: "2026-09-07" },
    });
    expect(screen.queryByTestId("daily-briefing-admin-preview-show")).toBeNull();
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/daily-briefing/member-ben/2026-09-07")).toBe(true)
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([u]) =>
            /^\/api\/daily-briefing\/member-ben\/2026-09-07\/preview\.png\?v=/.test(String(u))
          )
      ).toBe(true)
    );
  });

  it("fetches nothing while the tab is hidden", () => {
    const calls = mockBackend();
    renderWorkspace({ active: false });
    expect(calls.filter((c) => c.url.startsWith("/api/daily-briefing"))).toEqual([]);
  });

  it("keeps the payload when the already-selected history entry is clicked again", async () => {
    mockBackend();
    renderWorkspace();
    const payload = await screen.findByTestId("daily-briefing-generated-payload");
    expect(payload).toHaveTextContent(`"date": "${TODAY}"`);
    fireEvent.click(screen.getByTestId(`daily-briefing-history-entry-${TODAY}`));
    expect(screen.getByTestId("daily-briefing-generated-payload")).toHaveTextContent(
      `"date": "${TODAY}"`
    );
  });

  it("ignores a slower read for a date that is no longer selected", async () => {
    let releasePast: () => void = () => {};
    const pastGate = new Promise<void>((resolve) => {
      releasePast = resolve;
    });
    mockBackend({ readGate: { [PAST]: pastGate } });
    renderWorkspace();
    await screen.findByTestId("daily-briefing-generated-payload");
    fireEvent.click(screen.getByTestId(`daily-briefing-history-entry-${PAST}`));
    fireEvent.click(screen.getByTestId(`daily-briefing-history-entry-${TODAY}`));
    await waitFor(() =>
      expect(screen.getByTestId("daily-briefing-generated-payload")).toHaveTextContent(
        `"date": "${TODAY}"`
      )
    );
    releasePast();
    await pastGate;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("daily-briefing-generated-payload")).toHaveTextContent(
      `"date": "${TODAY}"`
    );
  });
});
