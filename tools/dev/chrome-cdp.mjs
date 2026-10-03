#!/usr/bin/env node
/**
 * DEV-only: launch or reuse a dedicated Chromium profile with a fixed CDP port.
 * Shares CHROME_CDP_PORT / CHROME_USER_DATA_DIR / CHROME_BIN with session helpers.
 */
import {
  ensureChromeCdp,
  loadProjectEnv,
  readLocalReady,
  resolveCdpPort,
  resolveChromeBin,
  resolveChromeUserDataDir,
  resolveDataDir,
  resolveFrontendOrigin,
} from "./chrome-dev-shared.mjs";

function usage() {
  return `Usage: node tools/dev/chrome-cdp.mjs [--origin <frontend-url>]

Launches (or reuses) a worktree-local Chrome/Chromium profile with
--remote-debugging-port=$CHROME_CDP_PORT so session helpers can target it.

Environment (.env.local):
  CHROME_CDP_PORT          default 9222
  CHROME_USER_DATA_DIR     default .data/chrome-cdp
  CHROME_BIN               optional absolute browser binary
  FRONTEND_URL / --origin  optional page to open (else local-ready.json)
`;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  loadProjectEnv();
  const port = resolveCdpPort();
  if (port == null) throw new Error("CHROME_CDP_PORT is required");
  const userDataDir = resolveChromeUserDataDir();
  const bin = resolveChromeBin();
  let url;
  try {
    url = resolveFrontendOrigin(process.argv.slice(2), resolveDataDir());
  } catch {
    const ready = readLocalReady();
    url = ready?.frontend;
  }
  const result = await ensureChromeCdp({ port, userDataDir, bin, url });
  const mode = result.reused ? "reused" : "launched";
  console.log(`Chrome CDP ${mode} on ${port}`);
  console.log(`Profile: ${userDataDir}`);
  if (url) console.log(`Origin:  ${url}`);
  console.log(`Endpoint: http://127.0.0.1:${port}`);
}

main().catch((error) => {
  console.error(`dev:chrome failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
