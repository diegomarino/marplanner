import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("local server and seed scripts load the optional local environment", () => {
  assert.equal(
    packageJson.scripts["dev:server"],
    "node --env-file-if-exists=.env.local --import tsx --watch src/server/index.ts"
  );
  assert.equal(
    packageJson.scripts.start,
    "node --env-file-if-exists=.env.local dist/server/index.js"
  );
  assert.equal(
    packageJson.scripts["seed:public"],
    "node --env-file-if-exists=.env.local --import tsx src/server/db/seeds/cli.ts --mode public"
  );
  assert.equal(
    packageJson.scripts["seed:private"],
    "node --env-file-if-exists=.env.local --import tsx src/server/db/seeds/cli.ts --mode private"
  );
  assert.equal(packageJson.scripts["seed:all"], "npm run seed:public && npm run seed:private");
  assert.equal(packageJson.scripts.seed, "npm run seed:all");
  assert.equal(packageJson.scripts["seed:sync-private"], "node tools/dev/sync-private-seeds.mjs");
  assert.equal(packageJson.scripts["dev:fresh"], "node tools/dev/fresh-local.mjs");
});



test("chrome CDP session helper scripts are wired for local development", () => {
  assert.equal(packageJson.scripts["dev:chrome"], "node tools/dev/chrome-cdp.mjs");
  assert.equal(
    packageJson.scripts["dev:session-desktop"],
    "node tools/dev/browser-session.mjs --density=comfortable"
  );
  assert.equal(
    packageJson.scripts["dev:session-dense"],
    "node tools/dev/browser-session.mjs --density=kiosk"
  );
  assert.equal(packageJson.scripts["dev:session-reset"], "node tools/dev/browser-reset.mjs");
});


test("the committed example documents credentials and defaults the local UI bypass off", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const keys = example
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")));

  assert.match(example, /^VITE_DEV_BYPASS_ADMIN_PIN=0$/m);
  for (const key of [
    "MP_ACCESS_TOKEN",
    "MP_BOOTSTRAP_KEY",
    "ADMIN_PIN",
    "VITE_DEV_BYPASS_ADMIN_PIN",
    "HOST",
    "PORT",
    "WEB_PORT",
    "DATA_DIR",
    "DATABASE_PATH",
  ])
    assert.ok(keys.includes(key), `Missing documented setting ${key}`);
  assert.match(example, /# CHROME_CDP_PORT=9222/);
  assert.match(example, /# CHROME_USER_DATA_DIR=\.data\/chrome-cdp/);
  assert.match(example, /^PORT=0$/m);
  assert.match(example, /^WEB_PORT=0$/m);
  assert.match(example, /^DATA_DIR=\.data$/m);
  assert.match(example, /^HOST=127\.0\.0\.1$/m);
});

test("the populated local environment remains gitignored", () => {
  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.env\.local$/m);
  assert.match(gitignore, /^\.data\/$/m);
  assert.match(gitignore, /^\.data-fresh\/$/m);
});

test("vite dev server ignores local data and chrome profile paths", () => {
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /watch\s*:\s*\{/);
  assert.match(vite, /\*\*\/\.data\/\*\*/);
  assert.match(vite, /chrome-cdp/);

  const launcher = readFileSync(new URL("../tools/dev/start-local.mjs", import.meta.url), "utf8");
  assert.match(launcher, /watch\s*:\s*\{/);
  assert.match(launcher, /\*\*\/\.data\/\*\*/);
  assert.match(launcher, /chrome-cdp/);
});

