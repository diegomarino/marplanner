import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("submits only 4-6 digits and retains wrong-PIN and request-error feedback", async () => {
    const fetchMock = vi
      .fn()
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
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN.");

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
