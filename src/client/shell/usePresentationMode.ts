import { useEffect, useState } from "react";

function isPresentationModeActive(
  standalone: MediaQueryList | null,
  fullscreen: MediaQueryList | null
): boolean {
  return (
    (typeof document.fullscreenElement !== "undefined" && document.fullscreenElement !== null) ||
    standalone?.matches === true ||
    fullscreen?.matches === true
  );
}

/** Tracks the browser presentation seams.
 * This is device presentation only; it deliberately has no household-date dependency.
 */
export function usePresentationMode(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // jsdom has no matchMedia. Real browsers use exactly the two lists below.
    const matchMedia = typeof window.matchMedia === "function" ? window.matchMedia : undefined;
    const standalone = matchMedia?.("(display-mode: standalone)") ?? null;
    const fullscreen = matchMedia?.("(display-mode: fullscreen)") ?? null;
    const update = () => setActive(isPresentationModeActive(standalone, fullscreen));

    update();
    document.addEventListener("fullscreenchange", update);
    standalone?.addEventListener("change", update);
    fullscreen?.addEventListener("change", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      standalone?.removeEventListener("change", update);
      fullscreen?.removeEventListener("change", update);
    };
  }, []);

  return active;
}
