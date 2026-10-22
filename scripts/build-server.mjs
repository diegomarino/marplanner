/** Bundle the server outside the public client root. Native modules remain external
 * and resolve from node_modules at runtime. Both server and standalone render builds
 * receive the same fonts and license beside their module-relative loader.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { resolveBuildInfo } from "./build-info.mjs";
import { assertNoPrivateInputs, seedBundlePlugin } from "./seed-bundle-plugin.mjs";

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

mkdirSync("dist/server/fonts/jetbrains-mono", { recursive: true });
cpSync(
  "src/server/modules/daily-briefing/render/fonts/jetbrains-mono",
  "dist/server/fonts/jetbrains-mono",
  { recursive: true }
);
// Access-gate HTML inlines the same semantic tokens the SPA imports.
cpSync("src/client/styles/tokens.css", "dist/server/ui-tokens.css");

console.log("server bundled → dist/server/index.js (+ fonts/jetbrains-mono, ui-tokens.css)");

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
await build({
  entryPoints: ["src/server/modules/daily-briefing/render/index.ts"],
  outfile: "dist/daily-briefing-render/index.js",
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

console.log("daily-briefing render module bundled → dist/daily-briefing-render/index.js");
