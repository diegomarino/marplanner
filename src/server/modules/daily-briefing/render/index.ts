// Render layer barrel — the single entry point both
// `../index.ts` (production wiring) and `tools/dev/smoke-dist-render.mjs`
// (the dist-mode ESM/asset-path smoke) import through. Bundled
// standalone to `dist/daily-briefing-render/index.js` by
// `scripts/build-server.mjs` for exactly that smoke.
export { renderBriefingBitmap } from "./bridge";
export type { RenderBridgeResult } from "./bridge";
export {
  pngToPackedRaster,
  RASTER_WIDTH_DOTS,
  RASTER_BYTES_PER_ROW,
  RasterWidthError,
} from "./raster";
export type { PackedRaster } from "./raster";
export type { RenderBlockInput, RenderEnvelope } from "./types";
