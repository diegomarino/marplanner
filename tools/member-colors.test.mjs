import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PALETTE_PATH = join(ROOT, "tools/dev/member-colors.json");
const GENERATOR_PATH = join(ROOT, "tools/dev/generate-member-colors.mjs");
const GENERATED_PATH = join(ROOT, "src/client/styles/member-colors.generated.css");

const EXPECTED_PALETTE = [
  { key: "blue", name: "blue", base500: { l: 0.48, c: 0.19, h: 262 } },
  { key: "sky", name: "sky", base500: { l: 0.64, c: 0.13, h: 232 } },
  { key: "teal", name: "teal", base500: { l: 0.6, c: 0.1, h: 195 } },
  { key: "green", name: "green", base500: { l: 0.5, c: 0.14, h: 155 } },
  { key: "lime", name: "lime", base500: { l: 0.6, c: 0.17, h: 128 } },
  { key: "amber", name: "amber", base500: { l: 0.62, c: 0.13, h: 85 } },
  { key: "orange", name: "orange", base500: { l: 0.65, c: 0.17, h: 52 } },
  { key: "red", name: "red", base500: { l: 0.56, c: 0.21, h: 25 } },
  { key: "pink", name: "pink", base500: { l: 0.6, c: 0.21, h: 350 } },
  { key: "violet", name: "violet", base500: { l: 0.56, c: 0.21, h: 298 } },
];

// The reference scale for a 0.58 base. Every colour keeps its own 500 and spreads the other
// shades towards the same two ends in these proportions.
const REFERENCE_LIGHTNESS = new Map([
  [100, 0.93],
  [200, 0.87],
  [300, 0.78],
  [400, 0.68],
  [500, 0.58],
  [600, 0.5],
  [700, 0.42],
  [800, 0.35],
  [900, 0.28],
]);

function expectedLightness(base, step) {
  const reference = REFERENCE_LIGHTNESS.get(step);
  const scaled =
    reference >= 0.58
      ? base + ((reference - 0.58) * (0.93 - base)) / (0.93 - 0.58)
      : base - ((0.58 - reference) * (base - 0.28)) / (0.58 - 0.28);
  return Math.round(scaled * 1000) / 1000;
}

const EXPECTED_FOREGROUND_OKLCH = {
  blue: "1 0 0",
  sky: "0 0 0",
  teal: "0 0 0",
  green: "1 0 0",
  lime: "0 0 0",
  amber: "0 0 0",
  orange: "0 0 0",
  red: "1 0 0",
  pink: "0 0 0",
  violet: "1 0 0",
};

function runGenerator(...args) {
  return spawnSync(process.execPath, [GENERATOR_PATH, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

async function findCssImports(directory) {
  const imports = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      imports.push(...(await findCssImports(path)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/g)) {
      imports.push({ file: relative(ROOT, path), target: match[1] });
    }
  }
  return imports;
}

test("palette source is exactly the approved ten base-500 OKLCH references", async () => {
  const palette = JSON.parse(await readFile(PALETTE_PATH, "utf8"));
  assert.deepEqual(palette, EXPECTED_PALETTE);
});

test("generator emits a deterministic complete 100-900 scale for every key", async () => {
  const palette = JSON.parse(await readFile(PALETTE_PATH, "utf8"));
  const { generateMemberColorsCss } = await import("./dev/generate-member-colors.mjs");
  const first = generateMemberColorsCss(palette);
  const second = generateMemberColorsCss(palette);
  const checkedIn = await readFile(GENERATED_PATH, "utf8");

  assert.equal(second, first);
  assert.equal(checkedIn, first);

  const scaleTokens = [...first.matchAll(/--color-member-([a-z]+)-(\d{3}): oklch\(([^)]+)\);/g)];
  assert.equal(scaleTokens.length, 90);

  for (const entry of EXPECTED_PALETTE) {
    for (const step of REFERENCE_LIGHTNESS.keys()) {
      const token = scaleTokens.find(
        ([, key, actualStep]) => key === entry.key && Number(actualStep) === step
      );
      assert.ok(token, `missing --color-member-${entry.key}-${step}`);
      const [l, c, h] = token[3].split(/\s+/).map(Number);
      assert.deepEqual(
        { l, c, h },
        { l: expectedLightness(entry.base500.l, step), c: entry.base500.c, h: entry.base500.h },
        `unexpected --color-member-${entry.key}-${step}`
      );
    }
  }
});

test("generated base shades match the reviewed foreground outcome for every key", async () => {
  const css = await readFile(GENERATED_PATH, "utf8");
  const foregrounds = Object.fromEntries(
    [...css.matchAll(/--color-member-([a-z]+)-foreground: oklch\(([^)]+)\);/g)].map(
      ([, key, value]) => [key, value]
    )
  );
  assert.deepEqual(foregrounds, EXPECTED_FOREGROUND_OKLCH);
});

test("globals.css is the single generated-stylesheet import site", async () => {
  const imports = (await findCssImports(join(ROOT, "src/client"))).filter(
    ({ target }) => target === "./member-colors.generated.css"
  );
  assert.deepEqual(imports, [
    {
      file: "src/client/styles/globals.css",
      target: "./member-colors.generated.css",
    },
  ]);
});

test("package exposes a named member-colour drift command inside check:fast", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["check:member-colors"],
    "node tools/dev/generate-member-colors.mjs --check"
  );
  assert.match(packageJson.scripts["check:fast"], /npm run check:member-colors/);
});

test("check mode detects generated stylesheet drift and restores cleanly", async () => {
  const original = await readFile(GENERATED_PATH, "utf8");
  const clean = runGenerator("--check");
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);

  try {
    await writeFile(GENERATED_PATH, `${original}\n/* synthetic drift */\n`, "utf8");
    const drifted = runGenerator("--check");
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /member-colors\.generated\.css.*drift/i);
  } finally {
    await writeFile(GENERATED_PATH, original, "utf8");
  }

  const restored = runGenerator("--check");
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
});
