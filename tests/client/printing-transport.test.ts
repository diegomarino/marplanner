import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLUETOOTH_PRINTER_CANDIDATE_SERVICES,
  BLUETOOTH_PRINTER_FILTER_SERVICE,
  CHUNK_SIZE,
  GATT_CONNECT_RETRIES,
  chunkBytes,
  createBluetoothPrintTransport,
  createFakePrintTransport,
  createPrintTransport,
  PrintTransportError,
  retryWithDelay,
  writeChunks,
  __setPrintTransportForTests,
} from "@/printing/transport";

/** (FR-019/FR-020). jsdom has no Web Bluetooth — every assertion
 * here targets the PURE helpers (`chunkBytes`/`writeChunks`/`retryWithDelay`) and the fake/seam
 * surface; `createBluetoothPrintTransport`'s glue is exercised live only and via the
 * fake in e2e.
 */

describe("chunkBytes (v1 parity: 100-byte chunks)", () => {
  it("splits evenly-divisible input into equal-size chunks", () => {
    const bytes = new Uint8Array(300);
    const chunks = chunkBytes(bytes);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length === CHUNK_SIZE)).toBe(true);
  });

  it("gives the last chunk a partial size when the input doesn't divide evenly", () => {
    const bytes = new Uint8Array(250);
    const chunks = chunkBytes(bytes);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });

  it("yields zero chunks for empty input", () => {
    expect(chunkBytes(new Uint8Array(0))).toHaveLength(0);
  });

  it("preserves byte content and order across chunks", () => {
    const bytes = Uint8Array.from({ length: 220 }, (_, i) => i % 256);
    const chunks = chunkBytes(bytes, 100);
    const rejoined = new Uint8Array(bytes.length);
    let offset = 0;
    for (const chunk of chunks) {
      rejoined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(rejoined).toEqual(bytes);
  });

  it("honors a custom chunkSize", () => {
    expect(chunkBytes(new Uint8Array(10), 4)).toHaveLength(3);
  });
});

describe("writeChunks (v1 parity: sleep after EVERY chunk, no false resolve on failure)", () => {
  it("writes every chunk in order and sleeps once per chunk", async () => {
    const bytes = new Uint8Array(250);
    const written: Uint8Array[] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);

    await writeChunks(bytes, async (chunk) => void written.push(chunk), { sleep });

    expect(written).toHaveLength(3);
    expect(written[2]).toHaveLength(50);
    // v1 parity: the delay fires after EVERY chunk, including the last.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("skips sleeping when delayMs is 0", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await writeChunks(new Uint8Array(150), async () => {}, { delayMs: 0, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("propagates a write failure and never resolves (no false ack path)", async () => {
    const bytes = new Uint8Array(300); // 3 chunks
    const written: Uint8Array[] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const boom = new Error("gatt write failed");

    const write = vi.fn(async (chunk: Uint8Array) => {
      written.push(chunk);
      if (written.length === 2) throw boom;
    });

    await expect(writeChunks(bytes, write, { sleep })).rejects.toBe(boom);

    // Only the first two chunks were attempted (the failing one included); the third never
    // ran, and no sleep happened after the failing write.
    expect(written).toHaveLength(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // only after the FIRST, successful chunk
  });
});

describe("retryWithDelay (v1 parity: GATT-connect retry/backoff)", () => {
  it("resolves with the first successful attempt's result", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`attempt ${calls} failed`);
      return "connected";
    });

    const result = await retryWithDelay(attempt, { retries: 3, delayMs: 2_000, sleep });

    expect(result).toBe("connected");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // between attempts 1->2 and 2->3, never after success
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("rejects with the last error once retries are exhausted", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err1 = new Error("first");
    const err2 = new Error("second");
    const err3 = new Error("third");
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockRejectedValueOnce(err3);

    await expect(retryWithDelay(attempt, { retries: 3, delayMs: 10, sleep })).rejects.toBe(err3);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // no sleep after the FINAL failed attempt
  });

  it("never retries when retries is 1", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(retryWithDelay(attempt, { retries: 1 })).rejects.toThrow("nope");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  // (a): with NO options object at all (every default in play — GATT_CONNECT_RETRIES
  // retries, the real 2s backoff via the real setTimeout-based sleep), the v1-parity default of 3
  // attempts must hold. Fake timers stand in for the real 2s delays so this stays fast.
  it("with no options at all, retries exactly GATT_CONNECT_RETRIES (3) times using the real default backoff", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn().mockRejectedValue(new Error("always fails"));
      // Attach the rejection assertion BEFORE advancing timers — `retryWithDelay`'s promise can
      // settle mid-`runAllTimersAsync`, and a handler attached only afterward would leave it
      // unhandled in the interim (an "Unhandled Rejection" vitest flags even though the test
      // itself goes on to assert the rejection correctly).
      const assertion = expect(retryWithDelay(attempt)).rejects.toThrow("always fails");
      await vi.runAllTimersAsync();
      await assertion;
      expect(attempt).toHaveBeenCalledTimes(GATT_CONNECT_RETRIES);
      expect(GATT_CONNECT_RETRIES).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PrintTransportError", () => {
  it("carries its code and message", () => {
    const err = new PrintTransportError("write_failed", "boom");
    expect(err.code).toBe("write_failed");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("PrintTransportError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("createBluetoothPrintTransport pair() requestDevice filter shape (P1-1 regression)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // v1 (BluetoothStrategy.ts) filters requestDevice on ONE primary service and passes the full
  // 3-element candidate list only as `optionalServices`. Within a SINGLE Web Bluetooth filter
  // object, `services: [a, b, c]` is ANDed (a device must advertise ALL of them) — passing the
  // whole 3-element list as the filter (the regression this test locks in) would never match a
  // real printer, which only advertises one of the three.
  it("filters on BLUETOOTH_PRINTER_FILTER_SERVICE alone, with all three candidates as optionalServices", async () => {
    const requestDevice = vi.fn().mockRejectedValue(new Error("stub — no device needed"));
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      bluetooth: { requestDevice },
    });

    const transport = createBluetoothPrintTransport();
    await expect(transport.pair()).rejects.toThrow();

    expect(requestDevice).toHaveBeenCalledTimes(1);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [BLUETOOTH_PRINTER_FILTER_SERVICE] }],
      optionalServices: BLUETOOTH_PRINTER_CANDIDATE_SERVICES,
    });
    // The filter is a SINGLE-element array — never the full multi-service candidate list.
    const call = requestDevice.mock.calls[0][0] as { filters: Array<{ services: unknown[] }> };
    expect(call.filters[0].services).toHaveLength(1);
  });
});

describe("createFakePrintTransport (byte recorder + scriptable failures/disconnects)", () => {
  it("starts unready, becomes ready after pair(), and records printJob's chunked bytes", async () => {
    const fake = createFakePrintTransport();
    expect(fake.isReady()).toBe(false);

    await fake.pair();
    expect(fake.isReady()).toBe(true);

    const bytes = new Uint8Array(150);
    await fake.printJob(bytes);

    expect(fake.recordedChunks()).toHaveLength(2);
    expect(fake.recordedChunks()[0]).toHaveLength(100);
    expect(fake.recordedChunks()[1]).toHaveLength(50);
  });

  it("scriptPairFailure rejects the NEXT pair() call once, then pair() succeeds normally", async () => {
    const fake = createFakePrintTransport();
    const err = new PrintTransportError("unsupported", "no bluetooth here");
    fake.scriptPairFailure(err);

    await expect(fake.pair()).rejects.toBe(err);
    expect(fake.isReady()).toBe(false);

    await fake.pair();
    expect(fake.isReady()).toBe(true);
  });

  it("scriptPrintFailure rejects the NEXT printJob() call without recording bytes, honestly (no false ack)", async () => {
    const fake = createFakePrintTransport();
    await fake.pair();
    const err = new PrintTransportError("write_failed", "scripted drop");
    fake.scriptPrintFailure(err);

    await expect(fake.printJob(new Uint8Array(10))).rejects.toBe(err);
    expect(fake.recordedChunks()).toHaveLength(0);
    // Not a disconnect script — stays ready for the next attempt.
    expect(fake.isReady()).toBe(true);
  });

  it("scriptPrintFailure with disconnect:true also flips isReady() to false", async () => {
    const fake = createFakePrintTransport();
    await fake.pair();
    fake.scriptPrintFailure(undefined, { disconnect: true });

    await expect(fake.printJob(new Uint8Array(10))).rejects.toThrow();
    expect(fake.isReady()).toBe(false);
  });

  it("reset() clears recorded chunks, readiness, and pending scripts", async () => {
    const fake = createFakePrintTransport();
    await fake.pair();
    await fake.printJob(new Uint8Array(10));
    fake.scriptPrintFailure();

    fake.reset();

    expect(fake.isReady()).toBe(false);
    expect(fake.recordedChunks()).toHaveLength(0);
    // The scripted failure was cleared by reset, not just consumed.
    await fake.pair();
    await expect(fake.printJob(new Uint8Array(5))).resolves.toBeUndefined();
  });

  it("disconnect() flips isReady() to false", async () => {
    const fake = createFakePrintTransport();
    await fake.pair();
    fake.disconnect();
    expect(fake.isReady()).toBe(false);
  });
});

describe("__setPrintTransportForTests / createPrintTransport seam", () => {
  afterEach(() => {
    __setPrintTransportForTests(null);
  });

  it("createPrintTransport() returns the exact override instance once set", () => {
    const fake = createFakePrintTransport();
    __setPrintTransportForTests(fake);
    expect(createPrintTransport()).toBe(fake);
    expect(createPrintTransport()).toBe(fake); // stable across calls
  });

  it("createPrintTransport() returns a fully-shaped PrintTransport when no override is set", () => {
    __setPrintTransportForTests(null);
    const transport = createPrintTransport();
    expect(typeof transport.pair).toBe("function");
    expect(typeof transport.isReady).toBe("function");
    expect(typeof transport.printJob).toBe("function");
    expect(typeof transport.disconnect).toBe("function");
  });
});

describe("createPrintTransport HOOKS_ENABLED gating (window.__mpPrintTransport, DEV/e2e-gated)", () => {
  beforeEach(() => {
    delete window.__mpPrintTransport;
  });

  afterEach(() => {
    delete window.__mpPrintTransport;
  });

  it("exposes a fake at window.__mpPrintTransport when DEV is on and no override is set", async () => {
    vi.stubEnv("DEV", true);
    vi.resetModules(); // HOOKS_ENABLED is computed ONCE at module scope — force a fresh read
    const mod = await import("@/printing/transport");
    mod.__setPrintTransportForTests(null);

    const transport = mod.createPrintTransport();

    expect(window.__mpPrintTransport).toBeDefined();
    expect(transport).toBe(window.__mpPrintTransport);
  });

  it("stays gated off (no window hook) when DEV is off and VITE_E2E_HOOKS is unset", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_E2E_HOOKS", undefined as unknown as string);
    vi.resetModules();
    const mod = await import("@/printing/transport");
    mod.__setPrintTransportForTests(null);

    mod.createPrintTransport();

    expect(window.__mpPrintTransport).toBeUndefined();
  });
});
