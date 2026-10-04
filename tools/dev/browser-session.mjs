#!/usr/bin/env node
/**
 * DEV-only: drive the CDP Chrome profile through gate + provision.
 * Does not put credentials in the URL. Requires npm run dev.
 * Launches the worktree Chrome CDP profile when it is not already running.
 * Density control is deferred (TODO(density)); forces comfortable localStorage.
 */
import { chromium } from "playwright";
import {
  assertFrontendReachable,
  cdpEndpoint,
  COMFORTABLE_DENSITY,
  DENSITY_STORAGE_KEY,
  ensureDevChrome,
  loadProjectEnv,
  resolveFrontendOrigin,
} from "./chrome-dev-shared.mjs";


function usage() {
  return `Usage: node tools/dev/browser-session.mjs [--origin <url>]

npm run dev:session

Uses MP_ACCESS_TOKEN and MP_BOOTSTRAP_KEY from the environment / .env.local.
Connects to CHROME_CDP_PORT (default 9222), launching Chrome when needed.
Locks density to comfortable while DensityControl is deferred.
Never enabled in production builds.
`;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} token
 */
async function passGate(page, token) {
  const form = page.getByTestId("access-gate-form");
  if ((await form.count()) === 0) return false;
  await form.locator('input[name="token"]').fill(token);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await form.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  return true;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} bootstrapKey
 */
async function provisionIfNeeded(page, bootstrapKey) {
  const button = page.getByRole("button", { name: "Provision Device" });
  try {
    await button.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    return false;
  }
  await page.getByLabel("Bootstrap key").fill(bootstrapKey);
  await button.click();
  await page.getByTestId("home-surface").waitFor({ state: "visible", timeout: 20000 });
  return true;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} origin
 */
async function pageForOrigin(context, origin) {
  const normalized = origin.replace(/\/$/, "");
  for (const page of context.pages()) {
    const url = page.url();
    if (url === "about:blank") continue;
    if (url.startsWith(normalized)) return page;
  }
  return context.newPage();
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  loadProjectEnv();
  const density = COMFORTABLE_DENSITY;
  const origin = resolveFrontendOrigin();
  await assertFrontendReachable(origin);
  const accessToken = process.env.MP_ACCESS_TOKEN?.trim();
  const bootstrapKey = process.env.MP_BOOTSTRAP_KEY?.trim();
  if (!accessToken?.startsWith("mpg-")) {
    throw new Error('MP_ACCESS_TOKEN must be set to an "mpg-…" value');
  }
  if (!bootstrapKey?.startsWith("mpk-")) {
    throw new Error('MP_BOOTSTRAP_KEY must be set to an "mpk-…" value');
  }

  const chrome = await ensureDevChrome({ url: origin });
  // System Chrome CDP rejects Playwright defaults (Browser.setDownloadBehavior).
  const browser = await chromium.connectOverCDP(cdpEndpoint(chrome.port), { noDefaults: true });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP browser has no default context");
    const page = await pageForOrigin(context, origin);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const gated = await passGate(page, accessToken);
    const provisioned = await provisionIfNeeded(page, bootstrapKey);
    await page.evaluate(
      ({ key, value }) => {
        window.localStorage.setItem(key, value);
      },
      { key: DENSITY_STORAGE_KEY, value: density }
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const applied = await page.evaluate(
      ({ key }) => ({
        stored: window.localStorage.getItem(key),
        attr: document.documentElement.getAttribute("data-density"),
      }),
      { key: DENSITY_STORAGE_KEY }
    );
    console.log(
      JSON.stringify({
        type: "session-ready",
        origin,
        density,
        chrome: chrome.reused ? "reused" : "launched",
        gateSubmitted: gated,
        provisionSubmitted: provisioned,
        storedDensity: applied.stored,
        densityAttribute: density === COMFORTABLE_DENSITY ? applied.attr : (applied.attr ?? null),
      })
    );
  } finally {
    // connectOverCDP: close disconnects only; it does not quit the user's Chrome.
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`browser-session failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
