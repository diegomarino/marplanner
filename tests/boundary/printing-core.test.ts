import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { subscribe } from "../../src/server/lib/event-bus";
import type { CoreEventCatalog } from "../../src/shared/events";
import { todayInHouseholdTz } from "../../src/server/host-api";
import {
  assertActiveMember,
  MemberReferenceError,
} from "../../src/server/modules/members/referential";
import {
  enqueuePrintJob,
  enqueueTestPrint,
  claimJob,
  getPayload,
  ackJob,
  failJob,
  listJobs,
  supersedePrintRecord,
  registerPrintableProvider,
  registerPrinterCapability,
  hasPrinterCapability,
  isPrintingPluginActive,
  __setPrintingPluginActiveForTests,
  PrintJobNotFoundError,
  PrintLeaseStaleError,
  PrintCapabilityMissingError,
  PrintingPluginInactiveError,
  PrintRenderFailureError,
  PrintValidationError,
  type PrintableRaster,
} from "../../src/server/modules/printing/index";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/printing.md + — the durable core's honesty (dedup matrix,
 * failure taxonomy, FR-021 capability, INV-06 plugin-active gating) and the producer seam
 * (supersede + fetch-at-execute provider resolution). Fixed anchor instant (the class) —
 * every "now" in this file derives from it, never a wall-clock read.
 */
const ANCHOR_MS = Date.UTC(2026, 5, 15, 8, 0, 0); // 2026-06-15T08:00:00Z, arbitrary but fixed

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      queueMicrotask(() => resolve());
    });
  });
}

/** getPayload now routes every provider raster through artifact.ts's buildPayload, which
 * enforces the connected device's fixed width (576). Test-fixture providers below that only care
 * about the RAW BYTE CONTENT (not real pixel semantics) use this helper to embed arbitrary text
 * at the front of a structurally valid, device-width packed raster — buildPayload only wraps the
 * bits (ESC/POS header/trailer, escpos.ts), it never rewrites them, so the embedded ASCII text
 * survives byte-for-byte into getPayload's returned buffer. */
const DEVICE_WIDTH = 576;
const DEVICE_BYTES_PER_ROW = DEVICE_WIDTH / 8;
function packAsDeviceRaster(text: string): PrintableRaster {
  const textBytes = new TextEncoder().encode(text);
  const height = Math.max(1, Math.ceil(textBytes.length / DEVICE_BYTES_PER_ROW));
  const bits = new Uint8Array(DEVICE_BYTES_PER_ROW * height);
  bits.set(textBytes, 0);
  return { bits, width: DEVICE_WIDTH, height };
}

function createMember(
  db: ReturnType<typeof getDb>,
  displayName: string,
  role: "parent" | "child",
  lifecycle: "active" | "archived"
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  db.prepare(
    "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, displayName, role, lifecycle, now, now);
  return id;
}

describe("printing core", () => {
  useIsolatedDb();
  afterEach(() => {
    // Module-level plugin-active flag is a process singleton (not DB state) — reset it so a
    // test that flips it inactive never leaks into the next test in this file.
    __setPrintingPluginActiveForTests(undefined);
  });

  // Computed AFTER useIsolatedDb's beforeEach has migrated a fresh DB — readHouseholdTimezone
  // (underneath todayInHouseholdTz) queries settings_objects, which doesn't exist yet at
  // describe-body collection time.
  let TARGET_DATE: string;
  beforeEach(() => {
    TARGET_DATE = todayInHouseholdTz(ANCHOR_MS);
  });

  // ── FR-012 dedup matrix + the disclosed INV-05 transient closure ──────

  describe("enqueuePrintJob — FR-012 dedup matrix", () => {
    it("fresh: no existing record -> a new job is created", () => {
      const result = enqueuePrintJob(
        { recordKey: "dedup-fresh", targetDate: TARGET_DATE, outputRef: "dedup-fresh" },
        ANCHOR_MS
      );
      expect(result.enqueued).toBe(true);
      expect(result.alreadyPrinted).toBe(false);
      expect(typeof result.jobId).toBe("string");
    });

    it("in-flight (INV-05 transient closed): a second enqueue against a still-pending job returns THAT job, never a duplicate", () => {
      const first = enqueuePrintJob(
        { recordKey: "dedup-inflight", targetDate: TARGET_DATE, outputRef: "dedup-inflight" },
        ANCHOR_MS
      );
      const second = enqueuePrintJob(
        { recordKey: "dedup-inflight", targetDate: TARGET_DATE, outputRef: "dedup-inflight" },
        ANCHOR_MS + 1
      );
      expect(second.enqueued).toBe(false);
      expect(second.alreadyPrinted).toBe(false);
      expect(second.jobId).toBe(first.jobId);

      const jobs = listJobs(ANCHOR_MS).jobs.filter((j) => j.recordKey === "dedup-inflight");
      expect(jobs).toHaveLength(1); // no duplicate row landed
    });

    it("in-flight also holds for a CLAIMED (not yet printed) job", () => {
      const first = enqueuePrintJob(
        { recordKey: "dedup-claimed", targetDate: TARGET_DATE, outputRef: "dedup-claimed" },
        ANCHOR_MS
      );
      claimJob(ANCHOR_MS);
      const second = enqueuePrintJob(
        { recordKey: "dedup-claimed", targetDate: TARGET_DATE, outputRef: "dedup-claimed" },
        ANCHOR_MS + 1
      );
      expect(second.enqueued).toBe(false);
      expect(second.jobId).toBe(first.jobId);
    });

    it("printed: a record already printed and NOT superseded is reported, no new job", () => {
      const enqueued = enqueuePrintJob(
        { recordKey: "dedup-printed", targetDate: TARGET_DATE, outputRef: "dedup-printed" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

      const retrigger = enqueuePrintJob(
        { recordKey: "dedup-printed", targetDate: TARGET_DATE, outputRef: "dedup-printed" },
        ANCHOR_MS + 2
      );
      expect(retrigger.enqueued).toBe(false);
      expect(retrigger.alreadyPrinted).toBe(true);
      expect(retrigger.jobId).toBe(enqueued.jobId);
    });

    it("superseded: a re-printable record accepts a NEW job on the next enqueue", () => {
      const original = enqueuePrintJob(
        { recordKey: "dedup-superseded", targetDate: TARGET_DATE, outputRef: "dedup-superseded" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);
      supersedePrintRecord("dedup-superseded", TARGET_DATE, ANCHOR_MS + 2);

      const regenerated = enqueuePrintJob(
        {
          recordKey: "dedup-superseded",
          targetDate: TARGET_DATE,
          outputRef: "dedup-superseded-v2",
        },
        ANCHOR_MS + 3
      );
      expect(regenerated.enqueued).toBe(true);
      expect(regenerated.jobId).not.toBe(original.jobId);
    });

    it("member strict-on-write: an active member is accepted", () => {
      const db = getDb();
      const memberId = createMember(db, "Active Parent", "parent", "active");
      expect(() =>
        enqueuePrintJob(
          { recordKey: "dedup-member-ok", targetDate: TARGET_DATE, outputRef: "x", memberId },
          ANCHOR_MS
        )
      ).not.toThrow();
    });

    it("member strict-on-write: an archived/non-existent member is rejected (MemberReferenceError)", () => {
      const db = getDb();
      const archivedId = createMember(db, "Archived Parent", "parent", "archived");
      expect(() =>
        enqueuePrintJob(
          {
            recordKey: "dedup-member-bad",
            targetDate: TARGET_DATE,
            outputRef: "x",
            memberId: archivedId,
          },
          ANCHOR_MS
        )
      ).toThrow(MemberReferenceError);
      expect(() => assertActiveMember("nonexistent-id")).toThrow(MemberReferenceError);
    });
  });

  // ── enqueuePrintJob — target_date calendar validity (Constitution IV) ──

  describe("enqueuePrintJob — target_date calendar validity (Constitution IV)", () => {
    it("rejects an impossible calendar date (Feb 30) with PrintValidationError, unmediated by HTTP", () => {
      expect(() =>
        enqueuePrintJob(
          { recordKey: "date-validity-impossible", targetDate: "2026-02-30", outputRef: "x" },
          ANCHOR_MS
        )
      ).toThrow(PrintValidationError);
    });

    it("rejects a malformed (non-YYYY-MM-DD-shaped) targetDate", () => {
      expect(() =>
        enqueuePrintJob(
          { recordKey: "date-validity-malformed", targetDate: "not-a-date", outputRef: "x" },
          ANCHOR_MS
        )
      ).toThrow(PrintValidationError);
    });

    it("rejects an invalid targetDate BEFORE any row is written (no half-created record/job)", () => {
      expect(() =>
        enqueuePrintJob(
          { recordKey: "date-validity-no-write", targetDate: "2026-13-01", outputRef: "x" },
          ANCHOR_MS
        )
      ).toThrow(PrintValidationError);
      const jobs = listJobs(ANCHOR_MS).jobs.filter((j) => j.recordKey === "date-validity-no-write");
      expect(jobs).toHaveLength(0);
    });

    it("accepts a strictly calendar-valid targetDate (control)", () => {
      expect(() =>
        enqueuePrintJob(
          { recordKey: "date-validity-ok", targetDate: TARGET_DATE, outputRef: "x" },
          ANCHOR_MS
        )
      ).not.toThrow();
    });
  });

  // ── failJob — the failure taxonomy ─────────────────────

  describe("failJob — RECOVERABLE vs PERMANENT (data-model.md Failure taxonomy)", () => {
    it("RECOVERABLE: attempts+1, lease released, back to pending, IMMEDIATELY re-claimable (printer-off->on recovery, no re-trigger)", () => {
      enqueuePrintJob(
        { recordKey: "fail-recoverable", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      const failed = failJob(
        claimed.job.id,
        claimed.leaseToken,
        ANCHOR_MS + 1,
        "no printer connected"
      );
      expect(failed.state).toBe("pending");
      expect(failed.attempts).toBe(1);
      expect(failed.derivedState).toBe("retrying"); // claimable + attempts>0

      // Immediately re-claimable WITHOUT any new trigger.
      const reclaimed = claimJob(ANCHOR_MS + 2);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.job.id).toBe(claimed.job.id);
      expect(reclaimed!.job.attempts).toBe(1);
    });

    it("PERMANENT: terminal failed, dead-letter, attempts untouched, printing.failed emitted", async () => {
      let received: CoreEventCatalog["printing.failed"] | undefined;
      subscribe("printing.failed", (payload) => {
        received = payload;
      });

      enqueuePrintJob(
        { recordKey: "fail-permanent", targetDate: TARGET_DATE, outputRef: "the-output" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      const failed = failJob(
        claimed.job.id,
        claimed.leaseToken,
        ANCHOR_MS + 1,
        "unsupported transport reported by executor",
        "unsupported_transport"
      );
      expect(failed.state).toBe("failed");
      expect(failed.attempts).toBe(0);
      expect(failed.derivedState).toBe("dead-letter");

      // A stale token can never fail it again (terminal).
      expect(() => failJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 2, "again")).toThrow(
        PrintLeaseStaleError
      );

      await flushMicrotasks();
      expect(received).toEqual({
        jobId: claimed.job.id,
        outputRef: "the-output",
        errorCode: "unsupported_transport",
      });
    });

    it("a stale/mismatched lease token is rejected — 409-mapped, no state change", () => {
      enqueuePrintJob(
        { recordKey: "fail-stale", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      claimJob(ANCHOR_MS);
      const jobId = listJobs(ANCHOR_MS).jobs.find((j) => j.recordKey === "fail-stale")!.id;

      expect(() => failJob(jobId, "not-the-real-token", ANCHOR_MS + 1, "reason")).toThrow(
        PrintLeaseStaleError
      );
      const stillClaimed = listJobs(ANCHOR_MS).jobs.find((j) => j.id === jobId)!;
      expect(stillClaimed.state).toBe("claimed");
    });

    it("failing an unknown job id 404s (PrintJobNotFoundError)", () => {
      expect(() => failJob("does-not-exist", "token", ANCHOR_MS, "reason")).toThrow(
        PrintJobNotFoundError
      );
    });
  });

  // ── FR-021 printer-capability gating ─────────────────────

  describe("FR-021 — claim requires a server-registered printer capability", () => {
    it("negative: claim is refused for a session with no registered capability", () => {
      enqueuePrintJob(
        { recordKey: "cap-negative", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      expect(() => claimJob(ANCHOR_MS, "session-without-capability")).toThrow(
        PrintCapabilityMissingError
      );
      // Nothing was claimed — the job is still pending.
      const job = listJobs(ANCHOR_MS).jobs.find((j) => j.recordKey === "cap-negative")!;
      expect(job.state).toBe("pending");
    });

    it("positive: claim succeeds once the session's key registers capability", () => {
      enqueuePrintJob(
        { recordKey: "cap-positive", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      expect(hasPrinterCapability("session-abc")).toBe(false);
      registerPrinterCapability("session-abc", ANCHOR_MS);
      expect(hasPrinterCapability("session-abc")).toBe(true);

      const claimed = claimJob(ANCHOR_MS + 1, "session-abc");
      expect(claimed).not.toBeNull();
    });

 it("omitting sessionKeyId skips the capability gate entirely (pre- interim call shape)", () => {
      enqueuePrintJob(
        { recordKey: "cap-omitted", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      expect(() => claimJob(ANCHOR_MS)).not.toThrow();
    });

    it("re-registering the same key is idempotent (upserts registered_at, never errors)", () => {
      expect(() => {
        registerPrinterCapability("session-repeat", ANCHOR_MS);
        registerPrinterCapability("session-repeat", ANCHOR_MS + 1000);
      }).not.toThrow();
      expect(hasPrinterCapability("session-repeat")).toBe(true);
    });
  });

  // ── CORE-level plugin-active gating (INV-06, analyze E1) ────────────────

  describe("CORE plugin-active gating (INV-06) binds enqueue AND claim for ANY caller", () => {
    it("defaults to active", () => {
      expect(isPrintingPluginActive()).toBe(true);
    });

    it("enqueuePrintJob refuses while inactive", () => {
      __setPrintingPluginActiveForTests(false);
      expect(() =>
        enqueuePrintJob(
          { recordKey: "gate-enqueue", targetDate: TARGET_DATE, outputRef: "x" },
          ANCHOR_MS
        )
      ).toThrow(PrintingPluginInactiveError);
    });

    it("enqueueTestPrint (the barrel-adjacent trigger) refuses while inactive too — the gate is in the CORE, not a route", () => {
      __setPrintingPluginActiveForTests(false);
      expect(() => enqueueTestPrint(ANCHOR_MS)).toThrow(PrintingPluginInactiveError);
    });

    it("claimJob refuses while inactive", () => {
      enqueuePrintJob(
        { recordKey: "gate-claim", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      __setPrintingPluginActiveForTests(false);
      expect(() => claimJob(ANCHOR_MS)).toThrow(PrintingPluginInactiveError);
    });

    it("AC-06 nuance: a lease claimed while ACTIVE still completes its ack flow after the plugin goes inactive", () => {
      // "test-print:" prefix resolves to the built-in provider (registerPrintableProvider is
      // only exercised where the test cares about it — this test is about plugin gating, not
      // the provider seam).
      enqueuePrintJob(
        { recordKey: "test-print:gate-ac06", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      __setPrintingPluginActiveForTests(false);

      // payload/ack are NOT gated — the in-flight lease finishes.
      expect(() => getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1)).not.toThrow();
      const acked = ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 2);
      expect(acked.state).toBe("printed");
    });

    it("AC-06 nuance: a lease claimed while ACTIVE also completes its fail flow after the plugin goes inactive", () => {
      enqueuePrintJob(
        { recordKey: "gate-ac06-fail", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      __setPrintingPluginActiveForTests(false);

      // failJob is NOT gated either — the in-flight lease's failure report is still honored.
      const failed = failJob(
        claimed.job.id,
        claimed.leaseToken,
        ANCHOR_MS + 1,
        "no printer connected while plugin went inactive mid-lease"
      );
      expect(failed.state).toBe("pending");
      expect(failed.attempts).toBe(1);
    });

    it("resets back to active by default (no leakage across calls)", () => {
      __setPrintingPluginActiveForTests(undefined);
      expect(isPrintingPluginActive()).toBe(true);
    });
  });

  // ── FR-010 by construction ──────────────────────────────────────────────

  it("FR-010 by construction: ackJob's signature admits no paper-state input anywhere — (jobId, leaseToken, now) is the entire surface", () => {
    expect(ackJob.length).toBe(3);
  });

  // ── Constitution V: derived states never write back ─────────────────────

  it("(Constitution V) listJobs's derived-state computation never writes to the database — write-spy", () => {
    // Seed a job whose target date is already in the past relative to a later `now`, so the
    // dead-letter derivation branch actually executes during this read.
    enqueuePrintJob(
      { recordKey: "writespy-job", targetDate: "2020-01-01", outputRef: "x" },
      ANCHOR_MS
    );

    const db = getDb();
    const prepareSpy = vi.spyOn(db, "prepare");
    const result = listJobs(ANCHOR_MS);
    const writeStatements = prepareSpy.mock.calls
      .map(([sql]) => sql as string)
      .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));

    expect(writeStatements).toEqual([]);
    const derived = result.jobs.find((j) => j.recordKey === "writespy-job")!;
    expect(derived.derivedState).toBe("dead-letter"); // the branch we intended to exercise actually ran
    expect(derived.state).toBe("pending"); // the STORED face is untouched — only the read derived it
  });

  // ── Review-mandated pins (RED-verified against the reviewer's exact mutants) ────

  describe("review-mandated pins", () => {
    it("(pin a) printing.completed emission on ack is observed via the REAL event-bus singleton subscribe (mutant: delete the emit -> red)", async () => {
      let received: CoreEventCatalog["printing.completed"] | undefined;
      subscribe("printing.completed", (payload) => {
        received = payload;
      });

      enqueuePrintJob(
        { recordKey: "pin-a-ack-emit", targetDate: TARGET_DATE, outputRef: "pin-a-output" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

      await flushMicrotasks();
      expect(received).toEqual({
        jobId: claimed.job.id,
        outputRef: "pin-a-output",
        printedAt: ANCHOR_MS + 1,
      });
    });

    it("(pin b) print_records.UNIQUE(record_key, target_date) rejects a duplicate insert at the DB layer (mutant: drop the UNIQUE -> red)", () => {
      const db = getDb();
      const now = ANCHOR_MS;
      db.prepare(
        "INSERT INTO print_records (id, record_key, target_date, superseded_at, printed_job_id, created_at, updated_at) VALUES (?,?,?,NULL,NULL,?,?)"
      ).run("pin-b-r1", "pin-b-dup", TARGET_DATE, now, now);

      expect(() =>
        db
          .prepare(
            "INSERT INTO print_records (id, record_key, target_date, superseded_at, printed_job_id, created_at, updated_at) VALUES (?,?,?,NULL,NULL,?,?)"
          )
          .run("pin-b-r2", "pin-b-dup", TARGET_DATE, now, now)
      ).toThrow();
    });

    it("(pin c) two RACING claims through the real db -> exactly one winner (mutant: SELECT-then-UPDATE claim -> red)", () => {
      enqueuePrintJob(
        { recordKey: "pin-c-race", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );

      const first = claimJob(ANCHOR_MS);
      const second = claimJob(ANCHOR_MS);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it("(pin c, structural) claim is ONE atomic UPDATE...RETURNING statement against print_jobs — a SELECT-then-UPDATE refactor reds this", () => {
      enqueuePrintJob(
        { recordKey: "pin-c-structural", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );

      const db = getDb();
      const prepareSpy = vi.spyOn(db, "prepare");
      claimJob(ANCHOR_MS);

      const printJobsStatements = prepareSpy.mock.calls
        .map(([sql]) => sql as string)
        .filter((sql) => /print_jobs/i.test(sql));

      // Exactly one statement touches print_jobs for the claim decision itself — a
      // SELECT-then-UPDATE refactor would show up as TWO statements here.
      expect(printJobsStatements).toHaveLength(1);
      expect(printJobsStatements[0]).toMatch(/^\s*UPDATE\s+print_jobs/i);
      expect(printJobsStatements[0]).toMatch(/RETURNING/i);
      expect(printJobsStatements[0]).toMatch(/SELECT/i); // the day-scoped subquery lives INSIDE this same statement
    });

    it("(P2-3) claim is day-scoped structurally — a job dated for a DIFFERENT day is never claimable, even with nothing else pending (mutant: drop the WHERE's day predicate -> red)", () => {
      enqueuePrintJob(
        { recordKey: "pin-p2-3-day-scope", targetDate: "2020-01-01", outputRef: "x" },
        ANCHOR_MS
      );

      expect(claimJob(ANCHOR_MS)).toBeNull();
    });
  });

  // ── (independent verify-pr on) ─────────────────────────

  describe("review fold — per-lease payload_served_at reset (P2-1) + superseded_at pin (P2-2)", () => {
    it("(P2-1) printer-off -> recoverable fail -> re-claim -> supersede MUST cancel the re-claimed job (mutant: drop either payload_served_at reset -> red)", () => {
      enqueuePrintJob(
        { recordKey: "test-print:p2-1-retry-supersede", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );

      // Lease 1: claim, fetch (stamps payload_served_at under lease 1), then the printer is off —
      // a RECOVERABLE failure releases the lease back to pending.
      const firstClaim = claimJob(ANCHOR_MS)!;
      getPayload(firstClaim.job.id, firstClaim.leaseToken, ANCHOR_MS + 1);
      const failed = failJob(
        firstClaim.job.id,
        firstClaim.leaseToken,
        ANCHOR_MS + 2,
        "no printer connected"
      );
      expect(failed.state).toBe("pending");

      // Lease 2: the printer comes back — re-claim under a FRESH lease. This lease has fetched
      // NOTHING yet; `payload_served_at` must read as unset for it, not lease 1's stale stamp.
      const secondClaim = claimJob(ANCHOR_MS + 3)!;
      expect(secondClaim.job.id).toBe(firstClaim.job.id);

      // The producer regenerates before the second lease ever calls getPayload — supersede MUST
      // cancel this still-claimed-but-not-yet-fetched-under-THIS-lease job (FR-015/AC-08).
      supersedePrintRecord("test-print:p2-1-retry-supersede", TARGET_DATE, ANCHOR_MS + 4);

      const job = listJobs(ANCHOR_MS + 4).jobs.find((j) => j.id === firstClaim.job.id)!;
      expect(job.state).toBe("cancelled");
    });

    it("(P2-2) ackJob's superseded_at reset: supersede -> re-enqueue -> claim -> ack -> a THIRD trigger reports alreadyPrinted, never a third job (mutant: drop the reset -> red)", () => {
      enqueuePrintJob(
        { recordKey: "p2-2-superseded-reset", targetDate: TARGET_DATE, outputRef: "v1" },
        ANCHOR_MS
      );
      supersedePrintRecord("p2-2-superseded-reset", TARGET_DATE, ANCHOR_MS + 1);

      const reenqueued = enqueuePrintJob(
        { recordKey: "p2-2-superseded-reset", targetDate: TARGET_DATE, outputRef: "v2" },
        ANCHOR_MS + 2
      );
      expect(reenqueued.enqueued).toBe(true);

      const claimed = claimJob(ANCHOR_MS + 3)!;
      expect(claimed.job.id).toBe(reenqueued.jobId);
      ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 4);

      const thirdTrigger = enqueuePrintJob(
        { recordKey: "p2-2-superseded-reset", targetDate: TARGET_DATE, outputRef: "v3" },
        ANCHOR_MS + 5
      );
      expect(thirdTrigger.enqueued).toBe(false);
      expect(thirdTrigger.alreadyPrinted).toBe(true);
      expect(thirdTrigger.jobId).toBe(reenqueued.jobId);

      const jobs = listJobs(ANCHOR_MS + 5).jobs.filter(
        (j) => j.recordKey === "p2-2-superseded-reset"
      );
      expect(jobs).toHaveLength(2); // the original (cancelled) job + the printed job — NEVER a third
    });
  });

  // ──: generation-scoped dedup + ack ─

  describe("review fold — generation-scoped dedup and ack (Codex P1s on #687)", () => {
    it("(P1-a) supersede-after-FETCH -> an immediate re-enqueue creates a NEW job, not the stale fetched-in-flight one (mutant: drop the in-flight dedup's generation scope -> red)", () => {
      enqueuePrintJob(
        { recordKey: "test-print:p1-a-fetched-survivor", targetDate: TARGET_DATE, outputRef: "v1" },
        ANCHOR_MS
      );
      const staleClaim = claimJob(ANCHOR_MS)!;
      // Fetched -> claimed-not-yet-fetched becomes fetched-in-flight; H2 lets it keep running.
      getPayload(staleClaim.job.id, staleClaim.leaseToken, ANCHOR_MS + 1);

      supersedePrintRecord("test-print:p1-a-fetched-survivor", TARGET_DATE, ANCHOR_MS + 2);
      // The stale job is untouched (still 'claimed') — supersede's own cancel condition
      // deliberately spares a fetched-in-flight job (H2).
      const staleAfterSupersede = listJobs(ANCHOR_MS + 2).jobs.find(
        (j) => j.id === staleClaim.job.id
      )!;
      expect(staleAfterSupersede.state).toBe("claimed");

      // The producer immediately re-enqueues the regenerated output. Without generation-scoped
      // dedup, this would find the stale job "in-flight" and dedupe onto it — the regenerated
      // output would never be queued at all (the reported P1-a gap).
      const regenerated = enqueuePrintJob(
        {
          recordKey: "test-print:p1-a-fetched-survivor",
          targetDate: TARGET_DATE,
          outputRef: "v2",
        },
        ANCHOR_MS + 3
      );
      expect(regenerated.enqueued).toBe(true);
      expect(regenerated.jobId).not.toBe(staleClaim.job.id);

      const jobs = listJobs(ANCHOR_MS + 3).jobs.filter(
        (j) => j.recordKey === "test-print:p1-a-fetched-survivor"
      );
      expect(jobs).toHaveLength(2); // the stale survivor (still claimed) + the new-generation job
      const newJob = jobs.find((j) => j.id === regenerated.jobId)!;
      expect(newJob.state).toBe("pending");
    });

    it("(P1-b) the STALE job's ack leaves the record re-printable; the NEW-generation job's ack DOES settle it (mutant: drop ackJob's generation gate -> red)", () => {
      enqueuePrintJob(
        { recordKey: "test-print:p1-b-stale-ack", targetDate: TARGET_DATE, outputRef: "v1" },
        ANCHOR_MS
      );
      const staleClaim = claimJob(ANCHOR_MS)!;
      getPayload(staleClaim.job.id, staleClaim.leaseToken, ANCHOR_MS + 1);

      supersedePrintRecord("test-print:p1-b-stale-ack", TARGET_DATE, ANCHOR_MS + 2);

      const regenerated = enqueuePrintJob(
        { recordKey: "test-print:p1-b-stale-ack", targetDate: TARGET_DATE, outputRef: "v2" },
        ANCHOR_MS + 3
      );

      // The STALE job (generation 0) finally acks — the transmission genuinely happened
      // (truthful paper: its OWN printed_at IS stamped), but it must NOT re-canonicalize the
      // record: the documented manual-reprint remedy for H2 must not be silently blocked.
      const staleAck = ackJob(staleClaim.job.id, staleClaim.leaseToken, ANCHOR_MS + 4);
      expect(staleAck.state).toBe("printed");
      expect(staleAck.printedAt).toBe(ANCHOR_MS + 4);

      const furtherTrigger = enqueuePrintJob(
        { recordKey: "test-print:p1-b-stale-ack", targetDate: TARGET_DATE, outputRef: "v3" },
        ANCHOR_MS + 5
      );
      // The record is STILL re-printable (the stale ack did not settle it) — but the
      // new-generation job is already in flight (pending), so this dedupes onto IT, not a
      // fourth job: never `alreadyPrinted` off a transmission nobody's current content ever sent.
      expect(furtherTrigger.alreadyPrinted).toBe(false);
      expect(furtherTrigger.jobId).toBe(regenerated.jobId);

      // Now the CURRENT-generation job acks — THIS is the ack that settles the record.
      const currentClaim = claimJob(ANCHOR_MS + 6)!;
      expect(currentClaim.job.id).toBe(regenerated.jobId);
      ackJob(currentClaim.job.id, currentClaim.leaseToken, ANCHOR_MS + 7);

      const afterCurrentAck = enqueuePrintJob(
        { recordKey: "test-print:p1-b-stale-ack", targetDate: TARGET_DATE, outputRef: "v4" },
        ANCHOR_MS + 8
      );
      expect(afterCurrentAck.alreadyPrinted).toBe(true);
      expect(afterCurrentAck.jobId).toBe(regenerated.jobId);
    });
  });

  // ── — producer seam: supersede ──────────────────────────────────────

  describe("supersedePrintRecord — the matrix across job states (H2/ADR-022)", () => {
    it("cancels a PENDING job and marks the record re-printable", () => {
      enqueuePrintJob(
        { recordKey: "sup-pending", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      supersedePrintRecord("sup-pending", TARGET_DATE, ANCHOR_MS + 1);

      const job = listJobs(ANCHOR_MS).jobs.find((j) => j.recordKey === "sup-pending")!;
      expect(job.state).toBe("cancelled");
    });

    it("cancels a CLAIMED-but-NOT-YET-FETCHED job", () => {
      enqueuePrintJob(
        { recordKey: "sup-claimed-nofetch", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      claimJob(ANCHOR_MS);
      supersedePrintRecord("sup-claimed-nofetch", TARGET_DATE, ANCHOR_MS + 1);

      const job = listJobs(ANCHOR_MS).jobs.find((j) => j.recordKey === "sup-claimed-nofetch")!;
      expect(job.state).toBe("cancelled");
    });

    it("does NOT cancel a claimed job whose payload was already fetched (fetched-in-flight continues, H2 accepted)", () => {
      enqueuePrintJob(
        { recordKey: "test-print:sup-claimed-fetched", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

      supersedePrintRecord("test-print:sup-claimed-fetched", TARGET_DATE, ANCHOR_MS + 2);

      const job = listJobs(ANCHOR_MS).jobs.find(
        (j) => j.recordKey === "test-print:sup-claimed-fetched"
      )!;
      expect(job.state).toBe("claimed");
    });

    it("does not disturb an already-printed job, but the record becomes re-printable", () => {
      enqueuePrintJob(
        { recordKey: "sup-printed", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

      supersedePrintRecord("sup-printed", TARGET_DATE, ANCHOR_MS + 2);

      const job = listJobs(ANCHOR_MS).jobs.find((j) => j.recordKey === "sup-printed")!;
      expect(job.state).toBe("printed"); // untouched

      const record = getDb()
        .prepare("SELECT superseded_at FROM print_records WHERE record_key = ? AND target_date = ?")
        .get("sup-printed", TARGET_DATE) as { superseded_at: number | null };
      expect(record.superseded_at).not.toBeNull();
    });

    it("is a no-op (never throws) against a record that was never enqueued", () => {
      expect(() => supersedePrintRecord("never-enqueued", TARGET_DATE, ANCHOR_MS)).not.toThrow();
    });

    it("re-enqueuing after supersede creates a genuinely NEW job row", () => {
      const original = enqueuePrintJob(
        { recordKey: "sup-reenqueue", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      supersedePrintRecord("sup-reenqueue", TARGET_DATE, ANCHOR_MS + 1);
      const fresh = enqueuePrintJob(
        { recordKey: "sup-reenqueue", targetDate: TARGET_DATE, outputRef: "x-v2" },
        ANCHOR_MS + 2
      );

      expect(fresh.enqueued).toBe(true);
      expect(fresh.jobId).not.toBe(original.jobId);
      const jobs = listJobs(ANCHOR_MS).jobs.filter((j) => j.recordKey === "sup-reenqueue");
      expect(jobs).toHaveLength(2);
    });
  });

  // ── — producer seam: fetch-at-execute provider resolution ─────────

  describe("registerPrintableProvider — fetch-at-execute resolution (research D4)", () => {
    it("a fetch AFTER regeneration serves the CURRENT provider output, not a stale enqueue-time snapshot", () => {
      let generation = "v1";
      registerPrintableProvider("regen-producer", (outputRef) => {
        const text = `${outputRef}:${generation}`;
        return packAsDeviceRaster(text);
      });

      enqueuePrintJob(
        {
          recordKey: "regen-producer:item",
          targetDate: TARGET_DATE,
          outputRef: "regen-producer:item",
        },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      const first = getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);
      expect(first.toString()).toContain(":v1");

      generation = "v2"; // the producer "regenerated" its content
      const second = getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 2);
      expect(second.toString()).toContain(":v2");
    });

    it("a MISSING provider dead-letters the job as render_failure and emits printing.failed", async () => {
      let received: CoreEventCatalog["printing.failed"] | undefined;
      subscribe("printing.failed", (payload) => {
        received = payload;
      });

      enqueuePrintJob(
        {
          recordKey: "no-such-provider:item",
          targetDate: TARGET_DATE,
          outputRef: "unresolvable-output",
        },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      expect(() => getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1)).toThrow(
        PrintRenderFailureError
      );

      const job = listJobs(ANCHOR_MS + 1).jobs.find((j) => j.id === claimed.job.id)!;
      expect(job.state).toBe("failed");
      expect(job.derivedState).toBe("dead-letter");
      expect(job.failureReason).toBeTruthy();

      await flushMicrotasks();
      expect(received).toEqual({
        jobId: claimed.job.id,
        outputRef: "unresolvable-output",
        errorCode: "render_failure",
      });
    });

    it("an ERRORING provider dead-letters the job as render_failure too", () => {
      registerPrintableProvider("erroring-producer", () => {
        throw new Error("boom: provider blew up");
      });

      enqueuePrintJob(
        { recordKey: "erroring-producer:item", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;

      expect(() => getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1)).toThrow(
        PrintRenderFailureError
      );
      const job = listJobs(ANCHOR_MS + 1).jobs.find((j) => j.id === claimed.job.id)!;
      expect(job.state).toBe("failed");
      expect(job.failureReason).toContain("boom");
    });

    it("the seam carries only outputRef + metadata — the provider receives outputRef and NOTHING else (producer-agnostic, FR-014)", () => {
      let capturedArgs: unknown[] = [];
      registerPrintableProvider("agnostic-producer", (...args: unknown[]) => {
        capturedArgs = args;
        return packAsDeviceRaster("agnostic");
      });

      enqueuePrintJob(
        {
          recordKey: "agnostic-producer:member-x",
          targetDate: TARGET_DATE,
          outputRef: "the-only-thing-the-provider-should-see",
        },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

      expect(capturedArgs).toEqual(["the-only-thing-the-provider-should-see"]);
    });
  });
});
