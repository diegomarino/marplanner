import { describe, it, expect } from "vitest";
import { emit } from "../../src/server/host-api/index.js";
import { createEventBus } from "../../src/server/lib/event-bus.js";
import type { CoreEventCatalog } from "../../src/shared/events.js";

// Helper: drain all pending microtasks (event-bus.test.ts precedent — emit
// dispatches via queueMicrotask, never synchronously).
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      queueMicrotask(() => resolve());
    });
  });
}

/** docs/features/printing.md — the CONTRACT's canonical event pair
 * (fold): `printing.completed {jobId, outputRef, printedAt}` and
 * `printing.failed {jobId, outputRef, errorCode}`. and daily-briefing subscribe to
 * these exact names — this test pins the closed payload shape so neither drifts.
 */
describe("printing events — T001 (RED-first)", () => {
  // -----------------------------------------------------------------
  // Type-level: the payload shape is closed at compile time (tsc -b via
  // npm run typecheck — NOT a runtime assertion). If a directive below stops
  // suppressing a real error, typecheck fails loudly with "Unused directive"
  // (event-bus.test.ts precedent) — the type safety regressed.
  // -----------------------------------------------------------------
  it("type-level: emit()/subscribe() reject a payload carrying more than the contract's closed shape", () => {
    // @ts-expect-error — printing.completed must not carry an extra field
    emit("printing.completed", { jobId: "j1", outputRef: "o1", printedAt: 1, extra: true });

    // @ts-expect-error — printing.completed's printedAt is required, not optional
    emit("printing.completed", { jobId: "j1", outputRef: "o1" });

    // @ts-expect-error — printing.failed must not carry an extra field
    emit("printing.failed", { jobId: "j", outputRef: "o", errorCode: "render_failure", extra: 1 });

    // @ts-expect-error — printing.failed's errorCode is the closed PERMANENT vocabulary only
    emit("printing.failed", { jobId: "j1", outputRef: "o1", errorCode: "not_a_real_code" });
  });

  // -----------------------------------------------------------------
  // Runtime: payload shape closed — exactly the contract's fields, delivered
  // through the REAL host-API emit (barrel), not the event-bus module directly.
  // -----------------------------------------------------------------
  it("runtime: printing.completed delivers a payload closed to exactly {jobId, outputRef, printedAt} via the host-api emit", async () => {
    const bus = createEventBus();
    let received: CoreEventCatalog["printing.completed"] | undefined;
    bus.subscribe("printing.completed", (payload) => {
      received = payload;
    });

    bus.emit("printing.completed", {
      jobId: "job-1",
      outputRef: "test-print",
      printedAt: 1_700_000_000_000,
    });
    await flushMicrotasks();

    expect(received).toBeDefined();
    expect(received).toEqual({
      jobId: "job-1",
      outputRef: "test-print",
      printedAt: 1_700_000_000_000,
    });
    expect(Object.keys(received!).sort()).toEqual(["jobId", "outputRef", "printedAt"]);
  });

  it("runtime: printing.failed delivers a payload closed to exactly {jobId, outputRef, errorCode} via the host-api emit", async () => {
    const bus = createEventBus();
    let received: CoreEventCatalog["printing.failed"] | undefined;
    bus.subscribe("printing.failed", (payload) => {
      received = payload;
    });

    bus.emit("printing.failed", {
      jobId: "job-2",
      outputRef: "test-print",
      errorCode: "render_failure",
    });
    await flushMicrotasks();

    expect(received).toBeDefined();
    expect(received).toEqual({
      jobId: "job-2",
      outputRef: "test-print",
      errorCode: "render_failure",
    });
    expect(Object.keys(received!).sort()).toEqual(["errorCode", "jobId", "outputRef"]);
  });

  // -----------------------------------------------------------------
  // Absent-subscriber graceful, through the REAL host-api emit (the core
  // module wires this at ack/fail time — /, not this module).
  // -----------------------------------------------------------------
  it("printing.completed: emitting via the host-api barrel with NO subscriber never throws (ADR-040)", () => {
    expect(() => {
      emit("printing.completed", {
        jobId: "job-3",
        outputRef: "test-print",
        printedAt: Date.now(),
      });
    }).not.toThrow();
  });

  it("printing.failed: emitting via the host-api barrel with NO subscriber never throws (ADR-040)", () => {
    expect(() => {
      emit("printing.failed", {
        jobId: "job-4",
        outputRef: "test-print",
        errorCode: "render_failure",
      });
    }).not.toThrow();
  });
});
