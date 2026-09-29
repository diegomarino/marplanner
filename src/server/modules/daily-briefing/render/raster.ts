// ─────────────────────────────────────────────────────────────────────
// PNG -> packed 1-bit raster converter.
//
// D2 PROBE (Constitution XIV, empirically executed against a REAL
// pressedslip-rendered PNG — see tests/boundary/daily-briefing-render-probe
//.test.ts): `PNG.sync.read` normalizes pressedslip's 1-bit output PNG to
// 8-bit RGBA (`data.length === width * height * 4`), fully opaque
// (alpha === 255 throughout), with R/G/B each taking exactly the two values
// 0 (black) or 255 (white) — pressedslip's 1-bit threshold already collapsed
// the image, pngjs just re-expands it to RGBA on decode. This confirms the
// assumption and is what `pngToPackedRaster` below relies on.
//
// Packing semantics MATCH v1's browser-side `imageDataToMonoBitmap`
// (apps/web/src/lib/printer/png-to-bitmap.ts) exactly, MINUS scaling: v1
// scales an arbitrary-width source image down to PRINT_WIDTH_DOTS; this
// converter runs server-side on pressedslip's OWN output, which is already
// rendered at exactly 576px (RenderOptions.width defaults to PAPER.thermal80)
// — so instead of scaling, this converter ASSERTS the width and rejects any
// other value (a render-time misconfiguration should fail loudly, not
// silently reproject).
// ─────────────────────────────────────────────────────────────────────
import { PNG } from "pngjs";

/** Printable width in dots — matches printing/escpos.ts's PRINT_WIDTH_DOTS (576, 80mm thermal). */
export const RASTER_WIDTH_DOTS = 576;

/** Packed bytes per row at RASTER_WIDTH_DOTS, 8 pixels per byte, MSB-first. */
export const RASTER_BYTES_PER_ROW = RASTER_WIDTH_DOTS / 8;

export class RasterWidthError extends Error {
  constructor(actualWidth: number) {
    super(
      `daily-briefing raster: PNG width ${actualWidth} != required ${RASTER_WIDTH_DOTS} ` +
        `(RenderOptions.width must resolve to PAPER.thermal80)`
    );
    this.name = "RasterWidthError";
  }
}

export interface PackedRaster {
  bits: Uint8Array;
  height: number;
}

/** Decode a 1-bit PNG (pressedslip's `Rendering.bytes`) and pack it into a
 * row-major, MSB-first, 1-bit-per-pixel bitmap — exactly
 * RASTER_BYTES_PER_ROW bytes per row, `height` rows (from the PNG itself).
 * Luma < 128 (alpha-blended onto white, matching v1's browser-side
 * semantics) becomes a set (black) bit. Throws `RasterWidthError` if the
 * decoded width isn't exactly RASTER_WIDTH_DOTS — never silently rescales.
 */
export function pngToPackedRaster(pngBytes: Uint8Array): PackedRaster {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  if (png.width !== RASTER_WIDTH_DOTS) {
    throw new RasterWidthError(png.width);
  }

  const { height, data } = png;
  const bits = new Uint8Array(RASTER_BYTES_PER_ROW * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < RASTER_WIDTH_DOTS; x += 1) {
      const px = (y * png.width + x) * 4;
      const a = data[px + 3] / 255;
      const r = data[px] * a + 255 * (1 - a);
      const g = data[px + 1] * a + 255 * (1 - a);
      const b = data[px + 2] * a + 255 * (1 - a);
      const luma = (r + g + b) / 3;
      if (luma < 128) {
        const byteIdx = y * RASTER_BYTES_PER_ROW + (x >> 3);
        const bit = 7 - (x & 7);
        bits[byteIdx] |= 1 << bit;
      }
    }
  }

  return { bits, height };
}
