import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientLogEntryInput } from "../../src/shared";

/** Shared client logger jsdom tests ( CLIENT-LOGGING-TELEMETRY-INV-02/-INV-03).
 * The logger is a page-lifetime singleton (module-level buffer + a `setInterval` started at
 * import time), so every test re-imports it fresh via `vi.resetModules` to avoid state bleed
 * across tests, and fake timers keep the periodic flush from firing on a real clock during the
 * test run.
 */
describe("client logger (T006)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function freshLogger() {
    vi.resetModules();
    return import("../../src/client/lib/logger");
  }

  it("CLIENT-LOGGING-TELEMETRY-INV-03: an entry carries the canonical envelope shape", async () => {
    const { log, __flushNowForTests, __setTransportForTests } = await freshLogger();
    const sent: ClientLogEntryInput[][] = [];
    __setTransportForTests((entries) => {
      sent.push(entries);
    });

    log("warn", "test.component", "something happened", { foo: "bar" });
    await __flushNowForTests();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    const entry = sent[0][0];
    expect(entry.level).toBe("warn");
    expect(entry.component).toBe("test.component");
    expect(entry.message).toBe("something happened");
    expect(entry.data).toEqual({ foo: "bar" });
    expect(typeof entry.eventTime).toBe("number");
    expect(Object.keys(entry).sort()).toEqual([
      "component",
      "data",
      "eventTime",
      "level",
      "message",
    ]);
  });

  it("omits `data` entirely when the caller didn't pass one", async () => {
    const { log, __flushNowForTests, __setTransportForTests } = await freshLogger();
    const sent: ClientLogEntryInput[][] = [];
    __setTransportForTests((entries) => {
      sent.push(entries);
    });

    log("info", "test.component", "no data here");
    await __flushNowForTests();

    expect(sent[0][0]).not.toHaveProperty("data");
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-02: at-most-once — a failed (rejecting) send is dropped, never re-queued", async () => {
    const { log, __flushNowForTests, __setTransportForTests, __peekBufferForTests } =
      await freshLogger();
    let callCount = 0;
    __setTransportForTests(() => {
      callCount += 1;
      return Promise.reject(new Error("network down"));
    });

    log("error", "test.component", "will fail to send");
    await __flushNowForTests();
    expect(callCount).toBe(1);
    // the failed entry is gone — buffer was spliced BEFORE the send attempt — not re-queued
    expect(__peekBufferForTests()).toHaveLength(0);

    // a second flush with nothing buffered must not re-invoke the transport
    await __flushNowForTests();
    expect(callCount).toBe(1);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-02: a synchronously-throwing transport is also swallowed, never re-queued", async () => {
    const { log, __flushNowForTests, __setTransportForTests, __peekBufferForTests } =
      await freshLogger();
    __setTransportForTests(() => {
      throw new Error("boom");
    });

    log("error", "test.component", "throws synchronously");
    await expect(__flushNowForTests()).resolves.toBeUndefined();
    expect(__peekBufferForTests()).toHaveLength(0);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-01: log() never throws into its caller, even when the console mirror or buffer machinery misbehaves", async () => {
    const { log, __setTransportForTests } = await freshLogger();
    __setTransportForTests(() => {
      throw new Error("should never be reached synchronously from log()");
    });
    vi.stubEnv("DEV", true);
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console itself is broken");
    });

    expect(() => log("error", "test.component", "message", { any: "thing" })).not.toThrow();
  });

  it("auto-flushes once the buffer reaches the 50-entry cap, without waiting for the 10s interval", async () => {
    const { log, __setTransportForTests } = await freshLogger();
    const sent: ClientLogEntryInput[][] = [];
    __setTransportForTests((entries) => {
      sent.push(entries);
    });

    for (let i = 0; i < 50; i++) {
      log("debug", "test.component", `entry ${i}`);
    }
    // the cap-triggered flush is fired via `void performFlush` — let its microtask settle.
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toHaveLength(50);
  });

  it("does not auto-flush below the 50-entry cap", async () => {
    const { log, __setTransportForTests } = await freshLogger();
    const sent: ClientLogEntryInput[][] = [];
    __setTransportForTests((entries) => {
      sent.push(entries);
    });

    for (let i = 0; i < 49; i++) {
      log("debug", "test.component", `entry ${i}`);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(0);
  });

  it("DEV console mirror: mirrors to console.* when import.meta.env.DEV is on", async () => {
    vi.stubEnv("DEV", true);
    const { log, __setTransportForTests } = await freshLogger();
    __setTransportForTests(() => undefined);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    log("warn", "test.component", "mirrored message", { x: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("mirrored message");
  });

  it("DEV console mirror gating: stays silent when import.meta.env.DEV is off", async () => {
    vi.stubEnv("DEV", false);
    const { log, __setTransportForTests } = await freshLogger();
    __setTransportForTests(() => undefined);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    log("warn", "test.component", "must not be mirrored");

    expect(spy).not.toHaveBeenCalled();
  });

  describe("P2-2/623 review: envelope strings are clamped before buffering", () => {
    it("component is clamped to 64 chars (mirrors the server's MAX_COMPONENT_LEN)", async () => {
      const { log, __flushNowForTests, __setTransportForTests } = await freshLogger();
      const sent: ClientLogEntryInput[][] = [];
      __setTransportForTests((entries) => {
        sent.push(entries);
      });

      const longComponent = "c".repeat(200);
      log("info", longComponent, "hello");
      await __flushNowForTests();

      expect(sent[0][0].component).toBe("c".repeat(64));
    });

    it("message is clamped to 256 chars (mirrors the server's MAX_MESSAGE_LEN)", async () => {
      const { log, __flushNowForTests, __setTransportForTests } = await freshLogger();
      const sent: ClientLogEntryInput[][] = [];
      __setTransportForTests((entries) => {
        sent.push(entries);
      });

      const longMessage = "m".repeat(500);
      log("info", "test.component", longMessage);
      await __flushNowForTests();

      expect(sent[0][0].message).toBe("m".repeat(256));
    });

    it('an empty-after-trim message becomes "unknown error" rather than being dropped by the server', async () => {
      const { log, __flushNowForTests, __setTransportForTests } = await freshLogger();
      const sent: ClientLogEntryInput[][] = [];
      __setTransportForTests((entries) => {
        sent.push(entries);
      });

      log("error", "test.component", "   ");
      await __flushNowForTests();

      expect(sent[0][0].message).toBe("unknown error");
    });

    it("a normal-length message/component pass through unchanged", async () => {
      const { log, __flushNowForTests, __setTransportForTests } = await freshLogger();
      const sent: ClientLogEntryInput[][] = [];
      __setTransportForTests((entries) => {
        sent.push(entries);
      });

      log("info", "test.component", "a perfectly normal message");
      await __flushNowForTests();

      expect(sent[0][0].component).toBe("test.component");
      expect(sent[0][0].message).toBe("a perfectly normal message");
    });
  });

  describe("CLIENT-LOGGING-TELEMETRY-INV-01/-INV-02: unload flush never throws (P2-1/623 review)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("a cyclic `data` fails JSON.stringify on the unload path — the batch is dropped, no throw, no send attempt", async () => {
      const { log, __peekBufferForTests, __flushForUnloadNowForTests } = await freshLogger();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      log("error", "test.component", "cyclic data", cyclic);
      expect(__peekBufferForTests()).toHaveLength(1);

      expect(() => __flushForUnloadNowForTests()).not.toThrow();

      // splice-before-send applies even when serialization itself fails — at-most-once (INV-02).
      expect(__peekBufferForTests()).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a normal buffer still flushes via the unload path (sanity check around the P2-1 fix)", async () => {
      const { log, __peekBufferForTests, __flushForUnloadNowForTests } = await freshLogger();
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchSpy);

      log("info", "test.component", "normal entry");
      __flushForUnloadNowForTests();

      expect(__peekBufferForTests()).toHaveLength(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("P3-1/623 review: the periodic-flush transport does NOT set fetch keepalive (a full 50-entry batch can exceed the ~64KB keepalive body cap)", async () => {
    const { log, __flushNowForTests } = await freshLogger();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    log("info", "test.component", "entry");
    await __flushNowForTests();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const options = fetchSpy.mock.calls[0][1] as { keepalive?: boolean };
    expect(options.keepalive).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
