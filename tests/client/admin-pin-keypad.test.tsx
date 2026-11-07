import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminGate } from "@/admin/AdminGate";
import { AdminUnlockProvider } from "@/lib/adminUnlock";

function renderGate() {
  return render(
    <AdminUnlockProvider>
      <AdminGate />
    </AdminUnlockProvider>
  );
}

function sentPins(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith("/api/auth/verify-pin"))
    .map((call) => (JSON.parse(String((call[1] as RequestInit).body)) as { pin: string }).pin);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("AdminGate touch PIN keypad", () => {
  it("enters, masks, deletes, and caps the PIN at six digits without a conventional input", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderGate();

    expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-pin-input")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).not.toBeInTheDocument();

    for (const digit of [1, 2, 3, 4, 5, 6, 7]) {
      fireEvent.click(screen.getByTestId(`admin-pin-digit-${digit}`));
    }
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●●●●");
    expect(screen.getByTestId("admin-pin-digit-7")).toBeDisabled();

    fireEvent.click(screen.getByTestId("admin-pin-backspace"));
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●●●");
  });

  it("draws Backspace on the same circular key surface as the digits", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderGate();

    const digit = screen.getByTestId("admin-pin-digit-1");
    const backspace = screen.getByRole("button", { name: "Backspace" });
    expect(backspace).toHaveAttribute("data-testid", "admin-pin-backspace");
    // Same variant, size, border and shape: every class of a digit key except the digit's weight.
    const surface = [...digit.classList].filter((name) => name !== "font-semibold");
    expect(backspace).toHaveClass(...surface);
  });

  it("accepts hardware keyboard digits, Backspace, and Enter to submit", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ match: false })));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    for (const digit of "123") fireEvent.keyDown(window, { key: digit });
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●");
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●");
    fireEvent.keyDown(window, { key: "5" });
    expect(fetchMock).not.toHaveBeenCalled();

    // Four digits auto-probe silently; Enter then submits the same digits visibly.
    fireEvent.keyDown(window, { key: "6" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN.");
    expect(sentPins(fetchMock)).toEqual(["1256"]);
  });

  it("keeps modified keys, editing fields, and focused control activation out of global PIN entry", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AdminUnlockProvider>
        <input aria-label="External field" />
        <AdminGate />
      </AdminUnlockProvider>
    );
    fireEvent.keyDown(window, { key: "Enter" });
    for (const modifier of ["ctrlKey", "metaKey", "altKey"])
      fireEvent.keyDown(window, { key: "1", [modifier]: true });
    fireEvent.keyDown(screen.getByLabelText("External field"), { key: "2" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("admin-pin-display")).not.toHaveTextContent("●");
    for (const digit of "123") fireEvent.keyDown(window, { key: digit });
    const digitButton = screen.getByTestId("admin-pin-digit-5");
    fireEvent.keyDown(digitButton, { key: "Backspace" });
    fireEvent.keyDown(digitButton, { key: "Enter" });
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-submits at 4, 5 and 6 digits and unlocks on a match without the button", async () => {
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) =>
      Promise.resolve(
        String(url).endsWith("/api/auth/verify-pin")
          ? Response.json({ match: JSON.parse(String(init?.body)).pin === "123456" })
          : Response.json({})
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    for (const digit of "1234") fireEvent.keyDown(window, { key: digit });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "5" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(window, { key: "6" });

    await waitFor(() => expect(screen.queryByTestId("admin-pin-keypad")).not.toBeInTheDocument());
    expect(sentPins(fetchMock)).toEqual(["1234", "12345", "123456"]);
  });

  it("keeps 4- and 5-digit rejections silent and leaves the digits in place", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ match: false })));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    for (const digit of [1, 2, 3, 4])
      fireEvent.click(screen.getByTestId(`admin-pin-digit-${digit}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The probe is in flight without freezing the keypad.
    expect(screen.getByTestId("admin-pin-digit-5")).toBeEnabled();
    fireEvent.click(screen.getByTestId("admin-pin-digit-5"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(() => Promise.resolve());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●●●");
    expect(screen.getByTestId("admin-pin-unlock")).toHaveTextContent("→");
  });

  it("shows the error and clears the digits when the 6-digit attempt is rejected", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ match: false })));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    for (const digit of "123456") fireEvent.keyDown(window, { key: digit });

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN.");
    expect(screen.getByTestId("admin-pin-display")).not.toHaveTextContent("●");
    // 12345 was still waiting behind the 1234 probe when 6 arrived, so only 123456 followed.
    expect(sentPins(fetchMock)).toEqual(["1234", "123456"]);

    fireEvent.keyDown(window, { key: "9" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never runs two verifications at once and sends only the latest waiting digits", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    for (const digit of "1234") fireEvent.keyDown(window, { key: digit });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "5" });
    fireEvent.keyDown(window, { key: "6" });
    // 12345 and 123456 arrived while 1234 was in flight: only the latest waits.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("admin-pin-unlock")).toHaveTextContent("…");

    pending[0](Response.json({ match: false }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sentPins(fetchMock)).toEqual(["1234", "123456"]);
    pending[1](Response.json({ match: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not submit after Backspace and drops a waiting attempt for deleted digits", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    for (const digit of "12345") fireEvent.keyDown(window, { key: digit });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Backspace" });
    fireEvent.keyDown(window, { key: "Backspace" });
    pending[0](Response.json({ match: false }));
    await act(() => Promise.resolve());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("caps keyboard entry and freezes it while the visible verification is pending", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();
    for (const digit of "1234") fireEvent.keyDown(window, { key: digit });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "8" });
    fireEvent.keyDown(window, { key: "Backspace" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("●●●●");
    // Enter promoted the in-flight probe for the same digits instead of resending them.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending[0](Response.json({ match: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN.");
  });

  it("keeps the Unlock button as a manual, visible submit for 4-6 digits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ match: false }))
      .mockResolvedValueOnce(Response.json({ match: false }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderGate();

    const submit = screen.getByTestId("admin-pin-unlock");
    expect(submit).toBeDisabled();
    for (const digit of [1, 2, 3]) fireEvent.click(screen.getByTestId(`admin-pin-digit-${digit}`));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByTestId("admin-pin-digit-4"));
    expect(submit).toBeEnabled();
    // Let the silent probe settle, then submit the same digits manually.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN.");
    expect(screen.getByTestId("admin-pin-display")).not.toHaveTextContent("●");

    for (const digit of [1, 2, 3, 4])
      fireEvent.click(screen.getByTestId(`admin-pin-digit-${digit}`));
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed.");
  });

  it("clears state and returns to the recorded family route on Cancel", async () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState({}, "", "/meals");
    window.history.pushState({ marplannerAdminReturnPath: "/meals" }, "", "/admin");
    renderGate();

    fireEvent.click(screen.getByTestId("admin-pin-digit-1"));
    fireEvent.click(screen.getByTestId("admin-pin-cancel"));

    expect(screen.getByTestId("admin-pin-display")).toHaveTextContent("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/meals"));
  });

  it("falls back to Home when direct Admin navigation has no family history marker", () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState({}, "", "/admin");
    renderGate();

    fireEvent.click(screen.getByTestId("admin-pin-cancel"));

    expect(window.location.pathname).toBe("/");
  });
});
