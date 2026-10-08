import type { PluginId } from "./plugins.js";
import type { PrintFailureErrorCode } from "./printing.js";

export interface CoreEventCatalog {
  "daily_briefing.generated": {
    memberId: string;
    date: string;
    status: "pending" | "ready" | "partial" | "failed" | "render-failed";
  };
  "routines.completion_changed": {
    memberId: string;
    choreId: string;
    routineId: string;
    date: string;
    completed: boolean;
    timestamp: number;
  };
  /** network.device_blocked / network.device_unblocked (
   *) — privacy-safe breadcrumbs ONLY: `deviceId` + `timestamp`,
   * no MAC (NETWORK-DEVICES-INV-07), no alias (PII-adjacent — the redaction
   * pipeline matches MAC/IP patterns, not names, so keeping the alias out of
   * the payload is the only real defense). Payload shape is closed —
   * additional properties are a deliberate breach of this event's contract.
   */
  "network.device_blocked": {
    deviceId: string;
    timestamp: number;
  };
  "network.device_unblocked": {
    deviceId: string;
    timestamp: number;
  };
  /** printing.completed / printing.failed —
   * the `printing` contract's own canonical event pair (FR-008/FR-009): and
   * daily-briefing already subscribe to these exact names — do NOT invent others. Payload shape
   * is closed: `outputRef` is the producer's artifact reference (never raster bytes, ADR-041);
   * `printing.completed` fires post-commit on a successful ack; `printing.failed` fires ONLY for
   * a PERMANENT failure (dead-letter) — a RECOVERABLE failure (attempts+1, back to pending)
   * never emits this event.
   */
  "printing.completed": {
    jobId: string;
    outputRef: string;
    printedAt: number;
  };
  "printing.failed": {
    jobId: string;
    outputRef: string;
    errorCode: PrintFailureErrorCode;
  };
}

/** Published namespace aliases have one owner; manifests cannot assign their own prefix. */
export const EVENT_NAMESPACE_OWNERS = Object.freeze({
  daily_briefing: "daily-briefing",
  printing: "printing",
  network: "network-devices",
  routines: "core",
} as const satisfies Record<
  {
    [K in keyof CoreEventCatalog]: K extends `${infer Namespace}.${string}` ? Namespace : never;
  }[keyof CoreEventCatalog],
  PluginId | "core"
>);
