import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";


const root = resolve(import.meta.dirname, "..");
const freshScript = join(root, "tools/dev/fresh-local.mjs");

function runFresh(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [freshScript, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => done({ code, out }));
  });
}

test("dev:fresh refuses wiping the default .data playground without force", async () => {
  const result = await runFresh(["--data-dir", ".data"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Refusing to wipe the default playground/);
});

test("dev:fresh --help documents public and private seed then dev", async () => {
  const result = await runFresh(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /seed:public/);
  assert.match(result.out, /seed:private/);
});

test("package scripts expose seed as seed:all of public and private", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["seed:public"]?.includes("--mode public"), true);
  assert.equal(packageJson.scripts["seed:private"]?.includes("--mode private"), true);
  assert.equal(packageJson.scripts["seed:all"], "npm run seed:public && npm run seed:private");
  assert.equal(packageJson.scripts.seed, "npm run seed:all");
  assert.equal(packageJson.scripts["dev:fresh"], "node tools/dev/fresh-local.mjs");
  assert.equal(existsSync(freshScript), true);
});



