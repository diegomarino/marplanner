// ─────────────────────────────────────────────────────────────────────
// ESC/POS byte-stream wrap — server-side (ADR-066).
//
// A PURE, faithful port of v1's `packages/shared/src/print/escpos.ts`
// `wrapAsEscPos` — v1-proven against the exact 80 mm thermal printer this
// module targets. Per the trap-sweep row: "improvements" here are
// the trap; this is deliberately verbatim-modulo-style, not a redesign.
// ADR-066 records WHY the wrap now runs on the server instead of the
// (v1) frontend — the byte format itself is unchanged.
//
// Source: v1 `packages/shared/src/print/escpos.ts`.
//
// Format reference (all values are raw bytes) — copied from the v1 file:
//
// 1B 40 ESC @ initialise
// 1B 32 ESC 2 default line spacing
// 1D 76 30 m xL xH yL yH … GS v 0 raster bit image
// m = 0 (normal scale)
// xL/xH = bytes-per-row, little endian
// yL/yH = rows (= height in px), little endian
// data = (xL|xH<<8) * (yL|yH<<8) bytes,
// MSB-first, row-major, 1 = black
// 1B 64 n ESC d n feed n lines
// 1D 56 00 GS V 0 full cut
// ─────────────────────────────────────────────────────────────────────

/** Printable area of a standard 80 mm thermal printer at 203 dpi. */
export const PRINT_WIDTH_DOTS = 576;

/** Bytes per row when the bitmap is packed 8 pixels per byte, MSB-first. */
export const PRINT_BYTES_PER_ROW = PRINT_WIDTH_DOTS / 8;

/** ESC/POS command bytes used in this module (v1-identical). */
const ESC = 0x1b;
const GS = 0x1d;

export interface WrapAsEscPosOptions {
  /** Number of blank lines fed after the raster, before the cut.
   * Defaults to 3 — enough for the cutter to clear the printed area.
   */
  feedLines?: number;
  /** Whether to issue a full cut at the end of the job. Set to `false` when
   * chaining multiple jobs into the same paper segment.
   */
  cut?: boolean;
}

/** Wrap a 1-bit bitmap in the ESC/POS byte stream this printer eats.
 * @param monoBitmap Packed bitmap, length = {@link PRINT_BYTES_PER_ROW} * `heightPx`.
 * Each byte holds 8 horizontal pixels, MSB on the left.
 * Bit value 1 means "burn this dot" (black).
 * @param heightPx Number of pixel rows. Must be ≤ 65 535 (the GS v 0 limit).
 * @param options Optional feed/cut tweaks.
 * @returns Byte stream ready to write to the printer socket.
 * @throws RangeError if the bitmap length does not match `bytesPerRow * heightPx`,
 * or if `heightPx` exceeds the GS v 0 row limit.
 */
export function wrapAsEscPos(
  monoBitmap: Uint8Array,
  heightPx: number,
  options: WrapAsEscPosOptions = {}
): Uint8Array {
  const { feedLines = 3, cut = true } = options;

  if (heightPx <= 0 || heightPx > 0xffff) {
    throw new RangeError(`heightPx must be in 1..65535, got ${heightPx}`);
  }
  const expectedBytes = PRINT_BYTES_PER_ROW * heightPx;
  if (monoBitmap.length !== expectedBytes) {
    throw new RangeError(
      `bitmap length ${monoBitmap.length} ≠ expected ${expectedBytes} (${PRINT_BYTES_PER_ROW} × ${heightPx})`
    );
  }
  if (feedLines < 0 || feedLines > 0xff) {
    throw new RangeError(`feedLines must be in 0..255, got ${feedLines}`);
  }

  const xL = PRINT_BYTES_PER_ROW & 0xff;
  const xH = (PRINT_BYTES_PER_ROW >> 8) & 0xff;
  const yL = heightPx & 0xff;
  const yH = (heightPx >> 8) & 0xff;

  const header = Uint8Array.from([
    ESC,
    0x40, // ESC @ — initialise
    ESC,
    0x32, // ESC 2 — default line spacing
    GS,
    0x76,
    0x30,
    0x00, // GS v 0, m = 0 (normal)
    xL,
    xH,
    yL,
    yH,
  ]);
  const trailer = Uint8Array.from([
    ESC,
    0x64,
    feedLines, // ESC d n — feed n lines
    ...(cut ? [GS, 0x56, 0x00] : []), // GS V 0 — full cut
  ]);

  const out = new Uint8Array(header.length + monoBitmap.length + trailer.length);
  out.set(header, 0);
  out.set(monoBitmap, header.length);
  out.set(trailer, header.length + monoBitmap.length);
  return out;
}
