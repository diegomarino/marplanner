// ─────────────────────────────────────────────────────────────────────
// Artifact pipeline (ADR-066).
//
// Two responsibilities:
// 1. `generateTestPrintRaster` — the procedural test-printable raster
//: a packed 1-bit, 576-wide bitmap — border frame,
// alternating stripe bands, a block-glyph "MARPLANNER TEST" banner,
// and a per-trigger date band — drawn in pure TS from a tiny
// hardcoded 5×7 bitmap-font table. Zero new dependencies; no font
// stack (that's 019's decision, per the grill).
// 2. `buildPayload` — the fetch-time conversion seam (FR-016/FR-017):
// validates the packed 1-bit invariant and the connected device's
// fixed width, then applies the pure ESC/POS wrap (escpos.ts). Both
// violations throw a plain `Error` with an English machine reason —
// never crash the caller — so `index.ts#getPayload` can catch either
// exactly like a producer-provider error and route it through the
// SAME `render_failure` permanent-failure path (FR-007: absence-
// tolerant device incompatibility, analyze E2).
//
// Source: docs/features/printing.md;
// "Validation rules" (packed 1-bit invariant);.
// ─────────────────────────────────────────────────────────────────────

import { PRINT_WIDTH_DOTS, wrapAsEscPos } from "./escpos";

// ── 5×7 bitmap font (DATA, not logic — trap-sweep row) ─────────────
//
// Each glyph is 7 rows of a 5-bit string ('1' = burn this dot). Covers
// exactly the characters the test-print banner and date band use: the
// letters in "MARPLANNER TEST", the digits, '-', ':', and space. An
// unmapped character (should never occur given the callers below) falls
// back to the blank glyph rather than throwing — the raster generator is
// never allowed to crash the caller.

const BLANK_GLYPH: readonly string[] = [
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
];

const FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  " ": BLANK_GLYPH,
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

const GLYPH_COLS = 5;
const GLYPH_ROWS = 7;
const GLYPH_SPACING = 1;

/** The test-print banner text. Every character MUST resolve in FONT_5X7. */
const BANNER_TEXT = "MARPLANNER TEST";

// ── Raw packed 1-bit raster (row-major, MSB-first) ───────────────────────

export interface RawRaster {
  bits: Uint8Array;
  width: number;
  height: number;
}

/** `Math.ceil(width / 8)` — the packed-1-bit bytes-per-row for an arbitrary width. */
function bytesPerRowFor(width: number): number {
  return Math.ceil(width / 8);
}

/** Set (burn) the pixel at (x, y) to black. Out-of-bounds writes are silently ignored. */
function setPixel(bits: Uint8Array, width: number, height: number, x: number, y: number): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const rowBytes = bytesPerRowFor(width);
  const byteIndex = y * rowBytes + (x >> 3);
  const bitMask = 0x80 >> (x & 7);
  bits[byteIndex] |= bitMask;
}

/** Fill an inclusive rectangle solid black. Used for the border frame and stripe bands. */
function fillRect(
  bits: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): void {
  for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      setPixel(bits, width, height, x, y);
    }
  }
}

/** Width in px a string renders to at the given integer scale (DATA-driven — see FONT_5X7). */
function measureText(text: string, scale: number): number {
  const glyphWidth = GLYPH_COLS * scale;
  const spacing = GLYPH_SPACING * scale;
  if (text.length === 0) return 0;
  return text.length * glyphWidth + (text.length - 1) * spacing;
}

/** Draw a single scaled 5×7 glyph with its top-left corner at (x0, y0). */
function drawGlyph(
  bits: Uint8Array,
  width: number,
  height: number,
  ch: string,
  x0: number,
  y0: number,
  scale: number
): void {
  const glyph = FONT_5X7[ch] ?? BLANK_GLYPH;
  for (let row = 0; row < GLYPH_ROWS; row++) {
    const rowBits = glyph[row];
    for (let col = 0; col < GLYPH_COLS; col++) {
      if (rowBits[col] !== "1") continue;
      fillRect(
        bits,
        width,
        height,
        x0 + col * scale,
        y0 + row * scale,
        x0 + col * scale + scale - 1,
        y0 + row * scale + scale - 1
      );
    }
  }
}

/** Draw a scaled text string, left edge at (x0, y0). Unmapped characters render blank. */
function drawText(
  bits: Uint8Array,
  width: number,
  height: number,
  text: string,
  x0: number,
  y0: number,
  scale: number
): void {
  const glyphWidth = GLYPH_COLS * scale;
  const spacing = GLYPH_SPACING * scale;
  let x = x0;
  for (const ch of text) {
    drawGlyph(bits, width, height, ch, x, y0, scale);
    x += glyphWidth + spacing;
  }
}

/** Center `textWidth` px of content within `containerWidth`, clamped to a non-negative offset. */
function centeredX(containerWidth: number, textWidth: number): number {
  return Math.max(0, Math.floor((containerWidth - textWidth) / 2));
}

/** The procedural test-print raster: a packed 1-bit, device-width (576) bitmap —
 * border frame, alternating stripe bands, the "MARPLANNER TEST" banner, and a per-trigger date
 * band — rendered ~200-400 rows tall. `dateLabel` (the trigger's household-local date, e.g.
 * "2026-09-07") is rendered verbatim in the date band, which is what makes the raster VARY per
 * trigger date (an unmapped character in an unexpected label falls back to blank — never throws).
 */
export function generateTestPrintRaster(dateLabel: string): RawRaster {
  const width = PRINT_WIDTH_DOTS;

  const BORDER_THICKNESS = 4;
  const STRIPE_BAND_HEIGHT = 11; // tuned so total height clears the ~200-400 row floor
  const STRIPE_BAND_COUNT = 6;
  const GAP = 20;
  const BANNER_SCALE = 6;
  const DATE_SCALE = 4;
  const BANNER_HEIGHT = GLYPH_ROWS * BANNER_SCALE;
  const DATE_HEIGHT = GLYPH_ROWS * DATE_SCALE;

  const stripesHeight = STRIPE_BAND_HEIGHT * STRIPE_BAND_COUNT;
  const height =
    BORDER_THICKNESS + // top border
    stripesHeight +
    GAP +
    BANNER_HEIGHT +
    GAP +
    DATE_HEIGHT +
    GAP +
    BORDER_THICKNESS; // bottom border

  const bits = new Uint8Array(bytesPerRowFor(width) * height);

  // Border frame — top/bottom solid bands, left/right solid columns spanning the full height.
  fillRect(bits, width, height, 0, 0, width - 1, BORDER_THICKNESS - 1);
  fillRect(bits, width, height, 0, height - BORDER_THICKNESS, width - 1, height - 1);
  fillRect(bits, width, height, 0, 0, BORDER_THICKNESS - 1, height - 1);
  fillRect(bits, width, height, width - BORDER_THICKNESS, 0, width - 1, height - 1);

  // Alternating stripe bands, directly under the top border.
  let y = BORDER_THICKNESS;
  for (let band = 0; band < STRIPE_BAND_COUNT; band++) {
    if (band % 2 === 0) {
      fillRect(bits, width, height, 0, y, width - 1, y + STRIPE_BAND_HEIGHT - 1);
    }
    y += STRIPE_BAND_HEIGHT;
  }

  // Banner: "MARPLANNER TEST", centered.
  y += GAP;
  const bannerWidth = measureText(BANNER_TEXT, BANNER_SCALE);
  drawText(bits, width, height, BANNER_TEXT, centeredX(width, bannerWidth), y, BANNER_SCALE);
  y += BANNER_HEIGHT;

  // Date/sequence band: the trigger date, centered.
  y += GAP;
  const dateWidth = measureText(dateLabel, DATE_SCALE);
  drawText(bits, width, height, dateLabel, centeredX(width, dateWidth), y, DATE_SCALE);

  return { bits, width, height };
}

// ── Fetch-time conversion (FR-016/FR-017) ────────────────────────────────

/** The fetch-time artifact conversion seam every producer's raster flows through (FR-016: the
 * entire pipeline runs server-side; FR-017: conversion failures surface at fetch time, recorded
 * on the job, never at enqueue). Validates the packed 1-bit invariant ("Validation
 * rules": `bytes.length === ceil(width/8) * height`) THEN the device's fixed width (576) — both
 * failure modes throw a plain `Error` with an English machine reason, never a crash: the caller
 * (`index.ts#getPayload`) catches this exactly like a provider error and routes it through the
 * SAME `render_failure` permanent-failure path (FR-007, analyze E2 — a device-incompatible raster
 * is an absence-tolerant condition, not a process crash). Only once all checks pass does this
 * apply the pure ESC/POS wrap (escpos.ts).
 * checks BOTH dimensions are integers >= 1 BEFORE the packed-invariant check —
 * a fractional height (e.g. 1.5) can have an INTEGRAL product with bytes-per-row (72 * 1.5 = 108),
 * so the packed-invariant check alone would let it through. `wrapAsEscPos`'s `GS v 0` yL/yH encode
 * the height via `heightPx & 0xff`/`(heightPx >> 8) & 0xff` — bitwise operators coerce their operand
 * with ToInt32, which TRUNCATES a fractional value, so the printer would decode a shorter height
 * than the byte stream actually carries and treat the surplus raster bytes as ESC/POS commands.
 * This guard belongs HERE, at the seam boundary, and not inside the ported `wrapAsEscPos` itself
 * (escpos.ts) — v1 never needed it because its own callers always passed integer dimensions; this
 * module is the one seam that accepts arbitrary (producer-supplied) dimensions, so it is the one
 * that must not trust them.
 */
export function buildPayload(bits: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(
      `render_failure: raster height ${height} is not a whole number of rows (an integer >= 1 ` +
        `is required — a fractional row count truncates in the GS v 0 yL/yH encoding)`
    );
  }
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(
      `render_failure: raster width ${width} is not a whole number of dots (an integer >= 1 ` +
        `is required — a fractional width truncates in the GS v 0 xL/xH encoding)`
    );
  }
  const expectedBytes = bytesPerRowFor(width) * height;
  if (bits.length !== expectedBytes) {
    throw new Error(
      `render_failure: raster byte length ${bits.length} does not satisfy the packed 1-bit ` +
        `invariant ceil(width/8)*height = ${expectedBytes} (width=${width}, height=${height})`
    );
  }
  if (width !== PRINT_WIDTH_DOTS) {
    throw new Error(
      `render_failure: raster width ${width} is incompatible with the connected device ` +
        `(requires ${PRINT_WIDTH_DOTS})`
    );
  }
  // width === PRINT_WIDTH_DOTS here, so the packed-invariant check above already guarantees
  // bits.length === PRINT_BYTES_PER_ROW * height — the exact precondition escpos.ts's own
  // wrapAsEscPos re-checks (belt and suspenders, not a second decision point).
  return wrapAsEscPos(bits, height);
}
