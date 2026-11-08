/** Printer transport seam ( FR-019/FR-020).
 * `PrintTransport` is the executor's only view of "the printer" — a pairing ritual, a
 * readiness flag, and a byte-transmit call. The production implementation ports
 * v1's `BluetoothStrategy` shape (cited below) behind this interface; jsdom has no Web
 * Bluetooth API at all, so every bit of ACTUAL logic (chunk math, inter-chunk delay,
 * GATT-reconnect retry/backoff) lives in plain, dependency-injected pure functions
 * (`chunkBytes` / `writeChunks` / `retryWithDelay`) that take zero real I/O — the BT glue
 * (`createBluetoothPrintTransport`) is a thin adapter over `navigator.bluetooth` that calls
 * straight through to them and is never unit-tested directly (only exercised live, the * close-time smoke, and through the fake in e2e).
 * Source (v1, ported as-is per the maintainer's "funciona, portar tal cual" call, * US4/): `apps/web/src/lib/printer/strategies/BluetoothStrategy.ts` —
 * 100-byte chunks (`CHUNK_SIZE`), 5 ms inter-chunk delay (`INTER_CHUNK_DELAY_MS`),
 * `writeValueWithoutResponse` with a `writeValue` fallback, 3x GATT-connect retries
 * (`GATT_CONNECT_RETRIES`) with a 2 s backoff, pairing via `requestDevice` behind an
 * explicit user gesture. Reconnect is gesture-free for a device this browser already granted
 * (`reconnect`): the in-memory `BluetoothDevice` after an unexpected drop, else
 * `navigator.bluetooth.getDevices()` where the browser implements it, with a bounded GATT
 * connect. Without either, the explicit-gesture `pair` ritual is the fallback. The stored
 * `printerTransport` UUIDs stay a try-first preference.
 * Seam (D6): `__setPrintTransportForTests` overrides `createPrintTransport`'s return
 * value unconditionally (client unit/component tests call this directly — no env flag
 * needed). Absent an override, a DEV or `VITE_E2E_HOOKS=true` build (mirrors
 * `time-announcements/seams.ts`'s `HOOKS_ENABLED` gate) returns a shared fake instance
 * exposed at `window.__mpPrintTransport` for Playwright e2e to script through
 * `page.evaluate` — a production build with neither set gets the real Bluetooth
 * transport.
 */

import type { PrinterTransportSettings } from "../../shared";

/** A stored service/characteristic the pairing ritual tries first (never required). */
export type PrinterEndpointPreference = Partial<
  Pick<PrinterTransportSettings, "serviceUuid" | "characteristicUuid">
>;

/* ------------------------------------------------------------------ */
/* Pure, testable helpers — chunk math, delay, retry (no real I/O) */
/* ------------------------------------------------------------------ */

/** v1-ported constants (cited in the module doc above). */
export const CHUNK_SIZE = 100;
export const INTER_CHUNK_DELAY_MS = 5;
export const GATT_CONNECT_RETRIES = 3;
export const GATT_CONNECT_RETRY_DELAY_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split `bytes` into `chunkSize`-byte slices — the last one partial when it doesn't divide
 * evenly. Zero-length input yields zero chunks (nothing to write, nothing to sleep between). */
export function chunkBytes(bytes: Uint8Array, chunkSize: number = CHUNK_SIZE): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
}

/** One chunk's transmit call — the ONLY thing production/fake/test implementations differ on. */
export type ChunkWriter = (chunk: Uint8Array) => Promise<void>;

export interface WriteChunksOptions {
  chunkSize?: number;
  delayMs?: number;
  /** Injected sleep — real `setTimeout` in production, a no-op or a spy in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Write every chunk of `bytes` through `write`, sleeping `delayMs` after each one (v1 parity:
 * the delay fires after EVERY chunk, including the last — see `BluetoothStrategy.printJob`).
 * `write` rejecting propagates immediately — no chunk after the failing one is attempted, no
 * sleep after it either, and the returned promise rejects. Never a false resolve (FR-020).
 */
export async function writeChunks(
  bytes: Uint8Array,
  write: ChunkWriter,
  options: WriteChunksOptions = {}
): Promise<void> {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const delayMs = options.delayMs ?? INTER_CHUNK_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (const chunk of chunkBytes(bytes, chunkSize)) {
    await write(chunk);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

export interface RetryWithDelayOptions {
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Retry `attempt` up to `retries` times, sleeping `delayMs` between failed attempts (v1 parity:
 * `connectGattWithRetry` — no sleep after the FINAL failed attempt, since nothing follows it).
 * Resolves with the first successful result; rejects with the last error once retries are
 * exhausted.
 */
export async function retryWithDelay<T>(
  attempt: () => Promise<T>,
  options: RetryWithDelayOptions = {}
): Promise<T> {
  const retries = options.retries ?? GATT_CONNECT_RETRIES;
  const delayMs = options.delayMs ?? GATT_CONNECT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= retries; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (attemptNumber < retries) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/** Gesture-free reconnect budget: Android Chrome's `gatt.connect()` can wait indefinitely for
 * a printer that is off or out of range, so a reconnect attempt is bounded. */
export const RECONNECT_TIMEOUT_MS = 10_000;

/** Reject with `onTimeout()` when `promise` has not settled within `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* PrintTransport — the executor's only view of "the printer" */
/* ------------------------------------------------------------------ */

export type PrintTransportErrorCode =
  | "unsupported"
  | "secure_context_required"
  | "pairing_required"
  | "connect_failed"
  | "characteristic_not_found"
  | "write_failed";

/** Thrown by every `PrintTransport` method that can fail — `code` lets the executor
 * decide whether a failure is PERMANENT (dead-letters the job, contract vocabulary) or
 * recoverable (releases the lease, retried on the next claim). */
export class PrintTransportError extends Error {
  readonly code: PrintTransportErrorCode;

  constructor(code: PrintTransportErrorCode, message: string) {
    super(message);
    this.name = "PrintTransportError";
    this.code = code;
  }
}

export interface PrintTransport {
  /** Explicit-user-gesture pairing ritual. Resolves once a writable device is connected and
   * ready; rejects with a `PrintTransportError` otherwise (never leaves a half-paired state).
   * Resolves the paired device's identity; a preference is tried first, never required. */
  pair(preference?: PrinterEndpointPreference): Promise<PrinterTransportSettings>;
  /** Gesture-free reconnect to a device this browser already granted: the in-memory device
   * after an unexpected drop, else `navigator.bluetooth.getDevices()` where the browser has it.
   * Rejects with `pairing_required` when the device cannot be reached without a new gesture,
   * or with a recoverable code (`connect_failed`, ...) when it is known but did not answer. */
  reconnect(remembered: PrinterTransportSettings): Promise<PrinterTransportSettings>;
  /** Whether a connected, writable device is currently available. */
  isReady(): boolean;
  /** Transmit printer-ready bytes in chunked form. Rejects with a `PrintTransportError` on any
   * failure — a rejected promise is the ONLY failure signal (FR-020: no false acks). */
  printJob(bytes: Uint8Array): Promise<void>;
  /** Best-effort teardown of the current connection. Deliberately does NOT notify
   * `onDisconnect` subscribers — this is a SELF-initiated teardown (the caller already knows),
   * not the unexpected drop that hook exists for. */
  disconnect(): void;
  /** register a callback for an UNEXPECTED connection drop
   * (the production transport's own `gattserverdisconnected` event; the fake's scriptable
   * `triggerDisconnect`) — never fired by a local `disconnect` call. Returns an unsubscribe
   * function. Persists across re-pairs (the same transport instance is reused), so the
   * executor subscribes once for its whole lifetime. */
  onDisconnect(callback: () => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Fake transport — byte recorder + scriptable failures/disconnects */
/* ------------------------------------------------------------------ */

export interface FakePrintTransport extends PrintTransport {
  /** Every chunk `printJob` has successfully written so far, in order. */
  recordedChunks(): Uint8Array[];
  /** Clears recorded chunks, readiness, and any pending script. */
  reset(): void;
  /** The NEXT `pair` call rejects with `error` instead of succeeding (one-shot). */
  scriptPairFailure(error?: PrintTransportError): void;
  /** The NEXT `reconnect` call rejects with `error` instead of succeeding (one-shot). */
  scriptReconnectFailure(error?: PrintTransportError): void;
  /** How many times `reconnect` has been called since creation or `reset`. */
  reconnectCalls(): number;
  /** The NEXT `printJob` call rejects with `error` instead of succeeding (one-shot).
   * `disconnect: true` also flips `isReady` to false, simulating a dropped connection
   * (spec US4 AC2 — the executor must observe this to render "disconnected" and require
   * re-pairing rather than silently retrying). */
  scriptPrintFailure(error?: PrintTransportError, opts?: { disconnect?: boolean }): void;
  /** simulates an UNEXPECTED drop (e.g. `gattserverdisconnected`) — flips
   * `isReady` to false and invokes every `onDisconnect` subscriber, without going through
   * `printJob`/`disconnect`. */
  triggerDisconnect(): void;
}

const DEFAULT_PAIR_FAILURE = (): PrintTransportError =>
  new PrintTransportError("pairing_required", "scripted pairing failure");

/** The fake's paired identity; both UUIDs pass the server's `printerTransport` validator. */
export const FAKE_PRINTER_IDENTITY: PrinterTransportSettings = {
  deviceId: "fake-printer",
  name: "Fake printer",
  serviceUuid: "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  characteristicUuid: "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
};

const DEFAULT_RECONNECT_FAILURE = (): PrintTransportError =>
  new PrintTransportError("connect_failed", "scripted reconnect failure");

const DEFAULT_PRINT_FAILURE = (): PrintTransportError =>
  new PrintTransportError("write_failed", "scripted write failure");

/** Records bytes instead of transmitting them; scriptable one-shot failures for both `pair`
 * and `printJob`. Routes actual chunking through the SAME `writeChunks` helper production
 * uses (with a no-op sleep) — so a test asserting recorded chunk shape is exercising the real
 * chunk math, not a parallel reimplementation of it. */
export function createFakePrintTransport(): FakePrintTransport {
  let ready = false;
  let chunks: Uint8Array[] = [];
  let pairFailure: PrintTransportError | null = null;
  let reconnectFailure: PrintTransportError | null = null;
  let reconnectCount = 0;
  let printFailure: { error: PrintTransportError; disconnect: boolean } | null = null;
  const disconnectListeners = new Set<() => void>();

  return {
    async pair(preference) {
      if (pairFailure) {
        const err = pairFailure;
        pairFailure = null;
        throw err;
      }
      ready = true;
      return {
        ...FAKE_PRINTER_IDENTITY,
        serviceUuid: preference?.serviceUuid || FAKE_PRINTER_IDENTITY.serviceUuid,
        characteristicUuid:
          preference?.characteristicUuid || FAKE_PRINTER_IDENTITY.characteristicUuid,
      };
    },
    async reconnect(remembered) {
      reconnectCount += 1;
      if (reconnectFailure) {
        const err = reconnectFailure;
        reconnectFailure = null;
        throw err;
      }
      ready = true;
      return { ...remembered };
    },
    isReady() {
      return ready;
    },
    async printJob(bytes) {
      if (printFailure) {
        const { error, disconnect } = printFailure;
        printFailure = null;
        if (disconnect) ready = false;
        throw error;
      }
      await writeChunks(
        bytes,
        async (chunk) => {
          chunks.push(chunk);
        },
        { sleep: async () => {} }
      );
    },
    disconnect() {
      ready = false;
    },
    onDisconnect(callback) {
      disconnectListeners.add(callback);
      return () => disconnectListeners.delete(callback);
    },
    triggerDisconnect() {
      ready = false;
      for (const listener of disconnectListeners) listener();
    },
    recordedChunks() {
      return chunks;
    },
    reset() {
      chunks = [];
      ready = false;
      pairFailure = null;
      reconnectFailure = null;
      reconnectCount = 0;
      printFailure = null;
    },
    scriptReconnectFailure(error = DEFAULT_RECONNECT_FAILURE()) {
      reconnectFailure = error;
    },
    reconnectCalls() {
      return reconnectCount;
    },
    scriptPairFailure(error = DEFAULT_PAIR_FAILURE()) {
      pairFailure = error;
    },
    scriptPrintFailure(error = DEFAULT_PRINT_FAILURE(), opts = {}) {
      printFailure = { error, disconnect: opts.disconnect ?? false };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Web Bluetooth transport — thin glue over navigator.bluetooth */
/* ------------------------------------------------------------------ */

/** v1's candidate service UUIDs (cited module doc) — tried in order until one exposes a
 * writable characteristic. Kept as a flat list; a remembered or stored service is moved to the
 * front by `orderCandidateServices`.
 * Typed as the ambient `BluetoothServiceUUID`'s own definition (`number | string`, see
 * `@types/web-bluetooth`) rather than that type name itself — it's a pure type alias with no
 * runtime global counterpart, which trips `no-undef` (the `globals` package's browser list
 * knows the Bluetooth *interface* names below but not this alias). */
export const BLUETOOTH_PRINTER_CANDIDATE_SERVICES: (number | string)[] = [
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  0x18f0,
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];

/** v1's `requestDevice` FILTER service (`BluetoothStrategy.ts`'s * `BLUETOOTH_PRINTER_FILTER_SERVICE` — the first of the three candidates above). Review fix
 * within one Web Bluetooth filter object, `services: [a, b, c]` is ANDed — a device
 * would need to advertise ALL THREE to match, which no real printer does. v1 filters on this
 * ONE primary service and passes the full 3-element list only as `optionalServices` (which is
 * ORed/permissive) — restored exactly that shape below. Exported so the regression test can
 * assert on it directly instead of re-hardcoding the literal UUID. */
export const BLUETOOTH_PRINTER_FILTER_SERVICE: number | string =
  BLUETOOTH_PRINTER_CANDIDATE_SERVICES[0];

/** The candidate services in try order: a stored preference (lower-cased) first, then the v1
 * candidates without it. With no preference this is the candidate list itself, so the
 * `requestDevice` call stays exactly v1's shape. */
export function orderCandidateServices(preferred?: string): (number | string)[] {
  if (!preferred) return BLUETOOTH_PRINTER_CANDIDATE_SERVICES;
  const normalized = preferred.toLowerCase();
  return [
    normalized,
    ...BLUETOOTH_PRINTER_CANDIDATE_SERVICES.filter((service) => service !== normalized),
  ];
}

function ensureBluetoothAvailable(): void {
  if (globalThis.isSecureContext === false) {
    throw new PrintTransportError(
      "secure_context_required",
      "Web Bluetooth requires a secure context (HTTPS or localhost)."
    );
  }
  if (typeof navigator === "undefined" || !navigator.bluetooth) {
    throw new PrintTransportError("unsupported", "Web Bluetooth is not available in this browser.");
  }
}

/** Production factory — ported v1 shape (module doc above), ~thin: every real decision
 * (chunking, delay, retry) delegates to the pure helpers above. Untested directly (jsdom has
 * no Web Bluetooth); proven live at the close-time smoke and via the fake in e2e. */
export function createBluetoothPrintTransport(): PrintTransport {
  let device: BluetoothDevice | null = null;
  let characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  const disconnectListeners = new Set<() => void>();

  // the device's OWN `gattserverdisconnected` event fires on ANY
  // disconnection — both an unexpected drop AND our own explicit `gatt.disconnect` calls.
  // `notifyUnexpectedDisconnect` is only ever wired to the event itself (never called
  // directly) — every SELF-initiated teardown below detaches the listener FIRST
  // (`detachDeviceListener`), so calling our own `disconnect` never spuriously notifies.
  function notifyUnexpectedDisconnect(): void {
    characteristic = null;
    for (const listener of disconnectListeners) listener();
  }

  function detachDeviceListener(): void {
    device?.removeEventListener("gattserverdisconnected", notifyUnexpectedDisconnect);
  }

  async function connectGattWithRetry(): Promise<BluetoothRemoteGATTServer> {
    return retryWithDelay(async () => {
      const server = await device?.gatt?.connect();
      if (!server) throw new PrintTransportError("connect_failed", "No GATT server.");
      return server;
    });
  }

  /** Attach `target`, connect its GATT server and select a writable characteristic, trying
   * `services` in order. Leaves no half-open connection behind when nothing is writable. */
  async function attachAndDiscover(
    target: BluetoothDevice,
    services: (number | string)[],
    preferredCharacteristic: string | undefined,
    connect: () => Promise<BluetoothRemoteGATTServer>
  ): Promise<PrinterTransportSettings> {
    detachDeviceListener();
    device = target;
    characteristic = null;
    target.addEventListener("gattserverdisconnected", notifyUnexpectedDisconnect);
    const server = await connect();

    for (const serviceId of services) {
      let service: BluetoothRemoteGATTService;
      try {
        service = await server.getPrimaryService(serviceId);
      } catch {
        continue;
      }
      let characteristics: BluetoothRemoteGATTCharacteristic[];
      try {
        characteristics = await service.getCharacteristics();
      } catch {
        continue;
      }
      const writableCharacteristics = characteristics.filter(
        (c) => c.properties.write || c.properties.writeWithoutResponse
      );
      const writable =
        writableCharacteristics.find((c) => c.uuid === preferredCharacteristic) ??
        writableCharacteristics[0];
      if (writable) {
        characteristic = writable;
        return {
          deviceId: target.id,
          name: target.name ?? "",
          serviceUuid: service.uuid,
          characteristicUuid: writable.uuid,
        };
      }
    }

    //: a GATT connection was established above but no candidate service
    // exposed a writable characteristic — disconnect it before throwing, or a re-click of
    // the pair affordance opens a SECOND chooser on top of this still-open (but useless)
    // GATT connection, leaking it. Detach the listener FIRST — this is a
    // self-initiated teardown, not the unexpected drop `onDisconnect` exists for.
    detachDeviceListener();
    device?.gatt?.disconnect();
    device = null;
    throw new PrintTransportError(
      "characteristic_not_found",
      "No writable characteristic found in candidate Bluetooth printer services."
    );
  }

  /** The remembered device without a gesture: the in-memory one (still valid after a drop),
   * else the browser's granted-device list. `null` means a new gesture is required. */
  async function findGrantedDevice(deviceId: string): Promise<BluetoothDevice | null> {
    if (device?.id === deviceId) return device;
    if (typeof navigator.bluetooth.getDevices !== "function") return null;
    let granted: BluetoothDevice[];
    try {
      granted = await navigator.bluetooth.getDevices();
    } catch {
      return null;
    }
    return granted.find((candidate) => candidate.id === deviceId) ?? null;
  }

  return {
    async pair(preference) {
      ensureBluetoothAvailable();
      const services = orderCandidateServices(preference?.serviceUuid);
      const paired = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLUETOOTH_PRINTER_FILTER_SERVICE] }],
        optionalServices: services,
      });
      return attachAndDiscover(
        paired,
        services,
        preference?.characteristicUuid?.toLowerCase(),
        connectGattWithRetry
      );
    },
    async reconnect(remembered) {
      ensureBluetoothAvailable();
      const target = remembered.deviceId ? await findGrantedDevice(remembered.deviceId) : null;
      if (!target) {
        throw new PrintTransportError(
          "pairing_required",
          "The remembered printer cannot be reached without pairing again."
        );
      }
      try {
        return await attachAndDiscover(
          target,
          orderCandidateServices(remembered.serviceUuid),
          remembered.characteristicUuid.toLowerCase(),
          async () => {
            const server = await withTimeout(
              target.gatt?.connect() ?? Promise.resolve(undefined),
              RECONNECT_TIMEOUT_MS,
              () => new PrintTransportError("connect_failed", "Printer reconnect timed out.")
            );
            if (!server) throw new PrintTransportError("connect_failed", "No GATT server.");
            return server;
          }
        );
      } catch (err) {
        // Keep the device reference for the next attempt, but never a half-open connection or
        // a listener that would report our own teardown as an unexpected drop.
        detachDeviceListener();
        target.gatt?.disconnect();
        device = target;
        characteristic = null;
        if (err instanceof PrintTransportError) throw err;
        throw new PrintTransportError("connect_failed", String(err));
      }
    },
    isReady() {
      return characteristic !== null && (device?.gatt?.connected ?? false);
    },
    async printJob(bytes) {
      const c = characteristic;
      if (!c) throw new PrintTransportError("write_failed", "Not connected.");
      const useNoResponse = c.properties.writeWithoutResponse;
      try {
        await writeChunks(bytes, async (chunk) => {
          if (useNoResponse) await c.writeValueWithoutResponse(chunk);
          else await c.writeValue(chunk);
        });
      } catch (err) {
        if (err instanceof PrintTransportError) throw err;
        throw new PrintTransportError("write_failed", String(err));
      }
    },
    disconnect() {
      detachDeviceListener(); // self-initiated — never notify onDisconnect subscribers
      device?.gatt?.disconnect();
      device = null;
      characteristic = null;
    },
    onDisconnect(callback) {
      disconnectListeners.add(callback);
      return () => disconnectListeners.delete(callback);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Factory + test/e2e seam (D6) */
/* ------------------------------------------------------------------ */

// Computed ONCE at module scope from Vite build-time constants — same pattern as
// `time-announcements/seams.ts`'s `HOOKS_ENABLED` (cited there in full).
const HOOKS_ENABLED = Boolean(import.meta.env.DEV) || import.meta.env.VITE_E2E_HOOKS === "true";

let transportOverride: PrintTransport | null = null;
let hooksFakeInstance: FakePrintTransport | null = null;

// TS declaration merging (same pattern as `window.__mpAnnouncements` in seams.ts).
declare global {
  interface Window {
    __mpPrintTransport?: FakePrintTransport;
  }
}

/** Test-only override — unconditional, no env flag needed. Client unit/component tests call
 * this directly with a fake/mock `PrintTransport`; pass `null` to clear it. */
export function __setPrintTransportForTests(transport: PrintTransport | null): void {
  transportOverride = transport;
}

/** Resolve the `PrintTransport` the executor should use. Precedence: an explicit test override
 * (`__setPrintTransportForTests`) always wins; otherwise a DEV/`VITE_E2E_HOOKS` build returns a
 * shared fake exposed at `window.__mpPrintTransport` for e2e scripting; a production
 * build with neither returns the real Bluetooth transport.
 */
export function createPrintTransport(): PrintTransport {
  if (transportOverride) return transportOverride;
  if (HOOKS_ENABLED) {
    if (!hooksFakeInstance) {
      hooksFakeInstance = createFakePrintTransport();
      if (typeof window !== "undefined") {
        window.__mpPrintTransport = hooksFakeInstance;
      }
    }
    return hooksFakeInstance;
  }
  return createBluetoothPrintTransport();
}
