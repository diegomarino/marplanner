import { describe, it, expect } from "vitest";
import { subscribe } from "../../src/server/lib/event-bus";
import type { CoreEventCatalog } from "../../src/shared/events";
import { todayInHouseholdTz } from "../../src/server/host-api";
import {
  wrapAsEscPos,
  PRINT_WIDTH_DOTS,
  PRINT_BYTES_PER_ROW,
} from "../../src/server/modules/printing/escpos";
import { generateTestPrintRaster, buildPayload } from "../../src/server/modules/printing/artifact";
import {
  enqueueTestPrint,
  enqueuePrintJob,
  claimJob,
  getPayload,
  ackJob,
  listJobs,
  registerPrintableProvider,
  PrintRenderFailureError,
} from "../../src/server/modules/printing/index";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/printing.md — the artifact pipeline (ADR-066).
 * Golden-shape assertions derive the expected ESC/POS byte prefixes/suffixes FROM v1's own
 * documented constants (escpos.ts's header comment, ported verbatim from
 * `packages/shared/src/print/escpos.ts`) — never invented. Fixed anchor instant (the
 * class) — every "now" below derives from it, never a wall-clock read.
 */
const ANCHOR_MS = Date.UTC(2026, 5, 15, 8, 0, 0); // 2026-06-15T08:00:00Z, arbitrary but fixed
const ANCHOR_MS_OTHER_DAY = Date.UTC(2026, 5, 16, 8, 0, 0); // 2026-06-16T08:00:00Z

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      queueMicrotask(() => resolve());
    });
  });
}

// The v1-documented ESC/POS command bytes (escpos.ts header comment): ESC=0x1B, GS=0x1D.
const ESC = 0x1b;
const GS = 0x1d;

describe("escpos.ts — pure port of v1 wrapAsEscPos (research D5)", () => {
  it("wraps a valid packed raster with the exact v1 init header and default feed+cut trailer", () => {
    const height = 4;
    const bits = new Uint8Array(PRINT_BYTES_PER_ROW * height); // all-zero is a structurally valid raster
    const wrapped = wrapAsEscPos(bits, height);

    // Header: ESC @, ESC 2, GS v 0 m=0, xL xH (bytes-per-row LE), yL yH (height LE).
    const xL = PRINT_BYTES_PER_ROW & 0xff;
    const xH = (PRINT_BYTES_PER_ROW >> 8) & 0xff;
    const yL = height & 0xff;
    const yH = (height >> 8) & 0xff;
    const expectedHeader = [ESC, 0x40, ESC, 0x32, GS, 0x76, 0x30, 0x00, xL, xH, yL, yH];
    expect(Array.from(wrapped.slice(0, expectedHeader.length))).toEqual(expectedHeader);

    // Trailer: ESC d n (feed 3 lines, the default), then GS V 0 (full cut, default).
    const expectedTrailer = [ESC, 0x64, 3, GS, 0x56, 0x00];
    expect(Array.from(wrapped.slice(wrapped.length - expectedTrailer.length))).toEqual(
      expectedTrailer
    );

    // GS v 0 row framing: total length = header + raster bytes + trailer, no extra padding.
    expect(wrapped.length).toBe(expectedHeader.length + bits.length + expectedTrailer.length);
  });

  it("honors feedLines/cut options in the trailer", () => {
    const bits = new Uint8Array(PRINT_BYTES_PER_ROW);
    const wrapped = wrapAsEscPos(bits, 1, { feedLines: 5, cut: false });
    const expectedTrailer = [ESC, 0x64, 5]; // no GS V 0 when cut=false
    expect(Array.from(wrapped.slice(wrapped.length - expectedTrailer.length))).toEqual(
      expectedTrailer
    );
  });

  it("rejects a bitmap length that does not match bytesPerRow*heightPx", () => {
    expect(() => wrapAsEscPos(new Uint8Array(1), 4)).toThrow(RangeError);
  });
});

describe("artifact.ts#generateTestPrintRaster — procedural test raster (research D3)", () => {
  it("produces a packed 1-bit raster at the device's fixed width, satisfying the packed invariant", () => {
    const raster = generateTestPrintRaster("2026-06-15");
    expect(raster.width).toBe(PRINT_WIDTH_DOTS);
    expect(raster.height).toBeGreaterThan(0);
    expect(raster.bits.length).toBe(Math.ceil(raster.width / 8) * raster.height);
  });

  it("height falls within the ~200-400 row envelope research D3 calls for", () => {
    const raster = generateTestPrintRaster("2026-06-15");
    expect(raster.height).toBeGreaterThanOrEqual(200);
    expect(raster.height).toBeLessThanOrEqual(400);
  });

  it("draws SOMETHING (not an all-white raster) — border/stripes/banner all burn dots", () => {
    const raster = generateTestPrintRaster("2026-06-15");
    const anyBlack = raster.bits.some((byte) => byte !== 0);
    expect(anyBlack).toBe(true);
  });

  it("VARIES per trigger date — two different dates produce different bytes", () => {
    const a = generateTestPrintRaster("2026-06-15");
    const b = generateTestPrintRaster("2026-06-16");
    expect(a.height).toBe(b.height); // same layout/height regardless of label
    expect(Buffer.from(a.bits).equals(Buffer.from(b.bits))).toBe(false);
  });

  it("never throws on an unmapped character in the date label (falls back to blank glyph)", () => {
    expect(() => generateTestPrintRaster("2026-06-1x!?")).not.toThrow();
  });
});

describe("artifact.ts#buildPayload — fetch-time conversion (FR-016/FR-017)", () => {
  it("wraps a structurally valid, device-width raster via the ESC/POS pipeline", () => {
    const height = 3;
    const bits = new Uint8Array(PRINT_BYTES_PER_ROW * height).fill(0xff);
    const wrapped = buildPayload(bits, PRINT_WIDTH_DOTS, height);
    expect(Array.from(wrapped.slice(0, 2))).toEqual([ESC, 0x40]);
    expect(wrapped.length).toBeGreaterThan(bits.length);
  });

  it("a corrupt raster (byte length != ceil(width/8)*height) is rejected with an English machine reason", () => {
    const badBits = new Uint8Array(PRINT_BYTES_PER_ROW * 3 - 1); // one byte short
    expect(() => buildPayload(badBits, PRINT_WIDTH_DOTS, 3)).toThrow(/render_failure/i);
  });

  it("a device-incompatible width (!= 576) is rejected, structurally-valid-otherwise", () => {
    const width = 384;
    const bits = new Uint8Array(Math.ceil(width / 8) * 2); // structurally valid for ITS OWN width
    expect(() => buildPayload(bits, width, 2)).toThrow(/render_failure/i);
    expect(() => buildPayload(bits, width, 2)).toThrow(/576/);
  });

  it("a FRACTIONAL height whose product with bytes-per-row is still integral is rejected — Codex P2 on #688: yL/yH bitwise-truncate a non-integer height, so the printer would silently treat the surplus bytes as commands", () => {
    // 72 (bytes/row) * 1.5 = 108 — an integral byte count that would otherwise sail through the
    // packed-invariant check even though 1.5 is not a legal row count.
    const height = 1.5;
    const bits = new Uint8Array(PRINT_BYTES_PER_ROW * height);
    expect(bits.length).toBe(108);
    expect(() => buildPayload(bits, PRINT_WIDTH_DOTS, height)).toThrow(/render_failure/i);
    expect(() => buildPayload(bits, PRINT_WIDTH_DOTS, height)).toThrow(/integer/i);
  });

  it("a FRACTIONAL width is rejected the same way", () => {
    const width = 576.5;
    const bits = new Uint8Array(Math.ceil(width / 8) * 2);
    expect(() => buildPayload(bits, width, 2)).toThrow(/render_failure/i);
    expect(() => buildPayload(bits, width, 2)).toThrow(/integer/i);
  });
});

describe("printing pipeline end-to-end — the real ESC/POS bytes", () => {
  useIsolatedDb();

  it("the full test-print pipeline transmits bytes that begin with the ESC/POS init sequence and end with the cut command", () => {
    const targetDate = todayInHouseholdTz(ANCHOR_MS);
    const trigger = enqueueTestPrint(ANCHOR_MS);
    expect(trigger.enqueued).toBe(true);
    const claimed = claimJob(ANCHOR_MS)!;

    // outputRef's format is externally observable (DTOs/events) — a 019 producer relies on it.
    expect(claimed.job.outputRef).toBe(`test-print:${targetDate}`);

    const bytes = getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

    // GS v 0's yL/yH (height, little-endian) covers the raster row count — asserting it here
    // pins the frame against the raster generator's own height, not just the fixed xL/xH width.
    const raster = generateTestPrintRaster(targetDate);
    const xL = PRINT_BYTES_PER_ROW & 0xff;
    const xH = (PRINT_BYTES_PER_ROW >> 8) & 0xff;
    const yL = raster.height & 0xff;
    const yH = (raster.height >> 8) & 0xff;
    const header = [ESC, 0x40, ESC, 0x32, GS, 0x76, 0x30, 0x00, xL, xH, yL, yH];
    expect(Array.from(bytes.slice(0, header.length))).toEqual(header);

    const trailer = [ESC, 0x64, 3, GS, 0x56, 0x00];
    expect(Array.from(bytes.slice(bytes.length - trailer.length))).toEqual(trailer);
  });

  it("the test raster VARIES per trigger date end-to-end — two different household dates transmit different bytes", () => {
    const first = enqueueTestPrint(ANCHOR_MS);
    const firstClaim = claimJob(ANCHOR_MS)!;
    const firstBytes = getPayload(firstClaim.job.id, firstClaim.leaseToken, ANCHOR_MS + 1);
    expect(first.enqueued).toBe(true);

    const second = enqueueTestPrint(ANCHOR_MS_OTHER_DAY);
    expect(second.enqueued).toBe(true); // a new household day -> a fresh record, not a dedup hit
    const secondClaim = claimJob(ANCHOR_MS_OTHER_DAY)!;
    const secondBytes = getPayload(
      secondClaim.job.id,
      secondClaim.leaseToken,
      ANCHOR_MS_OTHER_DAY + 1
    );

    expect(todayInHouseholdTz(ANCHOR_MS)).not.toBe(todayInHouseholdTz(ANCHOR_MS_OTHER_DAY));
    expect(Buffer.from(firstBytes).equals(Buffer.from(secondBytes))).toBe(false);
  });

  it("a corrupt raster (bad packed length) dead-letters the job, records an English reason, emits printing.failed, and transmits NOTHING", async () => {
    let received: CoreEventCatalog["printing.failed"] | undefined;
    subscribe("printing.failed", (payload) => {
      received = payload;
    });

    registerPrintableProvider("artifact-corrupt", () => ({
      bits: new Uint8Array(PRINT_BYTES_PER_ROW * 2 - 1), // one byte short of the packed invariant
      width: PRINT_WIDTH_DOTS,
      height: 2,
    }));
    const targetDate = todayInHouseholdTz(ANCHOR_MS);
    enqueuePrintJob(
      { recordKey: "artifact-corrupt:item", targetDate, outputRef: "artifact-corrupt:item" },
      ANCHOR_MS
    );
    const claimed = claimJob(ANCHOR_MS)!;

    expect(() => getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1)).toThrow(
      PrintRenderFailureError
    );

    const job = listJobs(ANCHOR_MS + 1).jobs.find((j) => j.id === claimed.job.id)!;
    expect(job.state).toBe("failed");
    expect(job.derivedState).toBe("dead-letter");
    expect(job.failureReason).toMatch(/^[ -~]*$/); // English/ASCII (printable) machine reason
    expect(job.failureReason).toContain("render_failure");
    expect(job.printedAt).toBeNull(); // nothing transmitted-state

    // Ack after a permanent failure is refused — no route to a false "printed" state.
    expect(() => ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 2)).toThrow();

    await flushMicrotasks();
    expect(received).toEqual({
      jobId: claimed.job.id,
      outputRef: "artifact-corrupt:item",
      errorCode: "render_failure",
    });
  });

  it("a device-incompatible raster (width != 576) dead-letters the job, absence-tolerant — never a crash", async () => {
    let received: CoreEventCatalog["printing.failed"] | undefined;
    subscribe("printing.failed", (payload) => {
      received = payload;
    });

    registerPrintableProvider("artifact-incompatible", () => ({
      bits: new Uint8Array(48 * 2), // structurally valid for width=384, NOT the device's 576
      width: 384,
      height: 2,
    }));
    const targetDate = todayInHouseholdTz(ANCHOR_MS);
    enqueuePrintJob(
      {
        recordKey: "artifact-incompatible:item",
        targetDate,
        outputRef: "artifact-incompatible:item",
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
    expect(job.printedAt).toBeNull();
    // This fixture's bits ALSO happen to satisfy the packed-length check for its own (wrong)
    // width — pinning "576" in the reason proves the DEVICE-WIDTH check fired, not the
    // packed-invariant check (the two failure modes share the same error code but not the
    // same reason text).
    expect(job.failureReason).toContain("576");

    await flushMicrotasks();
    expect(received).toEqual({
      jobId: claimed.job.id,
      outputRef: "artifact-incompatible:item",
      errorCode: "render_failure",
    });
  });

  it("a provider returning a FRACTIONAL height dead-letters the job — Codex P2 on #688 — never transmits a malformed stream", async () => {
    let received: CoreEventCatalog["printing.failed"] | undefined;
    subscribe("printing.failed", (payload) => {
      received = payload;
    });

    registerPrintableProvider("artifact-fractional", () => ({
      bits: new Uint8Array(PRINT_BYTES_PER_ROW * 1.5), // 108 bytes — integral, but height=1.5 is not
      width: PRINT_WIDTH_DOTS,
      height: 1.5,
    }));
    const targetDate = todayInHouseholdTz(ANCHOR_MS);
    enqueuePrintJob(
      { recordKey: "artifact-fractional:item", targetDate, outputRef: "artifact-fractional:item" },
      ANCHOR_MS
    );
    const claimed = claimJob(ANCHOR_MS)!;

    expect(() => getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1)).toThrow(
      PrintRenderFailureError
    );

    const job = listJobs(ANCHOR_MS + 1).jobs.find((j) => j.id === claimed.job.id)!;
    expect(job.state).toBe("failed");
    expect(job.derivedState).toBe("dead-letter");
    expect(job.failureReason).toContain("integer");
    expect(job.printedAt).toBeNull(); // nothing transmitted-state — no malformed stream went out

    await flushMicrotasks();
    expect(received).toEqual({
      jobId: claimed.job.id,
      outputRef: "artifact-fractional:item",
      errorCode: "render_failure",
    });
  });
});
