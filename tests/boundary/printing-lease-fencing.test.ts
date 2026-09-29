import { afterEach, describe, it, expect } from "vitest";
import { getDb } from "../../src/server/db/client";
import {
  __setPrintingPluginActiveForTests,
  enqueueTestPrint,
  claimJob,
  getPayload,
  ackJob,
  PrintLeaseStaleError,
  PrintingPluginInactiveError,
} from "../../src/server/modules/printing/index";
import { useIsolatedDb } from "../helpers/db";
import { FakeClock } from "../helpers/fake-clock";

/** P2 on (follow-up) — lease-EXPIRY fencing, distinct from the
 * lease-TOKEN fencing already had. Before this `getPayload`/`ackJob` checked only
 * `lease_token` — a zombie executor resuming AFTER its lease expired but BEFORE anyone re-claims
 * (so its token is still, technically, the row's current token) could (a) fetch payload and
 * EXTEND the expired lease, monopolizing the job against the promised reclaimability, and
 * (b) ack with an expired lease. The fold's split:
 * - payload fetch now REQUIRES an ACTIVE lease (token match AND lease_expires_at >= now, fenced
 * in the UPDATE's own WHERE, not a pre-check) — an expired fetch 409s and does NOT extend.
 * - ack DELIBERATELY still accepts the latest token even if expired, while state='claimed'
 * under that token — a late truthful ack records a real transmission and avoids forcing an
 * avoidable duplicate print; the instant anyone re-claims, the token rotates and the old
 * token 409s (case (c) below).
 * Fixed anchor instant (the class) — every "now" in this file is derived from it, never a
 * wall-clock read.
 */
const ANCHOR_MS = Date.UTC(2026, 5, 15, 8, 0, 0); // 2026-06-15T08:00:00Z, arbitrary but fixed

describe("printing lease-expiry fencing (Codex P2 on #685)", () => {
  useIsolatedDb();

  afterEach(() => {
    __setPrintingPluginActiveForTests(undefined);
  });

  function enqueueAndClaim() {
    const trigger = enqueueTestPrint(ANCHOR_MS);
    expect(trigger.enqueued).toBe(true);
    const jobId = trigger.jobId as string;
    const claimed = claimJob(ANCHOR_MS);
    expect(claimed).not.toBeNull();
    expect(claimed!.job.id).toBe(jobId);
    return { jobId, leaseToken: claimed!.leaseToken, leaseExpiresAt: claimed!.leaseExpiresAt };
  }

  it("(a) an expired-lease payload fetch is rejected (409-mapped) and does NOT extend the lease", () => {
    const { jobId, leaseToken, leaseExpiresAt } = enqueueAndClaim();
    const afterExpiry = leaseExpiresAt + 1;

    expect(() => getPayload(jobId, leaseToken, afterExpiry)).toThrow(PrintLeaseStaleError);

    // The lease must be UNCHANGED — the rejected fetch performed no write at all.
    const row = getDb()
      .prepare("SELECT lease_expires_at, payload_served_at FROM print_jobs WHERE id = ?")
      .get(jobId) as { lease_expires_at: number; payload_served_at: number | null };
    expect(row.lease_expires_at).toBe(leaseExpiresAt);
    expect(row.payload_served_at).toBeNull();
  });

  it("blocks new claims while a valid lease drains and resolves only after its truthful ack", async () => {
    const clock = new FakeClock(ANCHOR_MS);
    const { jobId, leaseToken, leaseExpiresAt } = enqueueAndClaim();
    const printing = await import("../../src/server/modules/printing/index");
    expect(printing).toHaveProperty("drainPrintingClaims");
    const drainPrintingClaims = Reflect.get(printing, "drainPrintingClaims") as (
      deadline: { readonly expiresAt: string },
      deps: {
        readonly now: () => number;
        readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
        readonly clearTimeout: (handle: unknown) => void;
      }
    ) => Promise<"drained" | "expired">;

    __setPrintingPluginActiveForTests(false);
    const drain = drainPrintingClaims(
      { expiresAt: new Date(leaseExpiresAt).toISOString() },
      {
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      }
    );
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    await clock.flush();

    expect(() => claimJob(ANCHOR_MS + 1)).toThrow(PrintingPluginInactiveError);
    expect(settled).toBe(false);
    expect(ackJob(jobId, leaseToken, ANCHOR_MS + 2).state).toBe("printed");
    await expect(drain).resolves.toBe("drained");
  });

  it("an ACTIVE (non-expired) lease payload fetch still succeeds and refreshes the lease (control)", () => {
    const { jobId, leaseToken, leaseExpiresAt } = enqueueAndClaim();
    const stillActive = leaseExpiresAt - 1;

    const bytes = getPayload(jobId, leaseToken, stillActive);
    expect(bytes.length).toBeGreaterThan(0);

    const row = getDb()
      .prepare("SELECT lease_expires_at, payload_served_at FROM print_jobs WHERE id = ?")
      .get(jobId) as { lease_expires_at: number; payload_served_at: number | null };
    // Refreshed forward from the fetch instant, not left at the original claim-time value.
    expect(row.lease_expires_at).toBeGreaterThan(leaseExpiresAt);
    expect(row.payload_served_at).toBe(stillActive);
  });

  it("(b) an expired-lease ack with the latest token, while still claimed, succeeds exactly once", () => {
    const { jobId, leaseToken, leaseExpiresAt } = enqueueAndClaim();
    const afterExpiry = leaseExpiresAt + 1;

    const job = ackJob(jobId, leaseToken, afterExpiry);
    expect(job.state).toBe("printed");
    expect(job.printedAt).toBe(afterExpiry);

    // Idempotent re-ack under the SAME (still-expired) token — no error, no double-stamp.
    const reAck = ackJob(jobId, leaseToken, afterExpiry + 1000);
    expect(reAck.state).toBe("printed");
    expect(reAck.printedAt).toBe(afterExpiry); // unchanged — the FIRST ack's stamp wins
  });

  it("(c) once another session re-claims after expiry, the OLD token's ack is rejected (409-mapped)", () => {
    const { jobId, leaseToken: oldToken, leaseExpiresAt } = enqueueAndClaim();
    const afterExpiry = leaseExpiresAt + 1;

    // A second executor (or the same one, from the server's point of view — indistinguishable)
    // re-claims the now-reclaimable job; the token rotates.
    const reclaimed = claimJob(afterExpiry);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.job.id).toBe(jobId);
    expect(reclaimed!.leaseToken).not.toBe(oldToken);

    // The ORIGINAL (zombie) executor's ack, using its now-superseded token, must be rejected —
    // never a false success, never a double-stamp racing the new claim's own eventual ack.
    expect(() => ackJob(jobId, oldToken, afterExpiry + 500)).toThrow(PrintLeaseStaleError);

    // And the payload route rejects the old token too (belt-and-suspenders — same fence).
    expect(() => getPayload(jobId, oldToken, afterExpiry + 500)).toThrow(PrintLeaseStaleError);
  });
});
