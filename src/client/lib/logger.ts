import { appUrl } from "@/lib/base-path";
/** Shared client telemetry logger.
 * A page-lifetime singleton. Producers call `log`; entries land in a volatile in-memory
 * buffer that is flushed periodically (every `FLUSH_INTERVAL_MS`) or immediately once
 * `MAX_BUFFER_SIZE` entries have accumulated. On page unload (`pagehide` /
 * `visibilitychange: hidden`) the buffer is flushed via `navigator.sendBeacon` (falling back
 * to a `fetch(..., {keepalive:true})` best-effort send when `sendBeacon` is unavailable or
 * rejects the payload).
 * INV-02 (at-most-once): every flush path SPLICES the buffer out (clears it) BEFORE attempting
 * to send. A failed send is therefore simply lost — it is never re-queued or retried. This is
 * deliberate: telemetry MUST NOT become a source of retry storms or replay duplication.
 * INV-01 (never product truth): `log` never throws into its caller — the entire body is
 * wrapped in try/catch, and every send path swallows its own failures.
 */
import type { ClientLogEntryInput, ClientLogLevel } from "../../shared";

const TELEMETRY_ENDPOINT = "/api/telemetry/client-log";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFER_SIZE = 50;

// Mirrors src/server/telemetry/index.ts's MAX_COMPONENT_LEN/MAX_MESSAGE_LEN. The server rejects a
// whole entry past these limits, so clamp client-side to keep an over-length string from silently
// vanishing at the server boundary.
const MAX_COMPONENT_LEN = 64;
const MAX_MESSAGE_LEN = 256;

/** Injectable transport — jsdom tests substitute a fake to avoid real network. */
export type LoggerTransport = (entries: ClientLogEntryInput[]) => Promise<void> | void;

async function defaultTransport(entries: ClientLogEntryInput[]): Promise<void> {
  // No `keepalive` here: this is the periodic-interval flush, which can carry
  // up to MAX_BUFFER_SIZE (50) entries — a fetch keepalive request has a ~64KB body cap, and a
  // large error-storm batch that exceeds it is REJECTED outright, dropping all 50 entries
  // (at-most-once, no retry — INV-02). keepalive stays on the best-effort unload path below,
  // where the browser is tearing the page down and a non-keepalive fetch would be cancelled.
  const res = await fetch(appUrl(TELEMETRY_ENDPOINT), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    throw new Error(`telemetry flush failed with status ${res.status}`);
  }
}

let buffer: ClientLogEntryInput[] = [];
let transport: LoggerTransport = defaultTransport;

/** DEV-only console mirror (INV-06 scope: the client console mirror is the one lint exemption). */
function mirrorToConsole(
  level: ClientLogLevel,
  component: string,
  message: string,
  data: unknown
): void {
  if (!import.meta.env.DEV) return;
  try {
    const line = `[telemetry:${component}] ${message}`;
    switch (level) {
      case "debug":
        console.debug(line, data ?? "");
        break;
      case "info":
        console.info(line, data ?? "");
        break;
      case "warn":
        console.warn(line, data ?? "");
        break;
      case "error":
        console.error(line, data ?? "");
        break;
    }
  } catch {
    // never let the dev mirror itself become a throw source
  }
}

/** Splice the buffer out, THEN attempt to send (at-most-once, INV-02). A failed/rejected send is
 * swallowed — the spliced entries are simply dropped, never re-queued.
 */
async function performFlush(): Promise<void> {
  if (buffer.length === 0) return;
  const toSend = buffer;
  buffer = [];
  try {
    await transport(toSend);
  } catch {
    // dropped — at-most-once, no retry (INV-02)
  }
}

/** Best-effort unload flush: sendBeacon first (survives page teardown), fetch keepalive fallback. */
function flushForUnload(): void {
  if (buffer.length === 0) return;
  const toSend = buffer;
  buffer = []; // splice-before-send applies here too — at-most-once even on the unload path

  // `JSON.stringify` on a cyclic or bigint-bearing `data` throws — it MUST be
  // inside a try/catch like every other step of this best-effort path, or a poisoned entry
  // reaching a pagehide/visibilitychange handler would throw into the browser's own unload
  // machinery, violating the module's never-throws contract (INV-01). A serialization failure
  // simply drops the batch — at-most-once, no retry (INV-02).
  let body: string;
  try {
    body = JSON.stringify({ entries: toSend });
  } catch {
    return;
  }

  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const delivered = navigator.sendBeacon(appUrl(TELEMETRY_ENDPOINT), blob);
      if (delivered) return;
    }
  } catch {
    // fall through to the fetch fallback below
  }

  try {
    void fetch(appUrl(TELEMETRY_ENDPOINT), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body,
    }).catch(() => {
      // dropped — at-most-once, no retry (INV-02)
    });
  } catch {
    // never throw (INV-01/INV-02) — a synchronous fetch-construction failure is swallowed too
  }
}

/** Log one entry. NEVER throws into the caller — any internal
 * failure (buffer push, console mirror, cap-flush kick-off) is swallowed.
 */
export function log(
  level: ClientLogLevel,
  component: string,
  message: string,
  data?: unknown
): void {
  try {
    // The server ingest boundary (src/server/telemetry/index.ts
    // `validateEntry`) DROPS THE WHOLE ENTRY when component.length > MAX_COMPONENT_LEN,
    // message.length > MAX_MESSAGE_LEN, or message.trim.length === 0 — clamp client-side so a
    // long/empty browser-generated string never silently vanishes at that boundary.
    const boundedComponent = component.slice(0, MAX_COMPONENT_LEN);
    const clampedMessage = message.slice(0, MAX_MESSAGE_LEN);
    const boundedMessage = clampedMessage.trim().length === 0 ? "unknown error" : clampedMessage;
    const entry: ClientLogEntryInput = {
      level,
      component: boundedComponent,
      message: boundedMessage,
      eventTime: Date.now(),
    };
    if (data !== undefined) {
      entry.data = data;
    }
    buffer.push(entry);
    mirrorToConsole(level, boundedComponent, boundedMessage, data);
    if (buffer.length >= MAX_BUFFER_SIZE) {
      void performFlush();
    }
  } catch {
    // INV-01: telemetry must never throw into product code
  }
}

let intervalStarted = false;

function startFlushInterval(): void {
  if (intervalStarted) return;
  if (typeof window === "undefined") return;
  intervalStarted = true;
  setInterval(() => {
    void performFlush();
  }, FLUSH_INTERVAL_MS);
}

function installUnloadListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", flushForUnload);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushForUnload();
      }
    });
  }
}

startFlushInterval();
installUnloadListeners();

/** Test-only: force an immediate flush and await its completion. */
export function __flushNowForTests(): Promise<void> {
  return performFlush();
}

/** Test-only: invoke the best-effort unload path directly. Deliberately NOT
 * exercised via a real `window.dispatchEvent(new Event("pagehide"))` in tests — every fresh
 * `vi.resetModules`-imported module instance registers its OWN `pagehide` listener on the
 * shared jsdom `window` and never tears it down (this module is a page-lifetime singleton by
 * design), so a real dispatch would also fire every earlier test's stale listener/buffer in the
 * same file. Calling this direct hook keeps the assertion scoped to the current instance only.
 */
export function __flushForUnloadNowForTests(): void {
  flushForUnload();
}

/** Test-only: substitute the transport (or pass `null` to restore the real fetch-based one). */
export function __setTransportForTests(fn: LoggerTransport | null): void {
  transport = fn ?? defaultTransport;
}

/** Test-only: drop any buffered-but-unflushed entries, so tests start from a clean buffer. */
export function __resetLoggerStateForTests(): void {
  buffer = [];
}

/** Test-only: read the current buffer contents without flushing (does not mutate). */
export function __peekBufferForTests(): readonly ClientLogEntryInput[] {
  return buffer;
}

/** Expose a minimal test hook on `window` — gated to DEV builds and to an explicit e2e build flag
 * (`VITE_E2E_HOOKS=true`, wired via `playwright.config.ts`'s `webServer.env`). Production builds
 * without that flag never attach anything to `window`.
 */
interface TelemetryWindowHook {
  log: typeof log;
  flush: () => Promise<void>;
}

// Keep development and browser-test telemetry hooks typed on the global Window.
declare global {
  interface Window {
    __mpTelemetry?: TelemetryWindowHook;
  }
}

const hooksEnabled = Boolean(import.meta.env.DEV) || import.meta.env.VITE_E2E_HOOKS === "true";
if (typeof window !== "undefined" && hooksEnabled) {
  window.__mpTelemetry = {
    log,
    flush: __flushNowForTests,
  };
}
