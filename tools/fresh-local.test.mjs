import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const freshScript = join(root, "tools/dev/fresh-local.mjs");

function runFresh(args, env = {}, script = freshScript, cwd = root) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => done({ code, out }));
  });
}

/** A throwaway project copy whose ROOT is the fixture, with a no-op `npm` first on PATH,
 * so the deletion guard runs for real without ever pointing at this checkout. */
function makeFixture(t) {
  // The project sits one level inside a sacrificial parent, so even an unguarded `..`
  // can only ever reach that parent, never the shared system temp directory.
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "mp-fresh-")));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const fixture = join(sandbox, "project");
  mkdirSync(fixture);
  mkdirSync(join(fixture, "tools/dev"), { recursive: true });
  const script = join(fixture, "tools/dev/fresh-local.mjs");
  copyFileSync(freshScript, script);
  writeFileSync(join(fixture, "SOURCE_MARKER"), "source");
  const bin = join(fixture, "stub-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "npm"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, MP_FRESH_DATA_DIR: "" };
  const run = (args, cwd = fixture) => runFresh(args, env, script, cwd);
  const assertSourceIntact = () => {
    assert.equal(readFileSync(join(fixture, "SOURCE_MARKER"), "utf8"), "source");
    assert.equal(readFileSync(script, "utf8"), readFileSync(freshScript, "utf8"));
  };
  return { fixture, run, assertSourceIntact };
}

for (const [label, args] of [
  ["the project root", ["--data-dir", "."]],
  ["an empty value", ["--data-dir="]],
  ["an ancestor of the project", ["--data-dir", ".."]],
  ["a non-normalized path to the project", ["--data-dir", "tools/../"]],
]) {
  test(`dev:fresh refuses to wipe ${label}`, async (t) => {
    const { run, assertSourceIntact } = makeFixture(t);
    const result = await run([...args, "--force-data-dir"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /Refusing/);
    assertSourceIntact();
  });
}

test("dev:fresh refuses a symlink that resolves to the project root", async (t) => {
  const { fixture, run, assertSourceIntact } = makeFixture(t);
  symlinkSync(fixture, join(fixture, ".data-link"));
  const result = await run(["--data-dir", ".data-link"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Refusing/);
  assertSourceIntact();
});

test("dev:fresh refuses a non-empty directory it did not create", async (t) => {
  const { fixture, run, assertSourceIntact } = makeFixture(t);
  const foreign = join(fixture, "notes");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep.txt"), "keep");
  const result = await run(["--data-dir", foreign]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Refusing/);
  assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "keep");
  assertSourceIntact();
});

test("dev:fresh wipes and recreates its own marked store", async (t) => {
  const { fixture, run, assertSourceIntact } = makeFixture(t);
  const store = join(fixture, "elsewhere-store");
  const first = await run(["--data-dir", store]);
  assert.equal(first.code, 0, first.out);
  assert.equal(existsSync(join(store, ".mp-fresh-store")), true);
  writeFileSync(join(store, "stale.db"), "old");
  const second = await run(["--data-dir", store]);
  assert.equal(second.code, 0, second.out);
  assert.equal(existsSync(join(store, "stale.db")), false);
  assert.equal(existsSync(join(store, ".mp-fresh-store")), true);
  assertSourceIntact();
});

test("dev:fresh still wipes a legacy unmarked .data-fresh store", async (t) => {
  const { fixture, run, assertSourceIntact } = makeFixture(t);
  const store = join(fixture, ".data-fresh");
  mkdirSync(store);
  writeFileSync(join(store, "marplanner.db"), "old");
  const result = await run([]);
  assert.equal(result.code, 0, result.out);
  assert.equal(existsSync(join(store, "marplanner.db")), false);
  assert.equal(existsSync(join(store, ".mp-fresh-store")), true);
  assertSourceIntact();
});

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
  assert.equal(packageJson.scripts["seed:all"], "node tools/dev/seed-all.mjs");
  assert.equal(packageJson.scripts.seed, "node tools/dev/seed-all.mjs");
  assert.equal(packageJson.scripts["dev:fresh"], "node tools/dev/fresh-local.mjs");
  assert.equal(existsSync(freshScript), true);
});
