/** Bundle the server outside the public client root. Native modules remain external
 * and resolve from node_modules at runtime. Both server and standalone render builds
 * receive the same fonts, Noto emoji SVGs and license beside their module-relative loader.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { resolveBuildInfo } from "./build-info.mjs";
import { assertNoPrivateInputs, seedBundlePlugin } from "./seed-bundle-plugin.mjs";
import { writeLicenses } from "./bundled-licenses.mjs";

const RESVG_EXTERNALS = ["@resvg/resvg-js", "@resvg/resvg-wasm"];
const NATIVE_EXTERNALS = ["argon2", "better-sqlite3", ...RESVG_EXTERNALS];
// ESM-output shim: some bundled CJS deps reference require; provide it.
const REQUIRE_SHIM_BANNER = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
};

const server = await build({
  entryPoints: ["src/server/index.ts"],
  // OUTSIDE the served client root (dist/client/) so the bundle can never be
  // downloaded via the static server (backend source must not be served).
  outfile: "dist/server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: NATIVE_EXTERNALS,
  banner: REQUIRE_SHIM_BANNER,
  // The admin overview compares this with the commit stamped into the client bundle.
  define: { __MP_BUILD__: JSON.stringify(resolveBuildInfo()) },
  // Public seeds for MP_SEED_ON_EMPTY; see the plugin for why they share this bundle.
  plugins: [seedBundlePlugin()],
  metafile: true,
});
assertNoPrivateInputs(server.metafile);
// Bundled dependency code travels without its packages' licence files: write them beside it.
writeLicenses(
  "dist/server/THIRD_PARTY_LICENSES.txt",
  "Marplanner server bundle — third-party licences",
  Object.keys(server.metafile.outputs["dist/server/index.js"].inputs)
);

mkdirSync("dist/server/fonts/jetbrains-mono", { recursive: true });
cpSync(
  "src/server/modules/daily-briefing/render/fonts/jetbrains-mono",
  "dist/server/fonts/jetbrains-mono",
  { recursive: true }
);
// Noto emoji SVGs for `images` reminders: reminder validation and the printed briefing read
// them from disk beside the bundle (src/server/lib/noto-emoji.ts, render/emoji-images.ts).
cpSync("src/shared/noto", "dist/server/noto", { recursive: true });
// The corpora are inlined into the bundle; their third-party data notice travels with it.
cpSync("src/server/modules/daily-briefing/corpora/NOTICE.txt", "dist/server/CORPORA-NOTICE.txt");
// Access-gate HTML inlines the same semantic tokens the SPA imports.
cpSync("src/client/styles/tokens.css", "dist/server/ui-tokens.css");

console.log("server bundled → dist/server/index.js (+ fonts/jetbrains-mono, noto, ui-tokens.css)");

// Operator credential CLI, shipped beside the server so a container can run it.
await build({
  entryPoints: ["src/server/auth/devices-cli.ts"],
  outfile: "dist/server/devices.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: NATIVE_EXTERNALS,
  banner: REQUIRE_SHIM_BANNER,
});
console.log("device credential CLI bundled → dist/server/devices.js");

// Separate entry for the built renderer smoke.
const render = await build({
  entryPoints: ["src/server/modules/daily-briefing/render/index.ts"],
  outfile: "dist/daily-briefing-render/index.js",
  metafile: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: RESVG_EXTERNALS,
  banner: REQUIRE_SHIM_BANNER,
});
mkdirSync("dist/daily-briefing-render/fonts/jetbrains-mono", { recursive: true });
cpSync(
  "src/server/modules/daily-briefing/render/fonts/jetbrains-mono",
  "dist/daily-briefing-render/fonts/jetbrains-mono",
  { recursive: true }
);
cpSync("src/shared/noto", "dist/daily-briefing-render/noto", { recursive: true });

writeLicenses(
  "dist/daily-briefing-render/THIRD_PARTY_LICENSES.txt",
  "Marplanner briefing render bundle — third-party licences",
  Object.keys(render.metafile.outputs["dist/daily-briefing-render/index.js"].inputs)
);

console.log("daily-briefing render module bundled → dist/daily-briefing-render/index.js");
