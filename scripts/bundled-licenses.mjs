/** Licence notices for third-party code inlined into a build output. esbuild and Vite copy
 * dependency code into the bundle without the packages' licence files, so every build writes a
 * THIRD_PARTY_LICENSES.txt beside its output with each bundled package's declared licence and
 * the licence/notice texts that package ships (THIRD_PARTY_NOTICES.md → Dependencies).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const NOTICE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const STYLESHEET = /\.(css|less|sass|scss|styl|stylus|pcss|postcss)(\?|$)/;
const BARE_CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;

/** The package directory owning `modulePath`, or null for first-party code. */
function packageDirectory(modulePath) {
  const normalized = path.resolve(modulePath.replace(/^\0/, "").split("?")[0]);
  const parts = normalized.split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index === -1 || index + 1 >= parts.length) return null;
  const length = parts[index + 1].startsWith("@") ? 2 : 1;
  return parts.slice(0, index + 1 + length).join(path.sep);
}

/** The installed directory of package `name` as seen from `fromDirectory`, or null. */
function installedPackage(fromDirectory, name) {
  for (let directory = fromDirectory; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(directory) === directory) return null;
  }
}

/** Packages a first-party stylesheet pulls in with a bare `@import "<package>"`. CSS tools such
 * as Tailwind inline those imports themselves, so they never reach the module graph. */
function importedStylesheetPackages(code, importer) {
  const directories = [];
  for (const [, specifier] of code.matchAll(BARE_CSS_IMPORT)) {
    if (/^([./]|[a-z][a-z0-9+.-]*:)/i.test(specifier)) continue;
    const segments = specifier.split("/");
    const name = segments.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    const directory = installedPackage(path.dirname(importer), name);
    if (directory) directories.push(path.join(directory, "package.json"));
  }
  return directories;
}

/** One entry per bundled package (name@version), sorted by name, from the bundle's inputs. */
export function bundledPackages(modulePaths) {
  const packages = new Map();
  for (const modulePath of modulePaths) {
    const directory = packageDirectory(modulePath);
    if (!directory || !existsSync(path.join(directory, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) continue;
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? "UNKNOWN (no license field)");
    const texts = readdirSync(directory)
      .filter((name) => NOTICE_FILE.test(name))
      .sort()
      .map((name) => ({ name, text: readFileSync(path.join(directory, name), "utf8").trim() }));
    const repository =
      typeof manifest.repository === "string"
        ? manifest.repository
        : (manifest.repository?.url ?? manifest.homepage ?? null);
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license,
      repository,
      texts,
    });
  }
  return [...packages.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1
  );
}

/** The notice file text for `packages`. */
export function renderLicenses(title, packages) {
  const lines = [
    `${title}`,
    "",
    "Third-party packages whose code is included in this bundle, with the licence each declares",
    "and the licence and notice files it ships. Marplanner's own code is under the MIT License",
    "(LICENSE); other bundled assets are listed in THIRD_PARTY_NOTICES.md.",
    "",
  ];
  for (const pkg of packages) {
    lines.push("=".repeat(78), `${pkg.name} ${pkg.version} — ${pkg.license}`, "=".repeat(78));
    if (pkg.repository) lines.push(`Source: ${pkg.repository}`);
    if (pkg.texts.length === 0) {
      lines.push(`(The package ships no licence file; it declares ${pkg.license}.)`, "");
      continue;
    }
    for (const { name, text } of pkg.texts) lines.push(`--- ${name} ---`, text, "");
  }
  return `${lines.join("\n")}\n`;
}

export function writeLicenses(file, title, modulePaths) {
  const packages = bundledPackages(modulePaths);
  writeFileSync(file, renderLicenses(title, packages));
  return packages;
}

/** Vite/Rollup plugin: emit THIRD_PARTY_LICENSES.txt for the packages in the client bundle,
 * counting rendered JavaScript, stylesheets in the module graph and packages that first-party
 * stylesheets `@import` (their CSS is emitted even though no JavaScript is rendered for it). */
export function bundledLicensesPlugin() {
  const stylesheetImports = new Set();
  return {
    name: "marplanner-bundled-licenses",
    apply: "build",
    enforce: "pre",
    transform: {
      order: "pre",
      handler(code, id) {
        if (!STYLESHEET.test(id) || packageDirectory(id)) return null;
        for (const file of importedStylesheetPackages(code, id)) stylesheetImports.add(file);
        return null;
      },
    },
    generateBundle(_options, bundle) {
      const modulePaths = [...stylesheetImports];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, info] of Object.entries(output.modules)) {
          if (info.renderedLength > 0) modulePaths.push(id);
        }
      }
      for (const id of this.getModuleIds?.() ?? []) {
        if (STYLESHEET.test(id)) modulePaths.push(id);
      }
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_LICENSES.txt",
        source: renderLicenses(
          "Marplanner client bundle — third-party licences",
          bundledPackages(modulePaths)
        ),
      });
    },
  };
}
