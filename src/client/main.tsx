import "temporal-polyfill/global";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";
import { registerShellService, Shell } from "./shell/Shell";
import { COMFORTABLE_DENSITY, setDensity } from "./shell/densityAttribute";
import { log } from "./lib/logger";
//: side-effect import mounts the headless time-announcements service into
// the US0 `ShellServices` slot (registerShellService runs at THIS module's import time,
// see service.tsx's header comment for why this lives here and not in Shell.tsx).
import { AnnouncementService } from "./time-announcements/service";

registerShellService(AnnouncementService, {
  id: "time-announcements",
  contributionId: "time-announcements-speaker",
});

/** Global capture: uncaught errors and unhandled promise rejections become
 * telemetry entries so kiosk failures survive past the browser's own console. Registered before
 * the app renders so it also covers failures during initial mount. `stack` is bounded (the
 * redactor's own size/value-pattern pass runs server-side; this cap just keeps the client-side
 * payload sane before it ever leaves the device).
 */
const MAX_STACK_CHARS = 2000;

function boundStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  return stack.length > MAX_STACK_CHARS ? stack.slice(0, MAX_STACK_CHARS) : stack;
}

window.addEventListener("error", (event: Event) => {
  // /623 resource-load failures (a failed <img>/<script>/<link> fetch) dispatch a
  // bare `Event` on `window`, not an `ErrorEvent` — `event.error`/`event.message` are both
  // undefined for those, producing a useless "unknown error" row with no diagnostic value.
  // Only handle the actual ErrorEvent case (script errors).
  if (!(event instanceof ErrorEvent)) return;
  // INV-03 pattern (stable producer message, like the i18n producer's "missing_key"): the
  // envelope `message` stays a fixed, low-cardinality string so rows group/filter meaningfully;
  // the original (bounded) text travels in `data`, never as the message itself.
  const rawMessage =
    event.error instanceof Error ? event.error.message : (event.message ?? "unknown error");
  const stack = event.error instanceof Error ? event.error.stack : undefined;
  log("error", "client.global", "unhandled_error", {
    message: rawMessage,
    stack: boundStack(stack),
  });
});

window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const reason = event.reason as unknown;
  // INV-03 pattern (stable producer message): see the `error` listener above.
  const rawMessage = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  log("error", "client.global", "unhandled_rejection", {
    message: rawMessage,
    stack: boundStack(stack),
  });
});

// Ignore stored kiosk density while Options has no control to undo it.
// TODO(density): restore persisted density with the control and shell tests;
// see docs/development/style-guide.md#release-density-behavior.
setDensity(COMFORTABLE_DENSITY);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>
);
