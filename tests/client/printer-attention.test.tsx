import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompletionCelebration } from "@/chores/CompletionCelebration";
import { PrinterAttention } from "@/printing/PrinterAttention";
import { PrinterSessionProvider } from "@/printing/PrinterSession";
import { notifyPrintIntentEnqueued } from "@/printing/queueWakeup";
import { REMEMBERED_PRINTER_KEY } from "@/printing/rememberedPrinter";
import { createFakePrintTransport, PrintTransportError } from "@/printing/transport";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({ language: "en" }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TODAY = new Intl.DateTimeFormat("en-CA").format(new Date());
const FUTURE = "2999-01-01";

/** Jobs as `[derivedState, targetDate]`; a bare state means a job for today. */
function queueFetch(jobs: Array<string | [string, string]>) {
  return vi.fn((url: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          url === "/api/printing/status"
            ? { active: true }
            : url === "/api/printing/jobs"
              ? {
                  jobs: jobs.map((job, i) => {
                    const [derivedState, targetDate] = typeof job === "string" ? [job, TODAY] : job;
                    return { id: `job-${i}`, derivedState, targetDate };
                  }),
                }
              : { registered: true }
        )
      )
    )
  );
}

describe("PrinterAttention", () => {
  it("opens with dialog focus, uses the shared pair action, and returns focus after Escape", async () => {
    const transport = createFakePrintTransport();
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(url === "/api/printing/status" ? { active: true } : { registered: true })
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PrinterSessionProvider transport={transport}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );

    const pill = await screen.findByTestId("printer-attention-pill");
    expect(pill).toBeInTheDocument();

    fireEvent.click(pill);
    const dialog = screen.getByTestId("printer-attention-dialog");
    // The shared primitive owns modal mechanics (portal, Escape and focus restoration), rather
    // than this surface recreating them with document listeners.
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(screen.getByTestId("printer-attention-pair")).toHaveFocus();

    fireEvent.click(screen.getByTestId("printer-attention-pair"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/printing/capability",
      expect.objectContaining({ method: "POST" })
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument();
      expect(pill).toHaveFocus();
    });

    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument();
      expect(pill).toHaveFocus();
    });
  });

  it("marks an unpaired session as destructive, stays open on a failed pair and closes after a successful one", async () => {
    window.localStorage.clear(); // no remembered printer, so no gesture-free reconnect
    const transport = createFakePrintTransport();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(url === "/api/printing/status" ? { active: true } : { registered: true })
          )
        )
      )
    );
    render(
      <PrinterSessionProvider transport={transport}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );

    const pill = await screen.findByTestId("printer-attention-pill");
    await waitFor(() => expect(pill).toHaveAttribute("data-healthy", "false"));
    expect(pill.className).toContain("bg-destructive");

    fireEvent.click(pill);
    transport.scriptPairFailure();
    fireEvent.click(screen.getByTestId("printer-attention-pair"));
    await waitFor(() =>
      expect(screen.getByTestId("printer-attention-state")).toHaveAttribute(
        "data-state",
        "unpaired"
      )
    );
    expect(screen.getByTestId("printer-attention-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("printer-attention-pair"));
    await waitFor(() => {
      expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("printer-attention-pill")).toHaveAttribute("data-healthy", "true");
  });

  it("does not render the attention pill when the real plugin-status boundary reports inactive", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ active: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PrinterSessionProvider transport={createFakePrintTransport()}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/printing/status", { credentials: "include" });
    expect(screen.queryByTestId("printer-attention-pill")).not.toBeInTheDocument();
  });

  it("opens the pairing prompt by itself when queued work finds no paired printer", async () => {
    window.localStorage.clear();
    const fetchMock = queueFetch(["printed", "pending"]);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PrinterSessionProvider transport={createFakePrintTransport()}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );
    await screen.findByTestId("printer-attention-pill");

    act(() => notifyPrintIntentEnqueued());

    const dialog = await screen.findByTestId("printer-attention-dialog");
    expect(dialog).toHaveAttribute("data-reason", "waiting-work");
    expect(screen.getByText("Something is ready to print!")).toBeInTheDocument();
    expect(screen.getByTestId("printer-attention-state")).toHaveTextContent(
      "No printer has been paired on this screen yet. Connect the printer and it will print by itself."
    );
    expect(screen.getByTestId("printer-attention-pair")).toHaveTextContent("Pair printer");
    expect(fetchMock).toHaveBeenCalledWith("/api/printing/jobs", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument()
    );
  });

  it("stays closed when the wake finds nothing waiting for a printer", async () => {
    window.localStorage.clear();
    // A future-dated job stays pending, but the server only claims today's work.
    const fetchMock = queueFetch(["printed", "dead-letter", ["pending", FUTURE]]);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PrinterSessionProvider transport={createFakePrintTransport()}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );
    await screen.findByTestId("printer-attention-pill");

    act(() => notifyPrintIntentEnqueued());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/printing/jobs", expect.anything())
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument();
  });

  it("waits for an on-screen celebration to finish before prompting", async () => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", queueFetch(["pending"]));
    const view = render(
      <PrinterSessionProvider transport={createFakePrintTransport()}>
        <PrinterAttention />
        <CompletionCelebration
          colorKey="blue"
          emojis={[]}
          title="Morning done!"
          sound={false}
          onDismiss={() => {}}
        />
      </PrinterSessionProvider>
    );
    await screen.findByTestId("printer-attention-pill");

    act(() => notifyPrintIntentEnqueued());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByTestId("completion-celebration")).toBeInTheDocument();
    expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument();

    view.rerender(
      <PrinterSessionProvider transport={createFakePrintTransport()}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );
    expect(await screen.findByTestId("printer-attention-dialog")).toHaveAttribute(
      "data-reason",
      "waiting-work"
    );
  });

  it("renders nothing outside a printer session", () => {
    const { container } = render(<PrinterAttention />);
    expect(container).toBeEmptyDOMElement();
  });

  function rememberPrinter(name: string) {
    window.localStorage.setItem(
      REMEMBERED_PRINTER_KEY,
      JSON.stringify({ deviceId: "dev-1", name, serviceUuid: "svc", characteristicUuid: "chr" })
    );
  }

  it.each([
    ["Kitchen printer", "The printer “Kitchen printer” is not connected."],
    ["", "The usual printer is not connected."],
  ])("says a printer was paired before (%j) and offers to reconnect it", async (name, expected) => {
    window.localStorage.clear();
    rememberPrinter(name);
    const transport = createFakePrintTransport();
    transport.scriptReconnectFailure(new PrintTransportError("pairing_required", "gone"));
    vi.stubGlobal("fetch", queueFetch([]));
    render(
      <PrinterSessionProvider transport={transport}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );
    const pill = await screen.findByTestId("printer-attention-pill");
    await waitFor(() => expect(pill).toHaveAttribute("data-healthy", "false"));
    fireEvent.click(pill);
    expect(screen.getByTestId("printer-attention-state")).toHaveTextContent(expected);
    expect(screen.getByTestId("printer-attention-pair")).toHaveTextContent("Reconnect printer");
  });

  it("names the connected printer while healthy", async () => {
    window.localStorage.clear();
    rememberPrinter("Kitchen printer");
    vi.stubGlobal("fetch", queueFetch([]));
    render(
      <PrinterSessionProvider transport={createFakePrintTransport()}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );
    const pill = await screen.findByTestId("printer-attention-pill");
    await waitFor(() => expect(pill).toHaveAttribute("data-healthy", "true"));
    fireEvent.click(pill);
    expect(screen.getByTestId("printer-attention-state")).toHaveTextContent(
      "Connected to “Kitchen printer”."
    );
    expect(screen.queryByTestId("printer-attention-pair")).not.toBeInTheDocument();
  });

  it("closes an automatic prompt when a gesture-free reconnect succeeds meanwhile", async () => {
    window.localStorage.clear();
    rememberPrinter("Kitchen printer");
    const transport = createFakePrintTransport();
    transport.scriptReconnectFailure();
    vi.stubGlobal("fetch", queueFetch(["pending"]));
    render(
      <PrinterSessionProvider transport={transport} pollIntervalMs={300}>
        <PrinterAttention />
      </PrinterSessionProvider>
    );
    const pill = await screen.findByTestId("printer-attention-pill");
    await waitFor(() => expect(pill).toHaveAttribute("data-healthy", "false"));

    act(() => notifyPrintIntentEnqueued());
    expect(await screen.findByTestId("printer-attention-dialog")).toHaveAttribute(
      "data-reason",
      "waiting-work"
    );

    // The next background attempt succeeds and the prompt goes away by itself.
    await waitFor(() => expect(pill).toHaveAttribute("data-healthy", "true"), { timeout: 2000 });
    await waitFor(() =>
      expect(screen.queryByTestId("printer-attention-dialog")).not.toBeInTheDocument()
    );
  });
});
