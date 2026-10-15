/** Shared browser printer session, mounted across family and admin routes.
 * Pairing requires a user gesture and registers the device credential's printer
 * capability before work can be claimed. The executor resolves, transmits and
 * acknowledges jobs; transport failures enter retry or disconnected states.
 * After successful transmission, retry acknowledgement before claiming more work,
 * even if the printer disconnects. Never report a transmitted job as a print
 * failure merely because its acknowledgement request failed. A rotated lease
 * ends the retry; the queue's documented at-least-once semantics still apply.
 * Production polling is 15 seconds. Tests may inject a shorter interval.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/credential";
import type {
  AckRequest,
  ClaimResponse,
  FailRequest,
  PrintFailureErrorCode,
  PrinterTransportSettings,
} from "../../shared";
import {
  createPrintTransport,
  PrintTransportError,
  type PrinterEndpointPreference,
  type PrintTransport,
} from "./transport";
import { PRINT_INTENT_ENQUEUED_EVENT } from "./queueWakeup";
import { usePrintingPluginActive } from "./pluginStatus";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** e2e poll-cadence override (mirrors `./transport.ts`'s own `HOOKS_ENABLED` gate): a
 * DEV/`VITE_E2E_HOOKS` build MAY additionally set `VITE_E2E_PRINT_POLL_MS` to shorten the
 * 15 s production cadence, so Playwright can drive claim/degrade/recovery cycles without a real
 * wall-clock wait. Absent the env var (every other DEV/e2e build, and always in production —
 * `HOOKS_ENABLED` is false there), this resolves to the unchanged `DEFAULT_POLL_INTERVAL_MS`.
 * Computed once per mount via the `pollIntervalMs` default parameter below, exactly like an
 * explicit `pollIntervalMs` prop would be — never re-read on a later render.
 */
const HOOKS_ENABLED = Boolean(import.meta.env.DEV) || import.meta.env.VITE_E2E_HOOKS === "true";

function resolveDefaultPollIntervalMs(): number {
  if (HOOKS_ENABLED) {
    const raw = import.meta.env.VITE_E2E_PRINT_POLL_MS;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

type Connection = "unpaired" | "pairing" | "paired" | "disconnected";
type Activity = "idle" | "printing";
type DisplayState = "unpaired" | "pairing" | "paired" | "printing" | "disconnected" | "error";

export interface PrintExecutorProps {
  /** Injectable transport — test-only; production uses `createPrintTransport`. */
  transport?: PrintTransport;
  /** Injectable poll cadence — test-only; production uses `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  children?: ReactNode;
}

export interface PrinterSession {
  active: boolean;
  displayState: DisplayState;
  stateLabelKey:
    | "printing.executor.state.unpaired"
    | "printing.executor.state.pairing"
    | "printing.executor.state.paired"
    | "printing.executor.state.printing"
    | "printing.executor.state.disconnected"
    | "printing.executor.state.error";
  canPair: boolean;
  /** The identity resolved by the last successful pairing; kept across disconnects. */
  pairedDevice: PrinterTransportSettings | null;
  pair: (preference?: PrinterEndpointPreference) => void;
}

const PrinterSessionContext = createContext<PrinterSession | null>(null);

/** The canonical shared session is only available below the globally mounted executor. */
export function usePrinterSession(): PrinterSession | null {
  return useContext(PrinterSessionContext);
}

/** A job whose bytes were successfully transmitted but whose ack has not yet been confirmed
 * — retried on every poll tick, in place of claiming, until it resolves. */
interface PendingAck {
  jobId: string;
  leaseToken: string;
}

type AckOutcome =
  | { kind: "success" }
  | { kind: "dropped" } // 409 stale lease — some other claimer rotated the token first
  | { kind: "retry"; detail: string }; // network failure or any other non-2xx

/** Maps a transport failure to the contract's PERMANENT failure vocabulary (* "Failure taxonomy") — `undefined` means RECOVERABLE (attempts+1, immediately re-claimable),
 * which is every `PrintTransportError` code except these two intrinsically-unfixable ones. */
function transportPermanentCode(err: unknown): PrintFailureErrorCode | undefined {
  if (err instanceof PrintTransportError) {
    if (err.code === "secure_context_required") return "secure_context";
    if (err.code === "unsupported") return "unsupported_transport";
  }
  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function parseCode(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : undefined;
}

/** `POST /jobs/:id/ack` with a RETAINED lease token. 2xx -> `"success"`; 409 (the
 * lease was rotated by another claimer — the truthful ack is no longer possible) ->
 * `"dropped"`; any other non-2xx OR a network-level failure -> `"retry"` (the caller keeps
 * the token and tries again next tick). */
async function attemptAck(jobId: string, leaseToken: string): Promise<AckOutcome> {
  try {
    const ackBody: AckRequest = { leaseToken };
    const res = await authFetch(`/api/printing/jobs/${encodeURIComponent(jobId)}/ack`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ackBody),
    });
    if (res.ok) return { kind: "success" };
    if (res.status === 409) return { kind: "dropped" };
    return { kind: "retry", detail: `ack failed: ${res.status}` };
  } catch (err) {
    return { kind: "retry", detail: describeError(err) };
  }
}

export function PrintExecutor({
  transport: injectedTransport,
  pollIntervalMs = resolveDefaultPollIntervalMs(),
  children,
}: PrintExecutorProps = {}): React.JSX.Element | null {
  // FR-013: family-facing hiding. Called unconditionally, like every other hook
  // here — the `!pluginActive` early return below sits AFTER every hook in this component, so
  // hook call order never varies across renders.
  const pluginActive = usePrintingPluginActive();
  //: lazy ref init — `createPrintTransport` must run at most ONCE per
  // mounted instance, never on every render (a plain `useRef(injectedTransport ??
  // createPrintTransport)` evaluates that fallback expression — and discards it — on every
  // single render, including ones the factory has real side effects on, e.g. registering the
  // shared e2e-hooks singleton).
  //
  //: this runs even while the FR-013 `!pluginActive` gate below is about to
  // return `null` — the hook order requirement above means this line executes on every render
  // regardless. Harmless: `createPrintTransport` only constructs a transport object, it never
  // opens a Bluetooth connection on its own (that requires the explicit pair-button gesture,
  // which isn't rendered while hidden) — so a hidden instance holds an inert transport, nothing
  // more.
  const transportRef = useRef<PrintTransport | null>(null);
  if (transportRef.current === null) {
    transportRef.current = injectedTransport ?? createPrintTransport();
  }
  const transport = transportRef.current;

  const [connection, setConnection] = useState<Connection>("unpaired");
  const [activity, setActivity] = useState<Activity>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [pairedDevice, setPairedDevice] = useState<PrinterTransportSettings | null>(null);
  const busyRef = useRef(false); // guards overlapping poll ticks
  const wakePendingRef = useRef(false);
  const pendingAckRef = useRef<PendingAck | null>(null); //

  const applyAckOutcome = useCallback(
    (jobId: string, leaseToken: string, outcome: AckOutcome): void => {
      if (outcome.kind === "success") {
        pendingAckRef.current = null;
        setLastError(null);
      } else if (outcome.kind === "dropped") {
        // The truthful ack is no longer possible — surface nothing NEW beyond whatever error
        // notice already exists; the contract's own at-least-once guarantee now covers this.
        pendingAckRef.current = null;
      } else {
        pendingAckRef.current = { jobId, leaseToken };
        setLastError(outcome.detail);
      }
    },
    []
  );

  const registerCapability = useCallback(async (): Promise<void> => {
    const res = await authFetch("/api/printing/capability", {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) throw new Error(`capability registration failed: ${res.status}`);
  }, []);

  const handlePair = useCallback(
    (preference?: PrinterEndpointPreference) => {
      setConnection("pairing");
      setLastError(null);
      transport
        .pair(preference)
        // FR-021/ADR-035: capability registration happens HERE, before this promise chain ever
        // lets the poll effect see connection === "paired" (no first-claim race).
        .then(async (identity) => {
          await registerCapability();
          return identity;
        })
        .then((identity) => {
          setPairedDevice(identity);
          setConnection("paired");
        })
        .catch((err: unknown) => {
          //: registerCapability can reject AFTER pair already
          // succeeded (e.g. a network blip on the capability POST) — disconnect the
          // now-orphaned GATT connection before falling back to "unpaired", or re-clicking
          // the pair affordance opens a SECOND requestDevice chooser on top of a connection
          // nothing will ever use again. Safe to call unconditionally: disconnect on a
          // transport that never actually connected (pair itself failed) is a no-op.
          transport.disconnect();
          setConnection("unpaired");
          setLastError(describeError(err));
        });
    },
    [registerCapability, transport]
  );

  // an unexpected GATT drop (the transport's own `gattserverdisconnected` handling,
  // or the fake's scriptable `triggerDisconnect`) transitions straight to "disconnected" —
  // subscribed once for the life of this component; the SAME transport instance persists
  // across re-pairs (lazy ref above), so this never needs to re-subscribe per pairing.
  useEffect(() => {
    const unsubscribe = transport.onDisconnect(() => {
      setConnection("disconnected");
    });
    return unsubscribe;
  }, [transport]);

  const executeJob = useCallback(
    async (claim: ClaimResponse): Promise<void> => {
      const { job, leaseToken } = claim;
      setActivity("printing");
      try {
        let bytes: Uint8Array;
        try {
          const payloadRes = await authFetch(
            `/api/printing/jobs/${encodeURIComponent(job.id)}/payload?leaseToken=${encodeURIComponent(leaseToken)}`,
            { credentials: "include" }
          );
          if (!payloadRes.ok) {
            // 404 (unknown job) / 409 (stale lease) / 422 (render_failure, already
            // dead-lettered server-side) — the server already owns the resolution;
            // nothing to ack or fail.
            return;
          }
          bytes = new Uint8Array(await payloadRes.arrayBuffer());
        } catch {
          return; // network-level payload fetch failure — lease expires server-side, retried later
        }

        // : the transmit call and the FOLLOWING ack are two DIFFERENT
        // failure domains and must never share one catch block. A transport failure here
        // means the bytes were NEVER printed — /fail (recoverable, no permanentCode unless
        // intrinsically unfixable) is the correct, honest report (FR-020). Once printJob
        // resolves, the paper is ALREADY OUT — a failed ack past this point must NEVER fall
        // through to /fail (see the module doc note above for the full retry story).
        try {
          await transport.printJob(bytes);
        } catch (err) {
          const failBody: FailRequest = {
            leaseToken,
            reason: describeError(err),
            permanentCode: transportPermanentCode(err) ?? null,
          };
          await authFetch(`/api/printing/jobs/${encodeURIComponent(job.id)}/fail`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(failBody),
          }).catch(() => undefined);

          setLastError(describeError(err));
          // AC2: retries are already exhausted INSIDE the transport by the time it
          // throws — isReady tells us whether the connection itself survived
          // (transient write hiccup, stays "paired") or was actually lost (needs the
          // explicit re-pair gesture).
          if (!transport.isReady()) {
            setConnection("disconnected");
          }
          return;
        }

        // Transmission SUCCEEDED — bytes are already on paper. a failed ack from
        // here is NEVER reported via /fail; the lease token is retained and retried on
        // every subsequent poll tick until it succeeds or is confirmed stale (409).
        const outcome = await attemptAck(job.id, leaseToken);
        applyAckOutcome(job.id, leaseToken, outcome);
      } finally {
        setActivity("idle");
      }
    },
    [applyAckOutcome, transport]
  );

  const pollTick = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      // a pending ack retry takes ABSOLUTE priority over claiming — never claim
      // while one exists. Pure server call (no printer write): runs regardless of transport
      // readiness or connection state (interaction note — never gate this on readiness).
      if (pendingAckRef.current) {
        const { jobId, leaseToken } = pendingAckRef.current;
        const outcome = await attemptAck(jobId, leaseToken);
        applyAckOutcome(jobId, leaseToken, outcome);
        return;
      }

      if (connection !== "paired") return; // disconnected, no pendingAck — nothing to do

      // belt-and-braces readiness gate — a GATT drop the onDisconnect
      // subscription somehow missed must still be caught here, before claiming a job
      // nothing can print.
      if (!transport.isReady()) {
        setConnection("disconnected");
        return;
      }

      const claimRes = await authFetch("/api/printing/claim", {
        method: "POST",
        credentials: "include",
      });
      if (claimRes.status === 204) return; // nothing claimable
      if (claimRes.status === 403) {
        const code = await parseCode(claimRes);
        if (code === "printer_capability_missing") {
          await registerCapability().catch(() => undefined);
        }
        return;
      }
      if (!claimRes.ok) return; // 409 plugin_inactive, or unexpected — stay idle, retry later
      const claim = (await claimRes.json()) as ClaimResponse;
      await executeJob(claim);
    } catch {
      // network-level claim failure — stay paired, next tick tries again
    } finally {
      busyRef.current = false;
      if (wakePendingRef.current) {
        wakePendingRef.current = false;
        window.dispatchEvent(new Event(PRINT_INTENT_ENQUEUED_EVENT));
      }
    }
  }, [applyAckOutcome, connection, executeJob, registerCapability, transport]);

  useEffect(() => {
    // Poll pauses only while genuinely unpaired/pairing (no session to speak of yet — no
    // pendingAck could exist either). Once ever paired, ticks keep firing even through
    // "disconnected" so a pendingAck retry keeps running; pollTick itself still
    // refuses to claim while disconnected/not-ready.
    if (connection === "unpaired" || connection === "pairing") return;
    const deliver = () => void pollTick();
    const wake = () => {
      if (busyRef.current) wakePendingRef.current = true;
      else deliver();
    };
    window.addEventListener(PRINT_INTENT_ENQUEUED_EVENT, wake);
    deliver();
    const interval = setInterval(deliver, pollIntervalMs);
    return () => {
      window.removeEventListener(PRINT_INTENT_ENQUEUED_EVENT, wake);
      clearInterval(interval);
    };
  }, [connection, pollIntervalMs, pollTick]);

  const displayState: DisplayState =
    connection === "unpaired"
      ? "unpaired"
      : connection === "pairing"
        ? "pairing"
        : connection === "disconnected"
          ? "disconnected"
          : activity === "printing"
            ? "printing"
            : lastError
              ? "error"
              : "paired";

  const stateLabelKey =
    displayState === "unpaired"
      ? ("printing.executor.state.unpaired" as const)
      : displayState === "pairing"
        ? ("printing.executor.state.pairing" as const)
        : displayState === "disconnected"
          ? ("printing.executor.state.disconnected" as const)
          : displayState === "printing"
            ? ("printing.executor.state.printing" as const)
            : displayState === "error"
              ? ("printing.executor.state.error" as const)
              : ("printing.executor.state.paired" as const);

  const showPairAffordance = connection === "unpaired" || connection === "disconnected";

  // Inactive or unresolved catalog state hides pairing and printer controls.
  // An already paired session retains its hooks; the server's lifecycle gate
  // rejects new claims while inactive. Pending acknowledgements remain fenced.
  if (!pluginActive) {
    return (
      <PrinterSessionContext.Provider
        value={{
          active: false,
          displayState,
          stateLabelKey,
          canPair: false,
          pairedDevice,
          pair: handlePair,
        }}
      >
        {children}
      </PrinterSessionContext.Provider>
    );
  }

  const session: PrinterSession = {
    active: pluginActive,
    displayState,
    stateLabelKey,
    canPair: showPairAffordance,
    pairedDevice,
    pair: handlePair,
  };

  return (
    <PrinterSessionContext.Provider value={session}>{children}</PrinterSessionContext.Provider>
  );
}
