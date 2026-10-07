import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  computeSyncPlan,
  emojiToCodepoint,
  notoFilename,
  parseEmojisFromCatalog,
} from "./dev/generate-noto-emojis.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR_PATH = join(ROOT, "tools/dev/generate-noto-emojis.mjs");

test("parseEmojisFromCatalog extracts unique emoji literals in first-seen order", () => {
  const source = `
    { emoji: "🌅", label: "Sunrise" },
    { emoji: "🌙", label: "Night" },
    { emoji: "🌅", label: "Duplicate sunrise" },
  `;
  assert.deepEqual(parseEmojisFromCatalog(source), ["🌅", "🌙"]);
});

test("parseEmojisFromCatalog throws when the catalog has no emoji entries", () => {
  assert.throws(() => parseEmojisFromCatalog("export const EMOJI_CATEGORIES = [];"));
});

test("emojiToCodepoint converts a single-codepoint emoji to lowercase hex", () => {
  assert.equal(emojiToCodepoint("🌅"), "1f305");
});

test("emojiToCodepoint strips the FE0F variation selector", () => {
  assert.equal(emojiToCodepoint("🛏️"), "1f6cf");
});

test("notoFilename builds the Noto SVG filename for a codepoint", () => {
  assert.equal(notoFilename("1f305"), "emoji_u1f305.svg");
});

test("computeSyncPlan reports catalog emojis missing a vendored file", () => {
  const plan = computeSyncPlan({
    emojis: ["🌅", "🌙"],
    vendoredFiles: ["emoji_u1f305.svg"],
  });
  assert.deepEqual(plan.missing, ["🌙"]);
  assert.deepEqual(plan.orphaned, []);
});

test("computeSyncPlan reports vendored files no longer referenced by the catalog", () => {
  const plan = computeSyncPlan({
    emojis: ["🌅"],
    vendoredFiles: ["emoji_u1f305.svg", "emoji_u1f6cf.svg"],
  });
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.orphaned, ["emoji_u1f6cf.svg"]);
});

test("--check exits non-zero when the vendored directory drifts from the catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noto-check-"));
  try {
    const catalogPath = join(dir, "emoji-catalog.ts");
    const vendorDir = join(dir, "noto");
    const cacheDir = join(dir, "cache");
    await mkdir(vendorDir, { recursive: true });
    await writeFile(catalogPath, `{ emoji: "🌅", label: "Sunrise" },`);

    const run = () =>
      spawnSync(
        process.execPath,
        [
          GENERATOR_PATH,
          "--check",
          "--catalog",
          catalogPath,
          "--vendor-dir",
          vendorDir,
          "--cache-dir",
          cacheDir,
        ],
        { encoding: "utf8" }
      );

    const drifted = run();
    assert.equal(drifted.status, 1);
    assert.match(drifted.stdout + drifted.stderr, /1f305/);

    await writeFile(join(vendorDir, "emoji_u1f305.svg"), "<svg></svg>");
    const clean = run();
    assert.equal(clean.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation preserves the custom blonde ponytail override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noto-override-"));
  try {
    const catalogPath = join(dir, "catalog.ts");
    const vendorDir = join(dir, "vendor");
    const cacheDir = join(dir, "cache");
    const svgDir = join(cacheDir, "svg");
    await mkdir(svgDir, { recursive: true });
    await writeFile(catalogPath, '{ emoji: "👱‍♀️" },');
    for (let i = 0; i < 101; i++) await writeFile(join(svgDir, `${i}.svg`), "<svg/>");
    await writeFile(join(svgDir, "emoji_u1f471_200d_2640.svg"), "<svg>upstream</svg>");
    const run = spawnSync(
      process.execPath,
      [
        GENERATOR_PATH,
        "--catalog",
        catalogPath,
        "--vendor-dir",
        vendorDir,
        "--cache-dir",
        cacheDir,
      ],
      { encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      await readFile(join(vendorDir, "emoji_u1f471_200d_2640.svg")),
      await readFile(join(ROOT, "tools/dev/noto-overrides/emoji_u1f471_200d_2640.svg"))
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
