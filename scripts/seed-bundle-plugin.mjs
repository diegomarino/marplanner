/** esbuild plugin that compiles the public seed profile into the server bundle, so
 * `MP_SEED_ON_EMPTY` works in a production image that has neither `seeds/` nor tsx.
 *
 * The seeds must share the server's bundle: a separately bundled seed would get its own copy
 * of the `getDb()` singleton, open a second connection and deadlock against the runner's
 * `BEGIN IMMEDIATE` transaction. Private overlays (`*-PRIVATE*`) are never bundled; the build
 * fails if one would be.
 */
import { readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

/** Mirrors PUBLIC_SEED_FILE in src/server/db/seeds/runner.ts (a boundary test compares them). */
export const PUBLIC_SEED_FILE = /^seed-\d{3}-[a-z0-9][a-z0-9-]*\.(?:[cm]?[jt]s?)$/;
const PRIVATE_MARKER = /private/i;
const PUBLIC_MODULES_FILE = /[\\/]src[\\/]server[\\/]db[\\/]seeds[\\/]public-modules\.ts$/;

/** Public seed filenames in `seedsDirectory`, sorted the way the runner orders discovery. */
export function publicSeedFiles(seedsDirectory) {
  return readdirSync(seedsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PUBLIC_SEED_FILE.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      if (PRIVATE_MARKER.test(name)) throw new Error(`Refusing to bundle private seed: ${name}`);
      return true;
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Source that replaces `public-modules.ts`: one static import per public seed. */
export function publicModulesSource(seedsDirectory, resolveDir) {
  const files = publicSeedFiles(seedsDirectory);
  const imports = files.map((name, index) => {
    const path = relative(resolveDir, resolve(seedsDirectory, name)).replaceAll("\\", "/");
    return `import seed${index} from ${JSON.stringify(path.startsWith(".") ? path : `./${path}`)};`;
  });
  const list = files.map((_, index) => `seed${index}`).join(", ");
  return `${imports.join("\n")}\nexport function bundledPublicSeedModules() { return [${list}]; }\n`;
}

export function seedBundlePlugin({ seedsDirectory = resolve("seeds") } = {}) {
  return {
    name: "marplanner-public-seeds",
    setup(build) {
      build.onLoad({ filter: PUBLIC_MODULES_FILE }, (args) => {
        const resolveDir = resolve(args.path, "..");
        return {
          contents: publicModulesSource(seedsDirectory, resolveDir),
          loader: "ts",
          resolveDir,
          watchFiles: [seedsDirectory],
        };
      });
    },
  };
}

/** Throws when any bundled repository file is named private. Only file names are checked, so a
 * checkout under a directory such as macOS's `/private/var` is fine. Needs `metafile: true`.
 */
export function assertNoPrivateInputs(metafile) {
  const leaked = Object.keys(metafile.inputs).filter(
    (input) => !input.includes("node_modules") && PRIVATE_MARKER.test(basename(input))
  );
  if (leaked.length > 0) {
    throw new Error(`Private files reached the server bundle: ${leaked.join(", ")}`);
  }
}
