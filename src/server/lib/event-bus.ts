import type { CoreEventCatalog } from "../../shared/events.js";

// Subscribers may return values or promises; dispatch contains failures and ignores results.
type Handler<P> = (payload: P) => unknown;

/** Typed in-process event bus — fire-and-forget async dispatch.
 * Per ADR-040: the emitter never blocks on, waits for, or is affected by
 * subscribers. Each handler gets its own independent
 * `Object.freeze(structuredClone(payload))` copy.
 */
export function createEventBus() {
  const handlers = new Map<keyof CoreEventCatalog, Set<Handler<any>>>();

  function subscribe<K extends keyof CoreEventCatalog>(
    name: K,
    handler: Handler<CoreEventCatalog[K]>
  ): void {
    const registry = handlers.get(name);
    if (registry) {
      registry.add(handler);
    } else {
      handlers.set(name, new Set([handler]));
    }
  }

  function emit<K extends keyof CoreEventCatalog>(name: K, payload: CoreEventCatalog[K]): void {
    const registry = handlers.get(name);
    if (!registry || registry.size === 0) return;

    for (const handler of registry) {
      queueMicrotask(() => {
        const copy = Object.freeze(structuredClone(payload));
        try {
          const raw = handler(copy);
          // A subscriber may be async and return a rejected promise.
          // The synchronous try/catch above won't catch a rejection —
          // attach a handler to contain it (ADR-040 fault containment).
          const r = raw as unknown;
          if (r && typeof (r as { catch: Function }).catch === "function") {
            (r as { catch: (onReject: () => void) => unknown }).catch(() => {
              /* contained: a rejecting async subscriber never propagates */
            });
          }
        } catch {
          // Fault containment: a throwing subscriber never propagates
          // to the emitter or other subscribers (ADR-040).
        }
      });
    }
  }

  return { emit, subscribe };
}

/** Singleton event bus instance, exported for cross-module use.
 * Tests can also call `createEventBus` directly to get a fresh instance
 * with no accumulated subscriptions (required for RED-first isolation).
 */
export const eventBus = createEventBus();

/** Typed emit — constrained to declared CoreEventCatalog keys.
 * An undeclared (magic-string) event name fails at compile time (ADR-050).
 */
export function emit<K extends keyof CoreEventCatalog>(
  name: K,
  payload: CoreEventCatalog[K]
): void {
  eventBus.emit(name, payload);
}

/** Typed subscribe — constrained to declared CoreEventCatalog keys.
 */
export function subscribe<K extends keyof CoreEventCatalog>(
  name: K,
  handler: Handler<CoreEventCatalog[K]>
): void {
  eventBus.subscribe(name, handler);
}
