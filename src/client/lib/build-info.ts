import type { BuildInfo } from "../../shared";

// Injected by Vite (`define` in vite.config.ts). Absent under the unit-test runner.
declare const __MP_BUILD__: BuildInfo | undefined;

/** The commit this client bundle was built from, or null when the bundle carries none. */
export function clientBuildInfo(): BuildInfo | null {
  return typeof __MP_BUILD__ !== "undefined" && __MP_BUILD__ ? __MP_BUILD__ : null;
}
