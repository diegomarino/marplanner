#!/usr/bin/env node

/**
 * generate-noto-emojis.mjs
 *
 * Vendors the Noto Emoji SVGs referenced by the chores emoji catalog into
 * src/client/chores/noto/ so NotoEmoji can bundle them via Vite without any
 * network access at build or CI time (mirrors the generate/--check pattern
 * used by generate-member-colors.mjs).
 *
 * SOURCE: GitHub release https://github.com/googlefonts/noto-emoji (v2.051).
 *         The tarball is downloaded once into tools/dev/.noto-emoji-cache/
 *         (gitignored). Delete that directory to force a re-download.
 *
 * Run: npm run generate:noto-emojis
 *      npm run check:noto-emojis   (verifies no drift, exit 1 on mismatch)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULT_CATALOG_PATH = join(ROOT, "src/client/chores/emoji-catalog.ts");
const DEFAULT_VENDOR_DIR = join(ROOT, "src/client/chores/noto");
const DEFAULT_CACHE_DIR = join(ROOT, "tools/dev/.noto-emoji-cache");

const NOTO_VERSION = "v2.051";
const NOTO_TARBALL_URL = `https://github.com/googlefonts/noto-emoji/archive/refs/tags/${NOTO_VERSION}.tar.gz`;

const VARIATION_SELECTOR_16 = 0xfe0f;

// ─── Pure logic (tested directly) ──────────────────────────────────────────

export function parseEmojisFromCatalog(source) {
  const seen = new Set();
  const emojis = [];
  for (const match of source.matchAll(/emoji:\s*"([^"]+)"/g)) {
    const emoji = match[1];
    if (!seen.has(emoji)) {
      seen.add(emoji);
      emojis.push(emoji);
    }
  }
  if (emojis.length === 0) {
    throw new Error("No emoji entries found in catalog source");
  }
  return emojis;
}

export function emojiToCodepoint(emoji) {
  return [...emoji]
    .map((char) => char.codePointAt(0) ?? 0)
    .filter((codePoint) => codePoint !== VARIATION_SELECTOR_16)
    .map((codePoint) => codePoint.toString(16))
    .join("_");
}

export function notoFilename(codepoint) {
  return `emoji_u${codepoint}.svg`;
}

export function computeSyncPlan({ emojis, vendoredFiles }) {
  const expected = new Set(emojis.map((emoji) => notoFilename(emojiToCodepoint(emoji))));
  const vendored = new Set(vendoredFiles);
  const missing = emojis.filter((emoji) => !vendored.has(notoFilename(emojiToCodepoint(emoji))));
  const orphaned = vendoredFiles.filter((file) => !expected.has(file));
  return { missing, orphaned };
}

// ─── Download & cache (not exercised by unit tests) ────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolvePromise, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (targetUrl) => {
      https
        .get(targetUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            if (!res.headers.location) {
              reject(new Error("Redirect with no Location header"));
              return;
            }
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolvePromise()));
          file.on("error", reject);
        })
        .on("error", reject);
    };
    request(url);
  });
}

async function ensureNotoSvgSource(cacheDir) {
  const svgDir = join(cacheDir, "svg");
  if (fs.existsSync(svgDir) && fs.readdirSync(svgDir).length > 100) {
    return svgDir;
  }

  const tarball = join(cacheDir, `noto-emoji-${NOTO_VERSION}.tar.gz`);
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`⬇️  Downloading Noto Emoji ${NOTO_VERSION}…`);
  await downloadFile(NOTO_TARBALL_URL, tarball);
  console.log("📦 Extracting SVGs…");
  fs.mkdirSync(svgDir, { recursive: true });
  execSync(
    `tar -xzf "${tarball}" --strip-components=2 -C "${svgDir}" "noto-emoji-${NOTO_VERSION.replace("v", "")}/svg"`,
    { stdio: "inherit" }
  );
  return svgDir;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    check: false,
    catalog: DEFAULT_CATALOG_PATH,
    vendorDir: DEFAULT_VENDOR_DIR,
    cacheDir: DEFAULT_CACHE_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--catalog") options.catalog = argv[++i];
    else if (arg === "--vendor-dir") options.vendorDir = argv[++i];
    else if (arg === "--cache-dir") options.cacheDir = argv[++i];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalogSource = fs.readFileSync(options.catalog, "utf8");
  const emojis = parseEmojisFromCatalog(catalogSource);

  fs.mkdirSync(options.vendorDir, { recursive: true });
  const vendoredFiles = fs.readdirSync(options.vendorDir).filter((file) => file.endsWith(".svg"));

  if (options.check) {
    const { missing, orphaned } = computeSyncPlan({ emojis, vendoredFiles });
    if (missing.length === 0 && orphaned.length === 0) {
      console.log(`✅ ${emojis.length} catalog emojis are in sync with ${options.vendorDir}`);
      return;
    }
    if (missing.length > 0) {
      console.error(
        `❌ Missing vendored SVGs for: ${missing
          .map((emoji) => `${emoji} (${notoFilename(emojiToCodepoint(emoji))})`)
          .join(", ")}`
      );
    }
    if (orphaned.length > 0) {
      console.error(`❌ Orphaned vendored SVGs no longer in the catalog: ${orphaned.join(", ")}`);
    }
    console.error(`Run: npm run generate:noto-emojis`);
    process.exitCode = 1;
    return;
  }

  const svgDir = await ensureNotoSvgSource(options.cacheDir);
  let copied = 0;
  let missing = 0;
  for (const emoji of emojis) {
    const filename = notoFilename(emojiToCodepoint(emoji));
    const override = join(ROOT, "tools/dev/noto-overrides", filename);
    const src = fs.existsSync(override) ? override : join(svgDir, filename);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠️  Missing from Noto source: ${emoji} → ${filename}`);
      missing++;
      continue;
    }
    fs.copyFileSync(src, join(options.vendorDir, filename));
    copied++;
  }

  for (const file of vendoredFiles) {
    const stillReferenced = emojis.some((emoji) => notoFilename(emojiToCodepoint(emoji)) === file);
    if (!stillReferenced) {
      fs.rmSync(join(options.vendorDir, file));
      console.log(`  🗑️  Removed orphaned ${file}`);
    }
  }

  console.log(`✅ Vendored emojis: ${copied} copied, ${missing} missing from Noto source`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("❌", err.message);
    process.exitCode = 1;
  });
}
