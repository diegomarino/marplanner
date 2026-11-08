import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrinterAttention } from "@/printing/PrinterAttention";
import { PrintExecutor } from "@/printing/PrintExecutor";
import { REMEMBERED_PRINTER_KEY } from "@/printing/rememberedPrinter";
import { createFakePrintTransport, FAKE_PRINTER_IDENTITY } from "@/printing/transport";

/** FR-013 client half — the REAL `usePrintingPluginActive` hook (unmocked, unlike
 * `printing-executor.test.tsx`), proving the executor region hides/shows against its actual
 * `GET /api/printing/status` read. Fake timers stay off here (no poll-cadence assertions) — only
 * microtask flushing is needed for the hook's own fetch chain to settle.
 */

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
    celebrationSound: null,
  }),
}));

function renderExecutor(children?: ReactNode) {
  return render(
    <LanguageProvider>
      <PrintExecutor>{children}</PrintExecutor>
    </LanguageProvider>
  );
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("PrintExecutor — FR-013 hiding (issue #691)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing (fail-safe hidden default) before the status read resolves", () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves within this test
    const { container } = renderExecutor();
    expect(screen.queryByTestId("print-executor")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("exposes the compact attention presentation, not the removed executor card, once status reports active: true", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 200 })
    );
    renderExecutor(<PrinterAttention />);
    await flushMicrotasks();

    expect(screen.getByTestId("printer-attention-pill")).toBeInTheDocument();
    expect(screen.queryByTestId("print-executor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("print-executor-pair-button")).not.toBeInTheDocument();
  });

  it("stays hidden when the status read reports active: false", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: false }), { status: 200 })
    );
    renderExecutor(<PrinterAttention />);
    await flushMicrotasks();

    expect(screen.queryByTestId("print-executor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("printer-attention-pill")).not.toBeInTheDocument();
  });

  it("stays hidden (never flashes the UI) when the status read fails at the network level", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network blip"));
    renderExecutor(<PrinterAttention />);
    await flushMicrotasks();

    expect(screen.queryByTestId("print-executor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("printer-attention-pill")).not.toBeInTheDocument();
  });

  it("stays hidden when the status read answers a non-2xx status — even with an active:true body", async () => {
    //: a NULL body would make this fence vacuous (`.json` on an empty 500
    // body rejects on its own, passing this assertion whether or not the hook's `!res.ok` guard
    // actually runs). An active:true BODY proves the guard is load-bearing.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 500 })
    );
    renderExecutor(<PrinterAttention />);
    await flushMicrotasks();

    expect(screen.queryByTestId("print-executor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("printer-attention-pill")).not.toBeInTheDocument();
  });

  it("labels the pill as an attention request while the printer is not paired", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 200 })
    );
    renderExecutor(<PrinterAttention />);
    await flushMicrotasks();

    const pill = screen.getByTestId("printer-attention-pill");
    expect(pill).toHaveAttribute("data-healthy", "false");
    expect(pill).toHaveTextContent("Printer attention");
  });

  it("turns the pill discreet once a remembered printer reconnects", async () => {
    window.localStorage.setItem(REMEMBERED_PRINTER_KEY, JSON.stringify(FAKE_PRINTER_IDENTITY));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ active: true }), { status: 200 })
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ registered: true }), { status: 200 })
    ); // capability
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // claims: nothing queued
    render(
      <LanguageProvider>
        <PrintExecutor transport={createFakePrintTransport()} pollIntervalMs={60_000}>
          <PrinterAttention />
        </PrintExecutor>
      </LanguageProvider>
    );
    await flushMicrotasks(30);

    const pill = screen.getByTestId("printer-attention-pill");
    expect(pill).toHaveAttribute("data-healthy", "true");
    expect(pill).toHaveTextContent("Printer · Ready");
  });
});
