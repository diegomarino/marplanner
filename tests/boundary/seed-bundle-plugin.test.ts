/** The production server bundle compiles the public seed profile in (MP_SEED_ON_EMPTY) and must
 * never pick up a private overlay. These tests drive the real esbuild plugin over synthetic seed
 * directories; the real `seeds/` content is covered by the seed suites.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, type Metafile, type Plugin } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_SEED_FILE } from "../../src/server/db/seeds/runner";

interface SeedBundlePluginModule {
  PUBLIC_SEED_FILE: RegExp;
  publicSeedFiles: (seedsDirectory: string) => string[];
  seedBundlePlugin: (options: { seedsDirectory: string }) => Plugin;
  assertNoPrivateInputs: (metafile: Metafile) => void;
}

const repoRoot = resolve(import.meta.dirname, "../..");
const pluginModule = (await import(
  join(repoRoot, "scripts/seed-bundle-plugin.mjs")
)) as SeedBundlePluginModule;
const PUBLIC_MODULES_ENTRY = join(repoRoot, "src/server/db/seeds/public-modules.ts");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function seedsDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "mp-seed-bundle-"));
  directories.push(directory);
  const seeds = join(directory, "seeds");
  mkdirSync(seeds);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(seeds, name), contents);
  return seeds;
}

const seedSource = (id: string) => `export default { id: ${JSON.stringify(id)}, run() {} };\n`;

async function bundle(seeds: string) {
  const result = await build({
    entryPoints: [PUBLIC_MODULES_ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    metafile: true,
    plugins: [pluginModule.seedBundlePlugin({ seedsDirectory: seeds })],
  });
  return { text: result.outputFiles[0]?.text ?? "", metafile: result.metafile };
}

describe("seed bundle plugin", () => {
  it("selects seed files with the runner's own public filename rule", () => {
    expect(pluginModule.PUBLIC_SEED_FILE.source).toBe(PUBLIC_SEED_FILE.source);
    expect(pluginModule.PUBLIC_SEED_FILE.flags).toBe(PUBLIC_SEED_FILE.flags);
  });

  it("bundles every public seed in order and leaves PRIVATE overlays out", async () => {
    const seeds = seedsDirectory({
      "seed-020-second.ts": seedSource("public:second"),
      "seed-010-first.ts": seedSource("public:first"),
      "seed-910-calendar-PRIVATE.ts": seedSource("private:SENTINEL_PRIVATE_CONTENT"),
      "README.md": "not a seed",
    });

    expect(pluginModule.publicSeedFiles(seeds)).toEqual([
      "seed-010-first.ts",
      "seed-020-second.ts",
    ]);
    const { text, metafile } = await bundle(seeds);
    expect(text.indexOf("public:first")).toBeGreaterThan(-1);
    expect(text.indexOf("public:first")).toBeLessThan(text.indexOf("public:second"));
    expect(text).not.toContain("SENTINEL_PRIVATE_CONTENT");
    expect(() => pluginModule.assertNoPrivateInputs(metafile)).not.toThrow();

    const bundled = (await import(
      `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
    )) as { bundledPublicSeedModules: () => { id: string }[] };
    expect(bundled.bundledPublicSeedModules().map((module) => module.id)).toEqual([
      "public:first",
      "public:second",
    ]);
  });

  it("refuses a lower-case private seed that would otherwise match the public rule", () => {
    const seeds = seedsDirectory({ "seed-930-private-notes.ts": seedSource("public:notes") });
    expect(() => pluginModule.publicSeedFiles(seeds)).toThrow(/Refusing to bundle private seed/);
  });

  it("fails the build when any private file reaches the bundle graph", () => {
    const metafile = {
      inputs: {
        "src/server/index.ts": { bytes: 1, imports: [] },
        "seeds/seed-910-calendar-PRIVATE.ts": { bytes: 1, imports: [] },
      },
      outputs: {},
    } as Metafile;
    expect(() => pluginModule.assertNoPrivateInputs(metafile)).toThrow(/seed-910-calendar-PRIVATE/);
  });
});
