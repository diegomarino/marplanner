#!/usr/bin/env node
// Run after npm run build. Compare the production bundle's fonts and license
// byte-for-byte, then render and pack a fixture through the standalone render bundle.
// The latter exercises the same renderer but does not invoke the server entrypoint.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distEntry = path.join(repoRoot, "dist/daily-briefing-render/index.js");
const mainBundleFontsDir = path.join(repoRoot, "dist/server/fonts/jetbrains-mono");
const sourceFontsDir = path.join(
  repoRoot,
  "src/server/modules/daily-briefing/render/fonts/jetbrains-mono"
);

function fail(message, cause) {
  console.error(`smoke-dist-render: FAIL — ${message}`);
  if (cause !== undefined) console.error(cause);
  process.exit(1);
}

// 1. Main-bundle font layout — the layout production actually runs.
if (!existsSync(mainBundleFontsDir)) {
  fail(
    `${mainBundleFontsDir} does not exist. Run "npm run build" first, and check scripts/build-server.mjs still copies fonts alongside dist/server/index.js.`
  );
}
const sourceFontFiles = readdirSync(sourceFontsDir).filter((f) => f.endsWith(".ttf"));
if (sourceFontFiles.length === 0) {
  fail(`${sourceFontsDir} has no .ttf files — the source fonts/ directory itself looks wrong.`);
}
for (const file of [...sourceFontFiles, "OFL.txt"]) {
  const mainBundlePath = path.join(mainBundleFontsDir, file);
  if (!existsSync(mainBundlePath)) {
    fail(`${mainBundlePath} is missing — dist/server/index.js would fail to load this font.`);
  }
  if (!readFileSync(path.join(sourceFontsDir, file)).equals(readFileSync(mainBundlePath))) {
    fail(`${mainBundlePath} differs from the source asset.`);
  }
}
console.log(
  `smoke-dist-render: main-bundle font layout OK — ${sourceFontFiles.length} font(s) present at dist/server/fonts/jetbrains-mono, byte-identical to source.`
);

if (!existsSync(distEntry)) {
  fail(
    `${distEntry} does not exist. Run "npm run build" first (this smoke never builds anything itself).`
  );
}

let mod;
try {
  mod = await import(pathToFileURL(distEntry).href);
} catch (err) {
  fail(`could not import the built render entry at ${distEntry}`, err);
}

const fixtureEnvelope = {
  memberId: "smoke-member",
  memberName: "Smoke Test",
  date: "2026-09-08",
  blocks: [{ type: "message", title: "MESSAGE", data: { text: "dist-mode render smoke" } }],
};

let rendered;
try {
  rendered = await mod.renderBriefingBitmap(fixtureEnvelope);
} catch (err) {
  fail("renderBriefingBitmap threw instead of returning a null-bitmap result", err);
}

if (rendered.bitmapPng === null) {
  fail("renderBriefingBitmap returned a null bitmap — a catastrophic render/timeout occurred");
}
if (rendered.failedRenderBlocks.length > 0) {
  fail(
    `the fixture's single "message" block failed to render: ${JSON.stringify(rendered.failedRenderBlocks)}`
  );
}
if (typeof rendered.bitmapHeight !== "number" || rendered.bitmapHeight <= 0) {
  fail(`bitmapHeight must be a positive number, got ${String(rendered.bitmapHeight)}`);
}

let packed;
try {
  packed = mod.pngToPackedRaster(rendered.bitmapPng);
} catch (err) {
  fail("pngToPackedRaster threw on the rendered PNG", err);
}

if (packed.bits.length !== mod.RASTER_BYTES_PER_ROW * packed.height) {
  fail(
    `packed raster length ${packed.bits.length} != RASTER_BYTES_PER_ROW(${mod.RASTER_BYTES_PER_ROW}) * height(${packed.height})`
  );
}
if (!packed.bits.some((byte) => byte !== 0)) {
  fail("packed raster is entirely blank — the fixture text produced no ink");
}

console.log(
  `smoke-dist-render: OK — rendered ${rendered.bitmapHeight}px, packed ${packed.bits.length} bytes (${mod.RASTER_BYTES_PER_ROW} bytes/row).`
);
process.exit(0);
