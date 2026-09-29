import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrinterAttention } from "@/printing/PrinterAttention";
import { PrinterSessionProvider } from "@/printing/PrinterSession";
import { createFakePrintTransport } from "@/printing/transport";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({ language: "en" }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
});
