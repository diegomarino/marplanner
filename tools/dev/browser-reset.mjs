#!/usr/bin/env node
/**
 * DEV-only: clear cookies + web storage for the Marplanner origin in the CDP Chrome profile
 * so gate/provision/density can be exercised again from a clean browser state.
 * Launches the worktree Chrome CDP profile when it is not already running.
 */
import { chromium } from "playwright";
import {
  assertFrontendReachable,
  cdpEndpoint,
  ensureDevChrome,
  loadProjectEnv,
  resolveFrontendOrigin,
} from "./chrome-dev-shared.mjs";

function usage() {
  return `Usage: node tools/dev/browser-reset.mjs [--origin <frontend-url>]

Clears HttpOnly auth cookies, mp_provisioned, localStorage and sessionStorage for the
frontend origin inside the CHROME_CDP_PORT profile. Does not delete the Chrome profile dir.

npm run dev:session-reset
`;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  loadProjectEnv();
  const origin = resolveFrontendOrigin();
  await assertFrontendReachable(origin);
  const chrome = await ensureDevChrome({ url: origin });

  // System Chrome CDP rejects Playwright defaults (Browser.setDownloadBehavior).
  const browser = await chromium.connectOverCDP(cdpEndpoint(chrome.port), { noDefaults: true });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP browser has no default context");
    const before = await context.cookies(origin);
    // Drop every cookie in this CDP profile. The profile is worktree-local DEV state.
    await context.clearCookies();
    const page =
      context.pages().find((p) => p.url().startsWith(origin.replace(/\/$/, ""))) ??
      (await context.newPage());
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      try {
        window.localStorage.clear();
      } catch {
        // ignore
      }
      try {
        window.sessionStorage.clear();
      } catch {
        // ignore
      }
    });
    // Navigate once more so a stale in-memory SPA state cannot keep provisioned UI.
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const afterCookies = await context.cookies(origin);
    const storage = await page.evaluate(() => ({
      local: { ...window.localStorage },
      sessionKeys: Object.keys(window.sessionStorage),
    }));
    console.log(
      JSON.stringify({
        type: "session-reset",
        origin,
        chrome: chrome.reused ? "reused" : "launched",
        cookiesRemoved: before.length,
        cookiesRemaining: afterCookies.length,
        localStorageKeys: Object.keys(storage.local),
        sessionStorageKeys: storage.sessionKeys,
      })
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`browser-reset failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
