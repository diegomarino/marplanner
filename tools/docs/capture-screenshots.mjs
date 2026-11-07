#!/usr/bin/env node
/* global window, document, PopStateEvent */
/**
 * DOCS-only: capture the feature screenshots used by README.md and docs/guide/.
 *
 * Seeds the PUBLIC Simpsons demo (never the private overlays) into a throwaway
 * DATA_DIR, boots the built server against a local weather/quote fixture, and
 * drives Chromium through the gate, provisioning and the admin PIN.
 *
 *   npm run build && npm run docs:screenshots
 *   npm run docs:screenshots -- --only home,meals   # subset by shot-name prefix
 *   npm run docs:screenshots -- --explore           # print data-testids per page
 *
 * Output: docs/images/features/<shot>.png (1.5x DPR, kiosk viewport 1280x800).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT_DIR = join(ROOT, "docs/images/features");
const PORT = Number(process.env.MP_DOCS_PORT ?? "43901");
const FIXTURE_PORT = Number(process.env.MP_DOCS_FIXTURE_PORT ?? "43902");
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;
const ACCESS_TOKEN = "mpg-docs-screenshots";
const BOOTSTRAP_KEY = "mpk-docs-screenshots";
const MP_ADMIN_PIN = "1234";
const VIEWPORT = { width: 1280, height: 800 };

const args = process.argv.slice(2);
const explore = args.includes("--explore");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") && onlyArg ? onlyArg.split(",") : null;

/** CSS y of the last black block-title band of a briefing slip image that starts above
 * `limit`, so a partial capture ends between two blocks instead of inside one. */
async function lastBlockBandAbove(image, limit) {
  return image.evaluate((img, max) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const scale = img.naturalHeight / img.clientHeight;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const darkShare = (y) => {
      let dark = 0;
      for (let x = 0; x < canvas.width; x += 4)
        if (data[(y * canvas.width + x) * 4] < 60) dark += 1;
      return dark / Math.ceil(canvas.width / 4);
    };
    // A band starts where a nearly all-black row follows a nearly blank one; rows of the
    // band's own white title text never count as blank.
    let cut = max;
    for (let y = 1; y < Math.min(canvas.height, max * scale); y += 1) {
      if (darkShare(y) > 0.9 && darkShare(y - 1) < 0.1) cut = y / scale;
    }
    return cut;
  }, limit);
}

/** Open-Meteo / zenquotes / onthisday stand-in with plausible autumn values, so
 * screenshots never depend on real egress or live weather. */
function startFixture() {
  const server = http.createServer((req, res) => {
    const now = Date.now();
    const hours = Array.from({ length: 48 }, (_, i) =>
      new Date(now + (i - 12) * 3_600_000).toISOString().slice(0, 13).concat(":00")
    );
    const days = Array.from({ length: 7 }, (_, i) =>
      new Date(now + i * 86_400_000).toISOString().slice(0, 10)
    );
    let body;
    if (req.url?.includes("forecast")) {
      body = {
        latitude: 39.78,
        longitude: -89.65,
        timezone: "UTC",
        current: { time: hours[12], temperature_2m: 18, weather_code: 2 },
        hourly: {
          time: hours,
          temperature_2m: hours.map((_, i) => 14 + Math.round(5 * Math.sin(i / 4))),
          precipitation_probability: hours.map((_, i) => (i % 6) * 5),
          weather_code: hours.map((_, i) => [0, 1, 2, 3, 2][i % 5]),
        },
        daily: {
          time: days,
          weather_code: [2, 0, 61, 3, 1, 0, 80],
          temperature_2m_max: [21, 23, 17, 19, 22, 24, 18],
          temperature_2m_min: [11, 12, 10, 9, 12, 13, 11],
          precipitation_probability_max: [10, 0, 70, 30, 10, 0, 60],
        },
      };
    } else if (req.url?.includes("onthisday")) {
      body = {
        events: [{ year: 1989, text: "The Simpsons premieres as a half-hour series." }],
        births: [],
        deaths: [],
      };
    } else {
      body = [{ q: "The secret of getting ahead is getting started.", a: "Mark Twain" }];
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  return new Promise((ok) => server.listen(FIXTURE_PORT, "127.0.0.1", () => ok(server)));
}

function run(command, commandArgs, env) {
  return new Promise((ok, fail) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, env, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${command} exited ${code}`))));
  });
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server did not become healthy");
}

async function enterKiosk(page) {
  await page.goto(BASE);
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await page.getByTestId("home-surface").waitFor({ timeout: 20_000 });
}

/** Mirrors tests/e2e/admin-unlock.ts: 3 s long-press, then the touch keypad. */
async function unlockAdmin(page) {
  if (new URL(page.url()).pathname.startsWith("/admin")) return;
  const adminButton = page.getByTestId("admin-affordance");
  if (!(await adminButton.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /options|opciones/i }).click();
  }
  await adminButton.waitFor({ timeout: 15_000 });
  await adminButton.hover();
  await page.mouse.down();
  try {
    await page.waitForURL((url) => url.pathname === "/admin", { timeout: 6_000 });
  } finally {
    await page.mouse.up();
  }
  await page.getByTestId("admin-pin-keypad").waitFor({ timeout: 15_000 });
  for (const digit of MP_ADMIN_PIN) await page.getByTestId(`admin-pin-digit-${digit}`).click();
  await page.getByTestId("admin-pin-unlock").click();
  await page.getByTestId("admin-pin-keypad").waitFor({ state: "detached", timeout: 15_000 });
}

/** In-app navigation keeps the unlocked admin session (a full reload would re-lock). */
async function navigate(page, path) {
  if (new URL(page.url()).pathname === path) return;
  await page.evaluate((p) => {
    window.history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForURL((url) => url.pathname === path);
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

/** Opens the briefing preview tab and generates the first member's slip when needed. */
async function generateBriefingPreview(p) {
  const management = p.getByTestId("daily-briefing-management");
  await management.getByTestId("daily-briefing-tab-preview").click();
  await management.locator('[data-testid^="daily-briefing-member-pill-"]').first().click();
  const generate = management.getByTestId("daily-briefing-generate");
  if (await generate.isEnabled().catch(() => false)) await generate.click();
  await management.getByTestId("daily-briefing-admin-preview-image").waitFor({ timeout: 20_000 });
}

/**
 * Shot list. `route` is visited in-app (`url` is a full page load outside the SPA); `admin` unlocks first; `crop` is a locator
 * factory for element screenshots (omit for a viewport capture); `maxHeight` keeps only the
 * crop's top, and `cutAtBlockBand` moves that cut up to the last slip block boundary; `prepare`
 * runs interactions before the capture.
 */
const SHOTS = [
  // 1. Home
  { name: "home-dashboard", route: "/" },
  { name: "home-agenda", route: "/", crop: (p) => p.getByTestId("home-agenda-region") },
  { name: "home-chores", route: "/", crop: (p) => p.getByTestId("home-chores-region") },
  { name: "home-meals", route: "/", crop: (p) => p.getByTestId("home-meals-region") },
  { name: "home-weather-pill", route: "/", crop: (p) => p.getByTestId("weather-pill") },
  // 2. Routines & chores
  { name: "chores-board", route: "/chores" },
  {
    name: "chores-column",
    route: "/chores",
    crop: (p) => p.locator('[data-testid^="chores-board-column-"]').first(),
  },
  {
    name: "admin-routines",
    route: "/admin/routines",
    admin: true,
    prepare: async (p) => {
      await p.getByTestId("routines-management").getByText("Morning launch").first().click();
    },
  },
  // 3. Meals & recipes
  { name: "meals-board", route: "/meals" },
  { name: "meals-plan-grid", route: "/meals", crop: (p) => p.getByTestId("meal-plan-grid") },
  { name: "meals-recipes", route: "/meals", crop: (p) => p.getByTestId("recipe-catalogue") },
  { name: "admin-meals", route: "/admin/meals", admin: true },
  // 4. Daily briefing + printing
  { name: "admin-daily-briefing", route: "/admin/daily-briefing", admin: true },
  {
    name: "briefing-preview",
    route: "/admin/daily-briefing",
    admin: true,
    prepare: generateBriefingPreview,
    crop: (p) => p.getByTestId("daily-briefing-admin-preview-image"),
  },
  {
    name: "briefing-preview-top",
    route: "/admin/daily-briefing",
    admin: true,
    prepare: generateBriefingPreview,
    crop: (p) => p.getByTestId("daily-briefing-admin-preview-image"),
    maxHeight: 720,
    cutAtBlockBand: true,
  },
  { name: "admin-printing", route: "/admin/printing", admin: true },
  // 5. Calendar
  { name: "calendar-month", route: "/calendar" },
  {
    name: "calendar-week",
    route: "/calendar",
    prepare: async (p) => {
      await p.getByRole("button", { name: "Week", exact: true }).click();
    },
  },
  { name: "admin-calendar", route: "/admin/calendar", admin: true },
  // 6. Reminders & daily messages
  { name: "admin-reminders", route: "/admin/reminders", admin: true },
  { name: "admin-daily-messages", route: "/admin/daily-messages", admin: true },
  // 7. Time announcements
  { name: "admin-time-announcements", route: "/admin/time-announcements", admin: true },
  // Operator
  { name: "admin-overview", route: "/admin", admin: true },
  { name: "admin-members", route: "/admin/members", admin: true },
  { name: "admin-plugins", route: "/admin/plugins", admin: true },
  {
    name: "admin-backups",
    route: "/admin/backups",
    admin: true,
    prepare: async (p) => {
      await p.getByRole("button", { name: "Snapshot now" }).click();
      await p.waitForTimeout(1_500);
    },
  },
  { name: "admin-settings", route: "/admin/settings", admin: true },
  // 15. API-first: the generated reference served by the app itself
  { name: "api-reference", url: "/api/docs/" },
];

/** Spanish variants to show i18n; switched through the stored household language. */
const SPANISH = ["home-dashboard", "meals-board"];

async function setLanguage(language) {
  const res = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: deviceCookie },
    body: JSON.stringify({
      object: "locale",
      settings: { timezone: "Europe/Madrid", language, weekStartDay: 1 },
    }),
  });
  if (!res.ok) throw new Error(`locale switch failed: ${res.status} ${await res.text()}`);
}

let deviceCookie = "";

async function capture(context, shots, suffix = "") {
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId("home-surface").waitFor({ timeout: 20_000 });
  for (const shot of shots) {
    if (only && !only.some((prefix) => shot.name.startsWith(prefix))) continue;
    const file = join(OUT_DIR, `${shot.name}${suffix}.png`);
    try {
      if (shot.url) {
        await page.goto(BASE + shot.url);
        await settle(page);
        await page.waitForTimeout(1_500);
        await page.screenshot({ path: file, animations: "disabled" });
        console.log(`✓ ${shot.name}${suffix}`);
        await page.goto(BASE);
        await page.getByTestId("home-surface").waitFor({ timeout: 20_000 });
        continue;
      }
      if (shot.admin) await unlockAdmin(page);
      else if (new URL(page.url()).pathname.startsWith("/admin")) {
        await page.goto(BASE + shot.route);
      }
      await navigate(page, shot.route);
      await settle(page);
      if (shot.prepare) await shot.prepare(page);
      await settle(page);
      if (explore) {
        const ids = await page.$$eval("[data-testid]", (els) => [
          ...new Set(els.map((e) => e.getAttribute("data-testid"))),
        ]);
        console.log(`\n# ${shot.name} ${shot.route}\n${ids.join(" ")}`);
      }
      if (shot.crop && shot.maxHeight) {
        // boundingBox() is viewport-relative, so bring the target's top to the viewport top
        // and clip the viewport capture; a fullPage clip would be offset by the scroll.
        await shot.crop(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
        const box = await shot.crop(page).boundingBox();
        if (!box) throw new Error("crop target not visible");
        let height = Math.min(box.height, shot.maxHeight);
        if (shot.cutAtBlockBand) height = await lastBlockBandAbove(shot.crop(page), height);
        const clip = { ...box, height };
        await page.screenshot({ path: file, clip, animations: "disabled" });
      } else if (shot.crop) {
        await shot.crop(page).screenshot({ path: file, animations: "disabled" });
      } else await page.screenshot({ path: file, animations: "disabled" });
      console.log(`✓ ${shot.name}${suffix}`);
    } catch (error) {
      console.error(`✗ ${shot.name}${suffix}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
      await page.goto(BASE).catch(() => undefined);
    }
  }
  await page.close();
}

async function main() {
  if (!existsSync(join(ROOT, "dist/server/index.js"))) {
    throw new Error("dist/ is missing: run `npm run build` first");
  }
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), "marplanner-docs-"));
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    PORT: String(PORT),
    MP_ACCESS_TOKEN: ACCESS_TOKEN,
    MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
    MP_ADMIN_PIN,
    WEATHER_ENDPOINT: FIXTURE,
    QUOTE_ENDPOINT: FIXTURE,
    ONTHISDAY_ENDPOINT: FIXTURE,
    SCHEDULER_DISABLED: "1",
  };
  // Storage overrides would point the seed and the backups shot at real data, so pin
  // every storage path inside the throwaway directory.
  env.BACKUPS_ROOT = join(dataDir, "backups");
  delete env.DATABASE_PATH;
  delete env.BASE_PATH;
  delete env.MP_SEED_ON_EMPTY;
  delete env.MP_MANAGEMENT_KEY;

  const fixture = await startFixture();
  let server;
  let browser;
  try {
    // Public profile only: private `*-PRIVATE.*` overlays never reach the docs.
    await run(
      process.execPath,
      ["--import", "tsx", "src/server/db/seeds/cli.ts", "--mode", "public"],
      env
    );
    server = spawn(process.execPath, ["dist/server/index.js"], { cwd: ROOT, env, stdio: "ignore" });
    await waitForHealth();

    browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}
    );
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1.5,
      locale: "en-US",
      timezoneId: "Europe/Madrid",
      colorScheme: "light",
    });
    const page = await context.newPage();
    await enterKiosk(page);
    deviceCookie = (await context.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
    await page.close();

    await capture(context, SHOTS);
    if (!explore) {
      await setLanguage("es");
      await capture(
        context,
        SHOTS.filter((s) => SPANISH.includes(s.name)),
        "-es"
      );
      await setLanguage("en");
    }
  } finally {
    await browser?.close();
    server?.kill("SIGTERM");
    fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
