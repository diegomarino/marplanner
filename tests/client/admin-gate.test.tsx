import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminGate } from "@/admin/AdminGate";
import { AdminUnlockProvider } from "@/lib/adminUnlock";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

const CORRECT_PIN = "1234";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockBackend() {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/auth/verify-pin") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { pin?: string };
      return Promise.resolve(json({ match: body.pin === CORRECT_PIN }));
    }
    if (url.includes("/api/settings")) {
      return Promise.resolve(json({ locale: { language: "en" } }));
    }
    throw new Error(`unexpected fetch: ${url} (${method})`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderSurface() {
  return render(
    <AdminUnlockProvider>
      <AdminGate />
    </AdminUnlockProvider>
  );
}

function enterPin(pin: string) {
  for (const digit of pin) {
    fireEvent.click(screen.getByTestId(`admin-pin-digit-${digit}`));
  }
}

const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return Array.from(container.querySelectorAll(CENSUS_CONTROL_SELECTOR)).filter((element) => {
    if (element instanceof HTMLElement && element.hidden) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  cleanup();
  window.history.replaceState({}, "", "/");
  document.documentElement.removeAttribute("data-density");
});

describe("AdminGate — local development PIN bypass", () => {
  it("opens Admin directly when the explicit local bypass flag is enabled", async () => {
    const mockFetch = mockBackend();
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_DEV_BYPASS_ADMIN_PIN", "1");
    renderSurface();

    expect(await screen.findByTestId("admin-nav-calendar")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-pin-keypad")).not.toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some(([input]) => String(input).includes("/api/auth/verify-pin"))
    ).toBe(false);
  });
});

describe("AdminGate — kiosk density across reachable states", () => {
  it("meets kiosk density for PIN entry, errors, unlocked content, and re-lock", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["h-[64px]", "w-[64px]", "text-[24px]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      renderSurface();
      expect(countInteractiveControls(document.body)).toBe(13);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      enterPin("0000");
      fireEvent.click(screen.getByTestId("admin-pin-unlock"));
      await screen.findByRole("alert");
      expect(countInteractiveControls(document.body)).toBe(13);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      for (let index = 0; index < 4; index += 1) {
        fireEvent.click(screen.getByTestId("admin-pin-backspace"));
      }
      enterPin(CORRECT_PIN);
      fireEvent.click(screen.getByTestId("admin-pin-unlock"));
      await screen.findByTestId("admin-nav-calendar");
      // Overview: fifteen sidebar links + Lock, Check now, Open telemetry.
      expect(countInteractiveControls(document.body)).toBe(18);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      fireEvent.click(screen.getByTestId("admin-lock-button"));
      await screen.findByTestId("admin-pin-keypad");
      expect(countInteractiveControls(document.body)).toBe(13);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — rejects an undersized keypad control", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["h-[64px]", "w-[64px]", "text-[24px]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = renderSurface();
      const digit = screen.getByTestId("admin-pin-digit-1");
      digit.style.height = "10px";
      digit.style.width = "10px";
      digit.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DensityViolationError);
      expect((thrown as DensityViolationError).message).toMatch(
        /height 10px is below the kiosk minimum 48px/
      );
    } finally {
      uninject();
    }
  });
});

describe("AdminGate — error announcements", () => {
  it("announces an incorrect PIN through the live region", async () => {
    mockBackend();
    renderSurface();
    enterPin("0000");
    fireEvent.click(screen.getByTestId("admin-pin-unlock"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Incorrect PIN.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a verify request failure through the live region", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json(null, 500)))
    );
    renderSurface();
    enterPin(CORRECT_PIN);
    fireEvent.click(screen.getByTestId("admin-pin-unlock"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Request failed.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("AdminGate — panel re-lock", () => {
  async function unlockWithFakeTimersActive() {
    enterPin(CORRECT_PIN);
    fireEvent.click(screen.getByTestId("admin-pin-unlock"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("an explicit Lock control re-locks immediately", async () => {
    mockBackend();
    renderSurface();
    enterPin(CORRECT_PIN);
    fireEvent.click(screen.getByTestId("admin-pin-unlock"));
    await screen.findByTestId("admin-lock-button");

    fireEvent.click(screen.getByTestId("admin-lock-button"));
    expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-nav-calendar")).not.toBeInTheDocument();
  });

  it("auto-locks after five minutes of admin inactivity", async () => {
    mockBackend();
    renderSurface();
    vi.useFakeTimers();
    await unlockWithFakeTimersActive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    });
    expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
  });

  it("admin interaction resets the idle timer", async () => {
    mockBackend();
    renderSurface();
    vi.useFakeTimers();
    await unlockWithFakeTimersActive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1_000);
    });
    fireEvent.keyDown(screen.getByTestId("admin-nav-calendar"), { key: "Tab" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("admin-nav-calendar")).toBeInTheDocument();
  });

  it("activity outside the admin subtree does not reset the timer", async () => {
    mockBackend();
    renderSurface();
    vi.useFakeTimers();
    await unlockWithFakeTimersActive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1_000);
    });
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
  });

  it("an assistive-technology click inside Admin resets the idle timer", async () => {
    mockBackend();
    renderSurface();
    vi.useFakeTimers();
    await unlockWithFakeTimersActive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1_000);
    });
    // A control that keeps the overview on screen: a section button would navigate away.
    fireEvent.click(screen.getByTestId("admin-overview-check"), { detail: 0 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("admin-nav-calendar")).toBeInTheDocument();
  });

  it("capture-phase activity survives a descendant stopping propagation", async () => {
    mockBackend();
    renderSurface();
    vi.useFakeTimers();
    const stopPropagation = (event: Event) => event.stopPropagation();
    await unlockWithFakeTimersActive();
    document.body.addEventListener("keydown", stopPropagation);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1_000);
      });
      fireEvent.keyDown(screen.getByTestId("admin-nav-calendar"), { key: "Tab" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByTestId("admin-nav-calendar")).toBeInTheDocument();
    } finally {
      document.body.removeEventListener("keydown", stopPropagation);
    }
  });
});

describe("AdminGate — protected destinations", () => {
  async function unlockDirectRoute() {
    enterPin(CORRECT_PIN);
    fireEvent.click(screen.getByTestId("admin-pin-unlock"));
  }

  it("opens the directly requested destination after unlock", async () => {
    window.history.replaceState({}, "", "/admin/printing");
    mockBackend();
    renderSurface();
    await unlockDirectRoute();

    expect(await screen.findByTestId("printing-management")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin/printing");
  });

  it("keeps an unknown admin route locked until the PIN succeeds", async () => {
    window.history.replaceState({}, "", "/admin/unknown");
    mockBackend();
    renderSurface();
    expect(screen.queryByTestId("admin-route-not-found")).not.toBeInTheDocument();
    await unlockDirectRoute();

    expect(await screen.findByTestId("admin-route-not-found")).toBeInTheDocument();
    expect(screen.queryByTestId("printing-management")).not.toBeInTheDocument();
  });
});
