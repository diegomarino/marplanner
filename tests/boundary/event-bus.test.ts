import { describe, it, expect, beforeEach } from "vitest";
import { createEventBus } from "../../src/server/lib/event-bus.js";
import { emit, subscribe } from "../../src/server/lib/event-bus.js";
import type { CoreEventCatalog } from "../../src/shared/events.js";

// Helper: drain all pending microtasks
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      queueMicrotask(() => resolve());
    });
  });
}

describe("event bus — (RED-first unit tests)", () => {
  let bus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    bus = createEventBus();
  });

  // -----------------------------------------------------------------
  // Semantic 1: async / non-blocking dispatch
  // -----------------------------------------------------------------

  it("emit() returns BEFORE any handler has run (async dispatch via queueMicrotask)", async () => {
    let called = false;

    bus.subscribe("routines.completion_changed", () => {
      called = true;
    });

    // emit synchronously — handler must NOT have run yet (async dispatch)
    bus.emit("routines.completion_changed", {
      memberId: "m1",
      choreId: "c1",
      routineId: "r1",
      date: "2025-01-01",
      completed: true,
      timestamp: Date.now(),
    });

    // RED guarantee: synchronously after emit, handler has NOT fired
    expect(called).toBe(false);

    // Wait for the microtask to drain
    await flushMicrotasks();

    // After microtask drain, handler MUST have run
    expect(called).toBe(true);
  });

  // -----------------------------------------------------------------
  // Semantic 2: per-subscriber isolation (independent clones)
  // -----------------------------------------------------------------

  it("delivered payloads are frozen and independent per subscriber (mutation on one copy does not leak to another)", async () => {
    let copyA: CoreEventCatalog["routines.completion_changed"] | undefined;
    let copyB: CoreEventCatalog["routines.completion_changed"] | undefined;
    let frozenA = false;
    let frozenB = false;

    bus.subscribe("routines.completion_changed", (payload) => {
      if (copyA === undefined) {
        copyA = payload;
        frozenA = Object.isFrozen(payload);
      }
    });

    bus.subscribe("routines.completion_changed", (payload) => {
      if (copyB === undefined) {
        copyB = payload;
        frozenB = Object.isFrozen(payload);
      }
    });

    bus.emit("routines.completion_changed", {
      memberId: "m2",
      choreId: "c2",
      routineId: "r2",
      date: "2025-02-02",
      completed: false,
      timestamp: 1000,
    });

    // Wait for all microtasks (2 handlers = 2 microtasks)
    await flushMicrotasks();

    // Both copies must reflect original values
    expect(copyA).toBeDefined();
    expect(copyB).toBeDefined();
    expect(copyA!.memberId).toBe("m2");
    expect(copyB!.memberId).toBe("m2");

    // They must NOT be reference-equal (independent clones)
    expect(copyA).not.toBe(copyB);

    // Both delivered payloads must be frozen (ADR-040 immutable delivery)
    expect(frozenA).toBe(true);
    expect(frozenB).toBe(true);
  });

  // -----------------------------------------------------------------
  // Semantic 3: fault containment (throwing subscriber)
  // -----------------------------------------------------------------

  it("a rejecting async subscriber is contained (does not crash the bus or affect other subscribers)", async () => {
    let secondReceived: string | undefined;
    let firstHandlerCalled = false;

    // First handler is async and rejects — the.catch handler in emit
    // must contain this rejection (P1 fix from review).
    bus.subscribe("routines.completion_changed", async () => {
      firstHandlerCalled = true;
      throw new Error("async rejection");
    });

    // Second handler receives normally
    bus.subscribe("routines.completion_changed", (payload) => {
      secondReceived = payload.memberId;
    });

    // Emit — the rejecting async subscriber must NOT prevent the second from receiving
    bus.emit("routines.completion_changed", {
      memberId: "m6",
      choreId: "c6",
      routineId: "r6",
      date: "2025-06-06",
      completed: true,
      timestamp: 6000,
    });

    // Wait for microtasks (2 handlers = 2 microtasks)
    await flushMicrotasks();

    // Second subscriber MUST still receive its payload
    expect(secondReceived).toBe("m6");
    expect(firstHandlerCalled).toBe(true);
  });

  it("a rejecting async subscriber never produces an unhandled promise rejection", async () => {
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const testBus = createEventBus();
      testBus.subscribe("routines.completion_changed", async () => {
        throw new Error("async rejection");
      });
      testBus.emit("routines.completion_changed", {
        memberId: "m",
        choreId: "c",
        routineId: "r",
        date: "2025-01-01",
        completed: true,
        timestamp: 1,
      });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandledCount).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // -----------------------------------------------------------------
  // Semantic 4: zero subscribers is not an error
  // -----------------------------------------------------------------

  it("emitting an event with no registered subscribers does not throw", () => {
    const freshBus = createEventBus();

    // No handlers registered — emit must not throw
    expect(() =>
      freshBus.emit("routines.completion_changed", {
        memberId: "m4",
        choreId: "c4",
        routineId: "r4",
        date: "2025-04-04",
        completed: false,
        timestamp: 4000,
      })
    ).not.toThrow();
  });

  // -----------------------------------------------------------------
  // Semantic 5: compile-time type safety (ADR-050)
  // -----------------------------------------------------------------
  //
  // `emit` and `subscribe` are typed against CoreEventCatalog.
  // An undeclared (magic-string) event name fails `tsc`, asserted via
  // `// @ts-expect-error` — NOT a runtime assertion.
  //
  // The following lines are deliberately wrong — if tsc stops failing,
  // the test file itself is broken (type safety regressed).

  // @ts-expect-error — "magic.event.name" is not a key of CoreEventCatalog
  emit("magic.event.name", { foo: "bar" });

  // @ts-expect-error — wrong payload shape for "routines.completion_changed"
  subscribe("routines.completion_changed", (p: { wrong: string }) => {});

  // -----------------------------------------------------------------
  // Runtime smoke: top-level emit/subscribe work with correct types
  // -----------------------------------------------------------------

  it("top-level emit/subscribe work with correct CoreEventCatalog types", async () => {
    let received: string | undefined;

    subscribe("routines.completion_changed", (payload) => {
      received = payload.memberId;
    });

    emit("routines.completion_changed", {
      memberId: "m5",
      choreId: "c5",
      routineId: "r5",
      date: "2025-05-05",
      completed: true,
      timestamp: 5000,
    });

    await flushMicrotasks();

    expect(received).toBe("m5");
  });
});
