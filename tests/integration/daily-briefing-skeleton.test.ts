import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { todayInHouseholdTz } from "../../src/server/host-api";
import { enqueuePrintJob, claimJob, getPayload } from "../../src/server/modules/printing/index";
import { renderBriefingBitmap } from "../../src/server/modules/daily-briefing/render/bridge";
import {
  pngToPackedRaster,
  RASTER_BYTES_PER_ROW,
} from "../../src/server/modules/daily-briefing/render/raster";
import type { RenderEnvelope } from "../../src/server/modules/daily-briefing/render/types";
// Importing the module (side effect at load time): registers the daily-briefing printable
// provider (FR-016) — exactly what a real server boot does.
import "../../src/server/modules/daily-briefing/index";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/daily-briefing.md (Constitution XIII runnable skeleton), as amended:
 * a fixture envelope v2 carrying ONE `message` block renders through the REAL pressedslip
 * pipeline, is packed into the printable raster and stored on a `daily_briefing` row (simulating
 * what the full generation will do), and the REAL 018 Printing module
 * (enqueue -> claim -> getPayload) resolves that stored raster through the daily-briefing
 * printable provider registered by this module, all the way to ESC/POS-wrapped bytes. Injected
 * clock throughout (`now` is a fixed constant passed to every printing call) — no wall-clock read
 * anywhere in this test.
 */
describe("daily-briefing skeleton — render -> store -> enqueue -> claim -> payload", () => {
  useIsolatedDb();

  const NOW = Date.UTC(2026, 8, 8, 6, 0, 0); // 2026-09-08 06:00 UTC — frozen, injected clock
  const memberId = "member-skeleton-1";
  // Computed in beforeEach, not at describe-body eval time: useIsolatedDb's own beforeEach
  // (which runs migrations, incl. settings_objects) must run FIRST — todayInHouseholdTz reads
  // through that table.
  let date: string;
  beforeEach(() => {
    date = todayInHouseholdTz(NOW);
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
      )
      .run(memberId, "Skeleton Member", NOW, NOW);
  });

  function seedBriefingRowWithRaster(
    rasterBits: Uint8Array,
    rasterHeight: number,
    png: Uint8Array,
    forDate: string = date
  ) {
    const db = getDb();
    db.prepare(
      `INSERT INTO daily_briefing
        (id, member_id, date, status, payload, failed_render_blocks, raster_bits, raster_height, png, created_at, updated_at)
       VALUES (?, ?, ?, 'ready', '{}', '[]', ?, ?, ?, ?, ?)`
    ).run(
      `briefing-${memberId}-${forDate}`,
      memberId,
      forDate,
      Buffer.from(rasterBits),
      rasterHeight,
      Buffer.from(png),
      NOW,
      NOW
    );
  }

  it("renders a fixture envelope, packs + stores the raster, and the real 018 pipeline serves it", async () => {
    const envelope: RenderEnvelope = {
      memberId,
      memberName: "Skeleton Member",
      date,
      blocks: [{ type: "message", title: "MESSAGE", data: { text: "Have a wonderful day!" } }],
    };

    // 1. Render through the REAL pressedslip pipeline (adapter -> registry -> theme -> render).
    const rendered = await renderBriefingBitmap(envelope);
    expect(rendered.bitmapPng).not.toBeNull();
    expect(rendered.failedRenderBlocks).toEqual([]);
    const pngBytes = rendered.bitmapPng as Uint8Array;

    // 2. Pack the PNG into the printable raster — exactly RASTER_BYTES_PER_ROW (72)
    // bytes per row.
    const packed = pngToPackedRaster(pngBytes);
    expect(packed.bits.length).toBe(RASTER_BYTES_PER_ROW * packed.height);
    expect(RASTER_BYTES_PER_ROW).toBe(72);

    // 3. Store on a daily_briefing row (simulating the full generation write).
    seedBriefingRowWithRaster(packed.bits, packed.height, pngBytes);

    // 4. Enqueue through the REAL producer-agnostic seam (FR-016/): recordKey is the
    // per-member dedup anchor; outputRef is the DATED provider-lookup identity.
    const recordKey = `daily-briefing:${memberId}`;
    const outputRef = `daily-briefing:${memberId}:${date}`;
    const enqueueResult = enqueuePrintJob(
      { recordKey, targetDate: date, outputRef, memberId },
      NOW
    );
    expect(enqueueResult.enqueued).toBe(true);
    expect(enqueueResult.alreadyPrinted).toBe(false);
    const jobId = enqueueResult.jobId;

    // 5. Claim through the REAL atomic claim.
    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    expect(claimed?.job.id).toBe(jobId);
    const leaseToken = claimed?.leaseToken as string;

    // 6. Payload resolves through the daily-briefing printable provider registered at module load
    // -> the real ADR-066 ESC/POS wrap (packed-invariant + device-width validation, then wrap).
    const payload = getPayload(jobId, leaseToken, NOW);
    expect(payload.length).toBeGreaterThan(0);
    // ESC/POS init sequence: ESC @ (0x1B 0x40).
    expect(payload[0]).toBe(0x1b);
    expect(payload[1]).toBe(0x40);
    // Trailer contains GS V 0 (full cut): 0x1D 0x56 0x00, somewhere near the end of the stream.
    let foundTrailer = false;
    for (let i = 0; i <= payload.length - 3; i += 1) {
      if (payload[i] === 0x1d && payload[i + 1] === 0x56 && payload[i + 2] === 0x00) {
        foundTrailer = true;
        break;
      }
    }
    expect(foundTrailer).toBe(true);
  });

  /** the provider's date matching had ZERO proof — a mutation that serves the
   * newest row for the member REGARDLESS of the requested date passed every prior test (none of
   * them ever seeded two DIFFERENT dates for the SAME member). Seeds a NEWER row (this test's
   * `date`, "today") and an OLDER row (`OLDER_DATE`) for the SAME member with DISTINGUISHABLE
   * rasters, enqueues a job whose CLAIMABLE target_date is "today" (so `claimJob`'s own day-scoping
   * doesn't get in the way) but whose outputRef embeds the OLDER date — the provider must resolve
   * the OLDER row's raster, never the newer one merely because it's more recent.
   */
  const OLDER_DATE = "2026-09-01";

  it("resolves the EXACT dated row's raster, not merely the newest row for the member (P1-4)", async () => {
    const newerRasterByte = 0xaa;
    const olderRasterByte = 0x55;
    const newerRaster = new Uint8Array(RASTER_BYTES_PER_ROW).fill(newerRasterByte);
    const olderRaster = new Uint8Array(RASTER_BYTES_PER_ROW).fill(olderRasterByte);
    const dummyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    // Seed the NEWER row (today) first isn't required, but seeding both proves the provider reads
    // by (member_id, date) and not by insertion order/recency either.
    seedBriefingRowWithRaster(newerRaster, 1, dummyPng, date);
    seedBriefingRowWithRaster(olderRaster, 1, dummyPng, OLDER_DATE);

    const recordKey = `daily-briefing:${memberId}`;
    const outputRef = `daily-briefing:${memberId}:${OLDER_DATE}`;
    // targetDate is "today" (claimable) — outputRef's embedded date ("older") is the provider's
    // OWN lookup key, deliberately decoupled from target_date for this test (see doc comment).
    const enqueueResult = enqueuePrintJob(
      { recordKey, targetDate: date, outputRef, memberId },
      NOW
    );
    expect(enqueueResult.enqueued).toBe(true);

    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    const leaseToken = claimed?.leaseToken as string;

    const payload = getPayload(enqueueResult.jobId, leaseToken, NOW);
    // Header is 12 bytes (ESC@ + ESC2 + GS v 0's 8-byte header), then RASTER_BYTES_PER_ROW bytes
    // of raw raster data (height=1 here) — escpos.ts's own documented format.
    const rasterSlice = payload.slice(12, 12 + RASTER_BYTES_PER_ROW);
    expect(new Set(rasterSlice)).toEqual(new Set([olderRasterByte]));
    expect(new Set(rasterSlice)).not.toEqual(new Set([newerRasterByte]));
  });

  /** the prior malformed-outputRef test was vacuous — a loosened parse would
   * still throw later for an unrelated reason (e.g. "no raster found"), so the assertion never
   * proved the STRICT PARSE fired at all. Asserts the exact diagnostic message on two distinct
   * malformed shapes.
   */
  /** `date` is assigned in `beforeEach` (see the doc comment on its declaration above) — so the two
   * malformed shapes are built via a FACTORY invoked from inside each test body, never at
   * describe-body eval time (an `it.each([...])` array literal would capture `date` while it is
   * still unassigned — TS's definite-assignment check catches exactly this class of bug).
   */
  const malformedOutputRefShapes: Array<[label: string, build: () => string]> = [
    ["missing date part", () => `daily-briefing:${memberId}`],
    ["extra colon garbage", () => `daily-briefing:${memberId}:${date}:extra`],
  ];

  it.each(malformedOutputRefShapes)(
    "throws a malformed-outputRef error for %s (strict parse, FR-016)",
    (_label, buildOutputRef) => {
      const outputRef = buildOutputRef();
      const recordKey = `daily-briefing:${memberId}`;
      const enqueueResult = enqueuePrintJob(
        { recordKey, targetDate: date, outputRef, memberId },
        NOW
      );
      expect(enqueueResult.enqueued).toBe(true);

      const claimed = claimJob(NOW);
      expect(claimed).not.toBeNull();
      const leaseToken = claimed?.leaseToken as string;

      // getPayload's own catch wraps ANY provider throw into the generic PrintRenderFailureError
      // (printing/index.ts) — the OUTER thrown message never carries the provider's own reason.
      // The provider's exact diagnostic message IS captured verbatim as the job's persisted
      // `failure_reason` (printing/index.ts#applyPermanentFailure) — asserting THAT is what
      // actually proves the strict-parse code path fired, versus a loosened parse failing later
      // for an unrelated reason (e.g. "no raster found").
      expect(() => getPayload(enqueueResult.jobId, leaseToken, NOW)).toThrow();
      const failureReason = getDb()
        .prepare("SELECT failure_reason FROM print_jobs WHERE id = ?")
        .get(enqueueResult.jobId) as { failure_reason: string | null };
      expect(failureReason.failure_reason).toMatch(/malformed outputRef/);
    }
  );

  it("throws when no raster is stored for the exact member+date (absence-tolerant provider, never a crash caller-side)", () => {
    // No daily_briefing row (and therefore no raster) exists for "no-raster-member" — the
    // provider must throw rather than serve a stale/wrong raster or crash the caller.
    const recordKey = "daily-briefing:no-raster-member";
    const outputRef = `daily-briefing:no-raster-member:${date}`;
    const enqueueResult = enqueuePrintJob({ recordKey, targetDate: date, outputRef }, NOW);
    expect(enqueueResult.enqueued).toBe(true);

    const claimed = claimJob(NOW);
    expect(claimed).not.toBeNull();
    const leaseToken = claimed?.leaseToken as string;
    expect(() => getPayload(enqueueResult.jobId, leaseToken, NOW)).toThrow();
  });
});
