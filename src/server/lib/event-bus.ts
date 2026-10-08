import { randomUUID } from "node:crypto";
import type { CoreEventCatalog } from "../../shared/events.js";
import { writeServerLog } from "../telemetry/index";
import { boundAndRedact, DEFAULT_LIMITS } from "../telemetry/redact";

type Handler<P> = (payload: P) => unknown;

function logSubscriberFailure(event: string, subscriber: string, error: unknown): void {
  const failureId = randomUUID();
  const entry = {
    level: "error" as const,
    component: "event-bus",
    message: "event-bus.subscriber-failed",
    data: { failureId, event, subscriber, error: "Error details unavailable" } as Record<
      string,
      unknown
    >,
  };
  try {
    entry.data.error =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            code: (error as Error & { code?: unknown }).code,
          }
        : String(error);
    // Reserve envelope budget so oversized error details cannot erase failure identity.
    entry.data.error = boundAndRedact(
      { message: "", component: "", data: entry.data.error },
      { ...DEFAULT_LIMITS, maxBytes: 4096, maxDepth: 5, maxKeys: 60 }
    ).data;
    if (writeServerLog(entry).accepted === 1) return;
  } catch {
    // Storage or error serialization must never escape subscriber fault containment.
  }
  try {
    console.error(JSON.stringify(boundAndRedact(entry)));
  } catch {
    console.error("event-bus.subscriber-failed", failureId);
  }
}

/** In-process, post-commit notifications; failures never propagate to emitters or peers. */
export function createEventBus() {
  const handlers = new Map<keyof CoreEventCatalog, Map<Handler<any>, string>>();

  function subscribe<K extends keyof CoreEventCatalog>(
    name: K,
    handler: Handler<CoreEventCatalog[K]>,
    subscriberId?: string
  ): void {
    let registry = handlers.get(name);
    if (!registry) {
      registry = new Map();
      handlers.set(name, registry);
    }
    registry.set(handler, subscriberId ?? registry.get(handler) ?? randomUUID());
  }

  function emit<K extends keyof CoreEventCatalog>(name: K, payload: CoreEventCatalog[K]): void {
    const registry = handlers.get(name);
    if (!registry) return;
    for (const [handler, subscriber] of registry) {
      queueMicrotask(() => {
        try {
          const copy = Object.freeze(structuredClone(payload));
          void Promise.resolve(handler(copy)).catch((error: unknown) => {
            logSubscriberFailure(name, subscriber, error);
          });
        } catch (error) {
          logSubscriberFailure(name, subscriber, error);
        }
      });
    }
  }

  return { emit, subscribe };
}

export const eventBus = createEventBus();

export function emit<K extends keyof CoreEventCatalog>(
  name: K,
  payload: CoreEventCatalog[K]
): void {
  eventBus.emit(name, payload);
}

export function subscribe<K extends keyof CoreEventCatalog>(
  name: K,
  handler: Handler<CoreEventCatalog[K]>,
  subscriberId?: string
): void {
  eventBus.subscribe(name, handler, subscriberId);
}
