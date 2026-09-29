import { describe, it, expect } from "vitest";
import { emit } from "../../src/server/host-api/index.js";
import { createEventBus, subscribe } from "../../src/server/lib/event-bus.js";
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

/** docs/features/network-devices.md — network.device_blocked /
 * network.device_unblocked typed events (NETWORK-DEVICES-INV-07).
 * Payload MUST stay `{ deviceId, timestamp }` ONLY — no MAC, no alias. Both
 * are PII-adjacent breadcrumbs the telemetry redactor cannot catch (it
 * matches MAC/IP *patterns*, not names), so the closed shape is the only
 * real defense.
 */
describe("network-devices events — T001 (RED-first)", () => {
  // -----------------------------------------------------------------
  // Type-level: the payload shape is closed at compile time (tsc -b via
  // npm run typecheck — NOT a runtime assertion). If a directive below stops
  // suppressing a real error, typecheck fails loudly with "Unused directive"
  // (event-bus.test.ts precedent) — the type safety regressed.
  // -----------------------------------------------------------------
  it("type-level: emit()/subscribe() reject a payload carrying more than {deviceId, timestamp}", () => {
    // @ts-expect-error — network.device_blocked payload must not carry `mac`
    emit("network.device_blocked", { deviceId: "d1", timestamp: 1, mac: "aa:bb:cc:dd:ee:ff" });

    // @ts-expect-error — network.device_blocked payload must not carry `alias`
    emit("network.device_blocked", { deviceId: "d1", timestamp: 1, alias: "Marta's iPad" });

    // @ts-expect-error — network.device_unblocked payload must not carry `mac`
    emit("network.device_unblocked", { deviceId: "d1", timestamp: 1, mac: "aa:bb:cc:dd:ee:ff" });

    // @ts-expect-error — network.device_unblocked payload must not carry `alias`
    emit("network.device_unblocked", { deviceId: "d1", timestamp: 1, alias: "Marta's iPad" });

    // A handler requiring an extra `mac` field is not assignable to a
    // Handler<{deviceId, timestamp}> (event-bus.test.ts precedent). Bound to a
    // named, single-line statement so the @ts-expect-error directive stays
    // adjacent to the erroring call (a multi-line arrow moves the reported
    // error off the directive's line).
    const wrongHandler: (p: {
      deviceId: string;
      timestamp: number;
      mac: string;
    }) => void = () => {};
    // @ts-expect-error — wrongHandler requires `mac`; the real payload never carries it
    subscribe("network.device_blocked", wrongHandler);
  });

  // -----------------------------------------------------------------
  // Runtime: payload shape closed — exactly {deviceId, timestamp}, no MAC,
  // no alias, delivered through the REAL host-API emit (barrel), not the
  // event-bus module directly.
  // -----------------------------------------------------------------
  for (const eventName of ["network.device_blocked", "network.device_unblocked"] as const) {
    it(`runtime: ${eventName} delivers a payload closed to exactly {deviceId, timestamp} via the host-api emit`, async () => {
      const bus = createEventBus();
      let received: CoreEventCatalog[typeof eventName] | undefined;
      bus.subscribe(eventName, (payload) => {
        received = payload;
      });

      bus.emit(eventName, { deviceId: "device-123", timestamp: 1_700_000_000_000 });
      await flushMicrotasks();

      expect(received).toBeDefined();
      expect(received).toEqual({ deviceId: "device-123", timestamp: 1_700_000_000_000 });
      // Closed shape: exactly two keys, nothing PII-adjacent slipped in.
      expect(Object.keys(received!).sort()).toEqual(["deviceId", "timestamp"]);
      expect(received).not.toHaveProperty("mac");
      expect(received).not.toHaveProperty("alias");
    });
  }

  // -----------------------------------------------------------------
  // Absent-subscriber graceful, through the REAL host-api emit (the seam
  // block/unblock will call —, not this module).
  // -----------------------------------------------------------------
  for (const eventName of ["network.device_blocked", "network.device_unblocked"] as const) {
    it(`${eventName}: emitting via the host-api barrel with NO subscriber never throws (ADR-040)`, () => {
      expect(() => {
        emit(eventName, { deviceId: "device-456", timestamp: Date.now() });
      }).not.toThrow();
    });
  }
});
