import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { useT } from "@/i18n";
import {
  DEFAULT_POLL_INTERVAL_MS,
  PrintExecutor,
  usePrinterSession,
} from "@/printing/PrintExecutor";
import { createFakePrintTransport } from "@/printing/transport";
import type { AckRequest, ClaimResponse, PrintJob } from "../../src/shared";

/** (US4, FR-019/FR-020/FR-021). Every scenario injects its own
 * `FakePrintTransport` via `PrintExecutor`'s `transport` prop (`@/printing/transport`'s * seam) — no real Web Bluetooth, no module-level fake singleton shared across tests. Fake
 * timers stay armed throughout (the poll interval must never fire on real wall-clock time —
 * the class); state settles by flushing the microtask queue (`flushMicrotasks`, the
 * `time-announcements-service.test.tsx` precedent), not by `waitFor`'s own internal
 * (real-timer-based) polling, which deadlocks under fake timers.
 * FR-013's own hiding gate (`./pluginStatus`'s `usePrintingPluginActive`) is mocked ACTIVE here —
 * this file is entirely about the pair/claim/payload/ack/fail state machine, not the hiding
 * behavior itself (see `printing-executor-fr013.test.tsx` for that), and the real hook's own
 * `GET /api/printing/status` fetch would otherwise consume the FIRST slot of every test's
 * carefully call-ordered `mockResolvedValueOnce` queue below.
 */

let currentLanguage = "en";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: currentLanguage,
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
  }),
}));

vi.mock("@/printing/pluginStatus", () => ({
  usePrintingPluginActive: () => true,
}));

function renderExecutor(props: Parameters<typeof PrintExecutor>[0] = {}) {
  return render(
    <LanguageProvider>
      <PrintExecutor {...props}>
        <ExecutorSessionProbe />
      </PrintExecutor>
    </LanguageProvider>
  );
}

/** Test-only session observation seam. Production execution is intentionally DOM-free. */
function ExecutorSessionProbe() {
  const session = usePrinterSession();
  const t = useT();
  if (!session) return null;
  return (
    <>
      <output
        data-testid="print-executor-state"
        data-state={session.displayState}
        role="status"
        aria-live="polite"
      >
        {t(session.stateLabelKey)}
      </output>
      {session.canPair && (
        <button type="button" data-testid="print-executor-pair-button" onClick={session.pair}>
          {t(
            session.displayState === "disconnected"
              ? "printing.executor.repairButton"
              : "printing.executor.pairButton"
          )}
        </button>
      )}
      {session.displayState === "error" && (
        <output data-testid="print-executor-last-error" role="alert" aria-live="polite">
          Last error:
        </output>
      )}
    </>
  );
}

/** Flushes the microtask queue several times over — enough for a `fetch ->.then ->
 * fetch ->.then`-deep chain (pair -> capability -> claim -> payload -> transport ->
 * ack/fail) to fully settle before an assertion. Fake timers never fake the microtask
 * queue, so this needs no real timer advancement. */
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "job-1",
    recordKey: "test-printable",
    outputRef: "ref-1",
    targetDate: "2026-09-07",
    memberId: null,
    state: "claimed",
    derivedState: "claimed",
    attempts: 0,
    failureReason: null,
    claimedAt: 1000,
    printedAt: null,
    createdAt: 900,
    updatedAt: 1000,
    ...overrides,
  };
}

function claimResponse(overrides: Partial<ClaimResponse> = {}): Response {
  const body: ClaimResponse = {
    job: makeJob(),
    leaseToken: "lease-abc",
    leaseExpiresAt: 60_000,
    ...overrides,
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function payloadResponse(bytes: number[] = [1, 2, 3]): Response {
  return new Response(new Uint8Array(bytes).buffer, { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("PrintExecutor", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    currentLanguage = "en";
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is intrinsically headless when mounted directly", () => {
    const { container } = render(
      <LanguageProvider>
        <PrintExecutor />
      </LanguageProvider>
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the unpaired state + pairing affordance, and makes NO fetch calls at rest", () => {
    renderExecutor();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Not paired");
    expect(screen.getByTestId("print-executor-pair-button")).toHaveTextContent("Pair printer");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders the unpaired state in Spanish", () => {
    currentLanguage = "es";
    renderExecutor();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Sin emparejar");
    expect(screen.getByTestId("print-executor-pair-button")).toHaveTextContent(
      "Emparejar impresora"
    );
  });

  it("poll PAUSES entirely while unpaired: no claim call ever fires without pairing", async () => {
    renderExecutor({ pollIntervalMs: 50 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("registers capability BEFORE the first claim, then renders paired", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // every claim after: nothing to do

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");

    const calledUrls = mockFetch.mock.calls.map((call) => String(call[0]));
    const capabilityIndex = calledUrls.findIndex((u) => u.includes("/api/printing/capability"));
    const claimIndex = calledUrls.findIndex((u) => u.includes("/api/printing/claim"));

    expect(capabilityIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(capabilityIndex);
  });

  it("prints newly queued work immediately without a polling tick", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true }));
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    mockFetch.mockResolvedValueOnce(claimResponse());
    mockFetch.mockResolvedValueOnce(payloadResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "printed" })));
    await act(() => window.dispatchEvent(new Event("marplanner:print-intent-enqueued")));
    await flushMicrotasks();

    expect(transport.recordedChunks()).toHaveLength(1);
    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(transport.recordedChunks()).toHaveLength(1);
  });

  it("retains a queue wakeup received while a claim is in flight", async () => {
    const transport = createFakePrintTransport();
    let settleClaim!: (response: Response) => void;
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true }));
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settleClaim = resolve;
        })
    );
    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    mockFetch.mockResolvedValueOnce(claimResponse());
    mockFetch.mockResolvedValueOnce(payloadResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "printed" })));
    await act(() => window.dispatchEvent(new Event("marplanner:print-intent-enqueued")));
    settleClaim(new Response(null, { status: 204 }));
    await flushMicrotasks();

    expect(transport.recordedChunks()).toHaveLength(1);
  });

  it("re-registers capability when /claim answers 403 printer_capability_missing", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // initial capability (pair)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: "forbidden", code: "printer_capability_missing" }, 403)
    ); // first claim tick
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // re-registration
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // subsequent claims

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");
    const capabilityCalls = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes("/api/printing/capability")
    );
    expect(capabilityCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the printing state while a claimed job is mid-transmit", async () => {
    const transport = createFakePrintTransport();
    let releaseWrite: (() => void) | undefined;
    const originalPrintJob = transport.printJob.bind(transport);
    transport.printJob = vi.fn(
      (bytes: Uint8Array) =>
        new Promise<void>((resolve, reject) => {
          releaseWrite = () => {
            originalPrintJob(bytes).then(resolve, reject);
          };
        })
    );

    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse()); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Printing…");

    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "printed" }))); // ack
    releaseWrite?.();
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");
  });

  it("scripted transport failure calls /fail with the lease token and NEVER calls /ack", async () => {
    const transport = createFakePrintTransport();
    transport.scriptPrintFailure();

    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse()); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "pending", attempts: 1 }))); // fail
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // any further claim ticks

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-last-error")).toBeInTheDocument();

    const failCall = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes("/api/printing/jobs/job-1/fail")
    );
    const ackCall = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes("/api/printing/jobs/job-1/ack")
    );

    expect(ackCall).toBeUndefined();
    expect(failCall).toBeDefined();
    const failInit = failCall![1] as { body: string };
    const failBody = JSON.parse(failInit.body) as { leaseToken: string; reason: string };
    expect(failBody.leaseToken).toBe("lease-abc");
    expect(typeof failBody.reason).toBe("string");
  });

  it("transitions to disconnected + shows the re-pair affordance when the transport reports a dropped connection", async () => {
    const transport = createFakePrintTransport();
    transport.scriptPrintFailure(undefined, { disconnect: true });

    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse()); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "pending", attempts: 1 }))); // fail

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Disconnected");
    expect(screen.getByTestId("print-executor-pair-button")).toHaveTextContent("Re-pair printer");

    // Poll must have paused again (disconnected is not "paired") — no further claim calls even
    // after several would-be poll intervals' worth of elapsed time.
    const claimCallsBefore = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/printing/claim")
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const claimCallsAfter = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/printing/claim")
    ).length;
    expect(claimCallsAfter).toBe(claimCallsBefore);
  });

  it("stays unpaired and surfaces the error when pair() itself fails", async () => {
    const transport = createFakePrintTransport();
    transport.scriptPairFailure();

    renderExecutor({ transport });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Not paired");
    expect(mockFetch).not.toHaveBeenCalled(); // never reaches capability registration
  });

  // (b): cheap constant-value fence — a mutation changing this default (e.g.
  // to a wall-clock-heavy value) would silently pass every other test, which all inject their
  // own `pollIntervalMs`.
  it("DEFAULT_POLL_INTERVAL_MS is 15 seconds", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(15_000);
  });

  it("the payload request URL carries the claim's leaseToken (lease-token fencing, P1-3a)", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse({ leaseToken: "lease-xyz-123" })); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "printed" }))); // ack

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    const payloadCall = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes("/api/printing/jobs/job-1/payload")
    );
    expect(payloadCall).toBeDefined();
    expect(String(payloadCall![0])).toContain(`leaseToken=${encodeURIComponent("lease-xyz-123")}`);
  });

  it("the ack body's leaseToken matches the claim's token, and rotates across a re-claim (P1-3b)", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(
      claimResponse({ leaseToken: "lease-first", job: makeJob({ id: "job-a" }) })
    ); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ id: "job-a", state: "printed" }))); // ack

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    const firstAckCall = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes("/api/printing/jobs/job-a/ack")
    );
    expect(firstAckCall).toBeDefined();
    const firstAckBody = JSON.parse((firstAckCall![1] as { body: string }).body) as AckRequest;
    expect(firstAckBody.leaseToken).toBe("lease-first");

    // A SECOND claim (the poll interval elapsing) rotates the lease token for a DIFFERENT job.
    mockFetch.mockResolvedValueOnce(
      claimResponse({ leaseToken: "lease-second", job: makeJob({ id: "job-b" }) })
    ); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ id: "job-b", state: "printed" }))); // ack

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await flushMicrotasks();

    const secondAckCall = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes("/api/printing/jobs/job-b/ack")
    );
    expect(secondAckCall).toBeDefined();
    const secondAckBody = JSON.parse((secondAckCall![1] as { body: string }).body) as AckRequest;
    expect(secondAckBody.leaseToken).toBe("lease-second");
    expect(secondAckBody.leaseToken).not.toBe(firstAckBody.leaseToken);
  });

  it("a network-level ack failure after a SUCCESSFUL transmit does NOT call /fail (SC-002, P1-2)", async () => {
    const transport = createFakePrintTransport(); // no scripted failure — printJob succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse()); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockRejectedValueOnce(new Error("network blip")); // ack — a REJECTED fetch, not just a non-ok status

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    // The bytes WERE transmitted — the transport never failed.
    expect(transport.recordedChunks().length).toBeGreaterThan(0);

    const failCall = mockFetch.mock.calls.find((call) => String(call[0]).includes("/fail"));
    expect(failCall).toBeUndefined();

    // The local error notice IS surfaced, but the state stays the SAME "error" designation
    // already used for transient issues — never "disconnected" (the transport itself is fine)
    // and no /fail call means the server-side job is never falsely reset to pending (which
    // would have reprinted the same paper on the next poll tick — SC-002).
    expect(screen.getByTestId("print-executor-last-error")).toBeInTheDocument();
    expect(screen.getByTestId("print-executor-state")).toHaveAttribute("data-state", "error");
  });

  it("overlapping-tick guard: a printJob spanning two poll intervals fires only ONE /claim (P2-7c)", async () => {
    const transport = createFakePrintTransport();
    let releaseWrite: (() => void) | undefined;
    const originalPrintJob = transport.printJob.bind(transport);
    transport.printJob = vi.fn(
      (bytes: Uint8Array) =>
        new Promise<void>((resolve, reject) => {
          releaseWrite = () => {
            originalPrintJob(bytes).then(resolve, reject);
          };
        })
    );

    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse()); // claim — only ONE queued
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload

    renderExecutor({ transport, pollIntervalMs: 1_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    // The job is still mid-transmit (busyRef held) — advance PAST two full poll intervals.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    const claimCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/printing/claim")
    );
    expect(claimCalls).toHaveLength(1); // busyRef guard: no overlapping tick issued a second /claim

    // Release the pending transmit + ack so nothing leaks into the next test.
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "printed" })));
    releaseWrite?.();
    await flushMicrotasks();
  });

  it("P2-3: disconnects the transport if capability registration fails right after a successful pair()", async () => {
    const transport = createFakePrintTransport();
    const disconnectSpy = vi.spyOn(transport, "disconnect");
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 })); // capability registration fails

    renderExecutor({ transport });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Not paired");
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------------------
  // — (pendingAck retry) + (onDisconnect / readiness gate)
  // ---------------------------------------------------------------------------------------

  it("FOLD-1(a): transmit ok + ack network failure → next tick issues /ack with the SAME token and NO /claim", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse({ leaseToken: "lease-retry-1" })); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockRejectedValueOnce(new Error("network blip")); // ack — fails

    renderExecutor({ transport, pollIntervalMs: 1_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    // Bytes WERE transmitted (pendingAck now retained internally).
    expect(transport.recordedChunks().length).toBeGreaterThan(0);

    const callsBeforeTick = mockFetch.mock.calls.length;
    mockFetch.mockRejectedValueOnce(new Error("network blip again")); // ack retry — fails again

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushMicrotasks();

    const callsInTick = mockFetch.mock.calls.slice(callsBeforeTick);
    const claimCallsInTick = callsInTick.filter((c) =>
      String(c[0]).includes("/api/printing/claim")
    );
    const ackCallsInTick = callsInTick.filter((c) => String(c[0]).includes("/ack"));

    expect(claimCallsInTick).toHaveLength(0); // NEVER claim while a pendingAck exists
    expect(ackCallsInTick).toHaveLength(1);
    const retryAckBody = JSON.parse((ackCallsInTick[0][1] as { body: string }).body) as AckRequest;
    expect(retryAckBody.leaseToken).toBe("lease-retry-1"); // the SAME retained token
  });

  it("FOLD-1(b): a retried ack that succeeds clears pendingAck/error, with no duplicate print and no /fail", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(claimResponse({ leaseToken: "lease-retry-2" })); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockRejectedValueOnce(new Error("network blip")); // ack — fails

    renderExecutor({ transport, pollIntervalMs: 1_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-last-error")).toBeInTheDocument();
    const chunksAfterTransmit = transport.recordedChunks().length;
    expect(chunksAfterTransmit).toBeGreaterThan(0);

    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ state: "printed" }))); // ack retry succeeds

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushMicrotasks();

    // No duplicate print — printJob was never called a second time.
    expect(transport.recordedChunks().length).toBe(chunksAfterTransmit);
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/fail"))).toBe(false);
    expect(screen.queryByTestId("print-executor-last-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("print-executor-state")).toHaveAttribute("data-state", "paired");
  });

  it("FOLD-1(c): an ack retry that gets 409 drops pendingAck, and the NEXT tick claims normally", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValueOnce(
      claimResponse({ leaseToken: "lease-retry-3", job: makeJob({ id: "job-c" }) })
    ); // claim
    mockFetch.mockResolvedValueOnce(payloadResponse()); // payload
    mockFetch.mockRejectedValueOnce(new Error("network blip")); // ack — fails

    renderExecutor({ transport, pollIntervalMs: 1_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    // Retry tick: 409 stale lease — some other claimer rotated the token first.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "stale_lease" }), { status: 409 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushMicrotasks();

    // pendingAck is now dropped — the NEXT tick must claim normally again.
    mockFetch.mockResolvedValueOnce(
      claimResponse({ leaseToken: "lease-fresh", job: makeJob({ id: "job-d" }) })
    );
    mockFetch.mockResolvedValueOnce(payloadResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse(makeJob({ id: "job-d", state: "printed" })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushMicrotasks();

    const secondAckCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/api/printing/jobs/job-d/ack")
    );
    expect(secondAckCall).toBeDefined(); // proves a FRESH claim/payload/ack cycle ran normally
  });

  it("FOLD-2(d): a scripted onDisconnect event transitions to disconnected without any write", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // any claim ticks: nothing to do

    renderExecutor({ transport, pollIntervalMs: 15_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");

    transport.triggerDisconnect();
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveAttribute(
      "data-state",
      "disconnected"
    );
    expect(transport.recordedChunks()).toHaveLength(0); // no write ever attempted
  });

  it("FOLD-2(e): transport not-ready at a poll tick fires zero /claim and transitions to disconnected", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // in case anything DOES fire

    renderExecutor({ transport, pollIntervalMs: 1_000 });
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");

    // Belt-and-braces path: drop readiness WITHOUT going through onDisconnect (disconnect
    // never notifies subscribers — see the fake's own doc comment) — this is the fallback
    // `pollTick` itself must still catch.
    transport.disconnect();

    const claimCallsBefore = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/printing/claim")
    ).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const claimCallsAfter = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/printing/claim")
    ).length;
    expect(claimCallsAfter).toBe(claimCallsBefore); // no NEW /claim fired
    expect(screen.getByTestId("print-executor-state")).toHaveAttribute(
      "data-state",
      "disconnected"
    );
  });
});
