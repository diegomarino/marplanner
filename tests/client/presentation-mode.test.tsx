import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePresentationMode } from "@/shell/usePresentationMode";

function PresentationModeProbe() {
  const active = usePresentationMode();
  return <output>{active ? "active" : "inactive"}</output>;
}

function createMediaQuery(initial = false) {
  let listener: ((event: MediaQueryListEvent) => void) | undefined;
  const query = {
    matches: initial,
    addEventListener: vi.fn((_type: "change", next: (event: MediaQueryListEvent) => void) => {
      listener = next;
    }),
    removeEventListener: vi.fn(),
    emit(matches: boolean) {
      query.matches = matches;
      listener?.({ matches } as MediaQueryListEvent);
    },
  };
  return query;
}

describe("usePresentationMode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tracks fullscreen and the two probed display-mode changes, then removes every listener", () => {
    const standalone = createMediaQuery();
    const fullscreen = createMediaQuery();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => (query === "(display-mode: standalone)" ? standalone : fullscreen))
    );
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });

    const { unmount } = render(<PresentationModeProbe />);
    expect(screen.getByText("inactive")).toBeInTheDocument();

    fullscreenElement = document.documentElement;
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(screen.getByText("active")).toBeInTheDocument();

    fullscreenElement = null;
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
    act(() => standalone.emit(true));
    expect(screen.getByText("active")).toBeInTheDocument();

    act(() => standalone.emit(false));
    act(() => fullscreen.emit(false));
    expect(screen.getByText("inactive")).toBeInTheDocument();

    unmount();
    expect(standalone.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(fullscreen.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("stays inactive when fullscreenElement and matchMedia are unavailable", () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: undefined,
    });
    vi.stubGlobal("matchMedia", undefined);

    render(<PresentationModeProbe />);

    expect(screen.getByText("inactive")).toBeInTheDocument();
  });
});
