import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { todayInHouseholdTz } from "../../src/server/host-api";
import {
  ackJob,
  claimJob,
  enqueuePrintJob,
  enqueueTestPrint,
  getPayload,
  getPrintRecordStatus,
  __setPrintingPluginActiveForTests,
} from "../../src/server/modules/printing/index";
import {
  __setForcePostSupersedeAbortForTests,
  generateBriefing,
  readBriefing,
} from "../../src/server/modules/daily-briefing/index";
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";

/** docs/features/daily-briefing.md (US3, fold) —
 * regeneration + supersede atomicity, and the printed-status event-cache/read-time-fallback pair
 * (quickstart S4). Every test drives the REAL `generateBriefing`/`readBriefing` module functions
 * plus the REAL 018 Printing module (`enqueuePrintJob`/`claimJob`/`ackJob`) against an isolated
 * SQLite DB — no mocking of either module's write paths. "message" is the one block type with a
 * real pressedslip render-def today (gap, see `daily-briefing-generation.test.ts`'s * identical precedent), so seeding a `daily_messages` row is what gives every test here a REAL
 * printable raster without needing to mock the render bridge.
 */
describe("daily-briefing regeneration + supersede + printed-status (research D4/D11, FR-002/003/004/005/007)", () => {
  useIsolatedDb();

  const NOW = Date.UTC(2026, 8, 8, 6, 0, 0); // 2026-09-08 06:00 UTC — frozen, injected clock
  const memberId = "member-regen-1";
  const RECORD_KEY_PREFIX = "daily-briefing";
  let date: string;

  function recordKeyFor(id: string): string {
    return `${RECORD_KEY_PREFIX}:${id}`;
  }
  function outputRefFor(id: string, d: string): string {
    return `${RECORD_KEY_PREFIX}:${id}:${d}`;
  }
  function seedDailyMessage(id: string, d: string, text: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO daily_messages (id, member_id, date, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(`msg-${id}-${d}`, id, d, text, now, now);
  }
  function enqueueForMember(): ReturnType<typeof enqueuePrintJob> {
    return enqueuePrintJob(
      {
        recordKey: recordKeyFor(memberId),
        targetDate: date,
        outputRef: outputRefFor(memberId, date),
        memberId,
      },
      NOW
    );
  }
  function jobState(jobId: string): string | undefined {
    const row = getDb().prepare("SELECT state FROM print_jobs WHERE id = ?").get(jobId) as
      { state: string } | undefined;
    return row?.state;
  }
  function pendingOrClaimedCount(): number {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM print_jobs pj
         JOIN print_records pr ON pr.id = pj.record_id
         WHERE pr.record_key = ? AND pr.target_date = ? AND pj.state IN ('pending', 'claimed')`
      )
      .get(recordKeyFor(memberId), date) as { c: number };
    return row.c;
  }
  function printCacheColumns(briefingId: string): {
    last_print_state: string | null;
    last_print_at: number | null;
    last_print_generation: number | null;
  } {
    return getDb()
      .prepare(
        "SELECT last_print_state, last_print_at, last_print_generation FROM daily_briefing WHERE id = ?"
      )
      .get(briefingId) as {
      last_print_state: string | null;
      last_print_at: number | null;
      last_print_generation: number | null;
    };
  }

  beforeEach(() => {
    date = todayInHouseholdTz(NOW);
    seedMember(memberId, { optedIn: true });
    seedDailyMessage(memberId, date, "Have a wonderful day!");
  });

  afterEach(() => {
    __setPrintingPluginActiveForTests(undefined);
    __setForcePostSupersedeAbortForTests(undefined);
  });

  describe("Constitution XIV probe — better-sqlite3 nested db.transaction() composes via SAVEPOINT", () => {
    it("commits together and rolls back together, empirically", () => {
      // Pure DB-level probe, independent of any daily-briefing/printing production code — proves
      // the general mechanism `supersedePrintRecordTxn`'s own doc comment relies on
      // (node_modules/better-sqlite3/lib/methods/transaction.js: `db.transaction(fn)` checks
      // `db.inTransaction` at CALL TIME and substitutes SAVEPOINT/RELEASE/ROLLBACK TO for
      // BEGIN/COMMIT/ROLLBACK when already nested).
      const db = getDb();
      db.exec("CREATE TABLE t010_savepoint_probe (id INTEGER PRIMARY KEY, val TEXT)");

      const inner = db.transaction((val: string) => {
        db.prepare("INSERT INTO t010_savepoint_probe (val) VALUES (?)").run(val);
      });

      // Commit-together: an outer transaction whose body calls a nested `db.transaction` — both
      // persist when the outer succeeds.
      const outerOk = db.transaction(() => {
        db.prepare("INSERT INTO t010_savepoint_probe (val) VALUES (?)").run("outer-1");
        inner("inner-1");
      });
      outerOk();
      expect(db.prepare("SELECT val FROM t010_savepoint_probe ORDER BY id").all()).toEqual([
        { val: "outer-1" },
        { val: "inner-1" },
      ]);

      // Rollback-together: the outer transaction throws AFTER the nested transaction has already
      // RELEASEd its savepoint (i.e. "committed" from its own point of view) — proving the outer
      // ROLLBACK discards the already-released nested savepoint too, not just the outer's own
      // statements.
      const outerFail = db.transaction(() => {
        db.prepare("INSERT INTO t010_savepoint_probe (val) VALUES (?)").run("outer-2");
        inner("inner-2");
        throw new Error("forced abort");
      });
      expect(() => outerFail()).toThrow("forced abort");
      expect(db.prepare("SELECT val FROM t010_savepoint_probe ORDER BY id").all()).toEqual([
        { val: "outer-1" },
        { val: "inner-1" },
      ]); // unchanged — outer-2/inner-2 never persisted, either half
    });
  });

  it("regeneration preserves the briefing ID, cancels the in-flight job, bumps the generation, and enqueues nothing itself (FR-002/003/004)", async () => {
    const first = await generateBriefing(memberId, date);
    expect(first.status).not.toBe("render-failed");
    const rasterRow = getDb()
      .prepare("SELECT raster_bits FROM daily_briefing WHERE id = ?")
      .get(first.id) as { raster_bits: Buffer | null };
    expect(rasterRow.raster_bits).not.toBeNull(); // real "message" render-def produced a raster

    const enqueue1 = enqueueForMember();
    expect(enqueue1.enqueued).toBe(true);
    expect(jobState(enqueue1.jobId)).toBe("pending");
    expect(getPrintRecordStatus(recordKeyFor(memberId), date)?.generation).toBe(0);

    const second = await generateBriefing(memberId, date);
    expect(second.id).toBe(first.id); // INV-02: stable ID across regeneration

    // FR-003/FR-004 (PRINTING-AC-08 via the real 018 supersede): the prior pending job is
    // cancelled, and the record's generation is bumped — in the SAME transaction as the snapshot.
    expect(jobState(enqueue1.jobId)).toBe("cancelled");
    expect(getPrintRecordStatus(recordKeyFor(memberId), date)?.generation).toBe(1);

    // FR-002: regeneration itself enqueues NOTHING — no new pending/claimed job exists yet.
    expect(pendingOrClaimedCount()).toBe(0);
  });

  it("PROBE-5 (review fold P2-1): regeneration clears a POPULATED print cache — the prior test never actually populated it", async () => {
    const briefing = await generateBriefing(memberId, date);
    enqueueForMember();
    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    ackJob(claimed!.job.id, claimed!.leaseToken, NOW + 1_000);
    await Promise.resolve();
    await Promise.resolve();

    // Cache is genuinely non-null before regeneration — the precondition the prior test skipped.
    expect(printCacheColumns(briefing.id)).toEqual({
      last_print_state: "completed",
      last_print_at: NOW + 1_000,
      last_print_generation: 0,
    });

    await generateBriefing(memberId, date); // regenerate

    // FR-002: the local printed-status cache is cleared — all three columns, together.
    expect(printCacheColumns(briefing.id)).toEqual({
      last_print_state: null,
      last_print_at: null,
      last_print_generation: null,
    });
  });

  it("PROBE-4 (review fold P2-2): a stale-generation cache is ignored — read re-derives from the CURRENT generation, not the cache", async () => {
    const briefing = await generateBriefing(memberId, date);
    enqueueForMember(); // creates a real print_records row at generation 0, job still pending

    // Hand-plant a cache claiming a LATER generation (99) already completed — this can only be
    // stale/wrong (the real record is at generation 0 and has never printed).
    getDb()
      .prepare(
        "UPDATE daily_briefing SET last_print_state = 'completed', last_print_at = ?, last_print_generation = 99 WHERE id = ?"
      )
      .run(NOW, briefing.id);

    const result = readBriefing(memberId, date);
    if (!result.generated) throw new Error("expected a generated briefing");
    // The generation mismatch (99 !== 0) means the cache is stale — re-derived instead: nothing has
    // actually printed at generation 0 (job still pending), so the TRUE status is "none".
    expect(result.printedStatus).toBe("none");
  });

  it("PROBE-2 (review fold P2-4): a foreign producer's completion (test-print) leaves this briefing's cache byte-identical and never throws", async () => {
    const briefing = await generateBriefing(memberId, date);
    const before = printCacheColumns(briefing.id);
    expect(before.last_print_state).toBeNull(); // nothing enqueued for THIS briefing yet

    // A different producer entirely (Printing's own built-in test-print, record key "test-print")
    // completes through the REAL enqueue -> claim -> ack path.
    const testPrint = enqueueTestPrint(NOW, date);
    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    expect(claimed!.job.id).toBe(testPrint.jobId);
    expect(() => ackJob(claimed!.job.id, claimed!.leaseToken, NOW + 1_000)).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();

    // The foreign outputRef ("test-print:<date>") never matches this plugin's "daily-briefing:"
    // prefix — the subscriber's guard ignores it entirely, leaving this briefing's cache untouched.
    expect(printCacheColumns(briefing.id)).toEqual(before);
  });

  it("post-supersede re-enqueue works: a fresh enqueue after regeneration returns enqueued:true against the new generation", async () => {
    await generateBriefing(memberId, date);
    const enqueue1 = enqueueForMember();
    expect(enqueue1.enqueued).toBe(true);

    await generateBriefing(memberId, date); // regenerate — supersedes enqueue1's record

    const enqueue2 = enqueueForMember();
    expect(enqueue2.enqueued).toBe(true);
    expect(enqueue2.alreadyPrinted).toBe(false);
    expect(enqueue2.jobId).not.toBe(enqueue1.jobId);
    expect(jobState(enqueue2.jobId)).toBe("pending");
  });

  it("P1 regression (review fold): a stale-generation survivor's late ack must NOT false-fresh the cache — reproduces the reviewer's exact sequence", async () => {
    const briefing = await generateBriefing(memberId, date);
    const enqueue1 = enqueueForMember();

    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    expect(claimed!.job.id).toBe(enqueue1.jobId);
    // Fetch the payload — this is what makes the job "fetched-in-flight" (payload_served_at set),
    // so the upcoming regeneration's supersede does NOT cancel it (H2/ADR-022's accepted survivor).
    expect(() => getPayload(claimed!.job.id, claimed!.leaseToken, NOW)).not.toThrow();

    // REGENERATE: supersedes the record (generation 0 -> 1) but leaves the fetched-in-flight
    // survivor running, per supersedePrintRecordTxn's own documented H2 exception.
    await generateBriefing(memberId, date);
    expect(jobState(enqueue1.jobId)).toBe("claimed"); // NOT cancelled — the accepted survivor
    expect(getPrintRecordStatus(recordKeyFor(memberId), date)?.generation).toBe(1);

    // The survivor NOW acks, AFTER the regeneration. `ackJob` still emits `printing.completed`
    // (research: the event fires regardless of generation match) but its print_records write is
    // generation-gated and therefore skipped (job generation 0 !== record generation 1).
    ackJob(claimed!.job.id, claimed!.leaseToken, NOW + 10_000);
    await Promise.resolve();
    await Promise.resolve();

    // P1 FIX: the subscriber re-derives from Printing's CURRENT generation instead of trusting the
    // event — finds nothing printed/failed at generation 1, and therefore writes NOTHING. The
    // cache stays exactly as the regeneration itself left it (NULL) — never a false "completed".
    expect(printCacheColumns(briefing.id)).toEqual({
      last_print_state: null,
      last_print_at: null,
      last_print_generation: null,
    });

    const result = readBriefing(memberId, date);
    if (!result.generated) throw new Error("expected a generated briefing");
    expect(result.printedStatus).toBe("none");
  });

  it("atomicity: a forced abort AFTER supersede rolls back BOTH the snapshot replacement and the supersede", async () => {
    const first = await generateBriefing(memberId, date);
    const enqueue1 = enqueueForMember();

    const beforeRow = getDb()
      .prepare("SELECT status, payload, updated_at FROM daily_briefing WHERE id = ?")
      .get(first.id);
    const beforeGeneration = getPrintRecordStatus(recordKeyFor(memberId), date)?.generation;

    __setForcePostSupersedeAbortForTests(true);
    await expect(generateBriefing(memberId, date)).rejects.toThrow(
      "savepoint probe: forced abort after supersede"
    );
    __setForcePostSupersedeAbortForTests(false);

    // NEITHER the snapshot replacement NOR the supersede committed — both rolled back together.
    const afterRow = getDb()
      .prepare("SELECT status, payload, updated_at FROM daily_briefing WHERE id = ?")
      .get(first.id);
    expect(afterRow).toEqual(beforeRow);

    const afterGeneration = getPrintRecordStatus(recordKeyFor(memberId), date)?.generation;
    expect(afterGeneration).toBe(beforeGeneration);

    // The prior job was never cancelled either — the supersede's own writes rolled back too.
    expect(jobState(enqueue1.jobId)).toBe("pending");
  });

  it("dropped printing.completed event: read recovers printedStatus via the Printing query, then self-heals the cache (FR-005/AC-04)", async () => {
    const briefing = await generateBriefing(memberId, date);
    const enqueue1 = enqueueForMember();

    // Simulate a DROPPED `printing.completed` event: reach the identical "printed" end-state
    // directly via SQL, WITHOUT ever calling `ackJob` (which would emit the event this test
    // proves recovery from the ABSENCE of).
    const printedAt = NOW + 5_000;
    const db = getDb();
    const jobRow = db
      .prepare("SELECT record_id FROM print_jobs WHERE id = ?")
      .get(enqueue1.jobId) as { record_id: string };
    db.prepare("UPDATE print_jobs SET state = 'printed', printed_at = ? WHERE id = ?").run(
      printedAt,
      enqueue1.jobId
    );
    db.prepare(
      "UPDATE print_records SET printed_job_id = ?, superseded_at = NULL WHERE id = ?"
    ).run(enqueue1.jobId, jobRow.record_id);

    // The cache was never touched — no event ever fired.
    expect(printCacheColumns(briefing.id).last_print_state).toBeNull();

    const result = readBriefing(memberId, date);
    if (!result.generated) throw new Error("expected a generated briefing");
    expect(result.printedStatus).toBe("completed");

    // Self-healed: the cache is now refreshed by the read-time fallback query.
    const cache = printCacheColumns(briefing.id);
    expect(cache.last_print_state).toBe("completed");
    expect(cache.last_print_at).toBe(printedAt);
    expect(cache.last_print_generation).toBe(0);
  });

  it("the real ack path (claim -> ack) emits printing.completed and the subscriber updates the cache (batch-C precedent)", async () => {
    const briefing = await generateBriefing(memberId, date);
    enqueueForMember();

    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    ackJob(claimed!.job.id, claimed!.leaseToken, NOW + 1_000);

    // emit dispatches via queueMicrotask — flush before asserting (daily-briefing-trigger.test.ts
    // precedent).
    await Promise.resolve();
    await Promise.resolve();

    const cache = printCacheColumns(briefing.id);
    expect(cache.last_print_state).toBe("completed");
    expect(cache.last_print_at).toBe(NOW + 1_000);
    expect(cache.last_print_generation).toBe(0);

    const result = readBriefing(memberId, date);
    if (!result.generated) throw new Error("expected a generated briefing");
    expect(result.printedStatus).toBe("completed"); // served straight from the now-fresh cache
  });

  it("printing inactive => printedStatus is 'unavailable', not 'none' or an error (FR-007/AC-11)", async () => {
    await generateBriefing(memberId, date); // generate while Printing is active (default)

    __setPrintingPluginActiveForTests(false);
    const result = readBriefing(memberId, date);
    if (!result.generated) throw new Error("expected a generated briefing");
    expect(result.printedStatus).toBe("unavailable");
  });

  it("printing active but never enqueued => printedStatus is 'none'", async () => {
    await generateBriefing(memberId, date);

    const result = readBriefing(memberId, date);
    if (!result.generated) throw new Error("expected a generated briefing");
    expect(result.printedStatus).toBe("none");
  });
});
