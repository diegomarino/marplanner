// Classify every product check CLI and prove fixture-driven gates reject violations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRACE_DIR = path.dirname(fileURLToPath(import.meta.url));

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}
function write(root, rel, text) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function run(toolPath, fixture) {
  const { argv, cwd } = Array.isArray(fixture) ? { argv: fixture } : fixture;
  return spawnSync("node", [toolPath, ...argv], { cwd, encoding: "utf8" });
}

function pluginEventFixture(event) {
  const root = tmp("mpk-plugin-events-");
  write(root, "tsconfig.server.json", JSON.stringify({ include: ["src/**/*.ts"] }));
  write(
    root,
    "src/shared/events.ts",
    readFileSync(path.join(TRACE_DIR, "../src/shared/events.ts"), "utf8")
  );
  write(
    root,
    "src/server/lib/event-bus.ts",
    "export function emit(name: string, payload: unknown): void {}\n"
  );
  write(
    root,
    "src/server/modules/printing/probe.ts",
    `import { emit } from "../../lib/event-bus";\nemit("${event}", {});\n`
  );
  return { argv: [], cwd: root };
}

// The exception ratchet fixture uses two real commits and a clean worktree.
function git(root, args) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${root}:\n${res.stderr}`);
  }
  return res.stdout;
}
function writeExceptionList(root, list) {
  write(
    root,
    "eslint.config.mjs",
    `const UI_DEBT_EXCEPTION_FILES = ${JSON.stringify(list)};\n` +
      "export { UI_DEBT_EXCEPTION_FILES };\nexport default [];\n"
  );
}
function initExceptionListRepo(prefix, initialList) {
  const root = tmp(prefix);
  writeExceptionList(root, initialList);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "eslint.config.mjs"]);
  git(root, ["commit", "-q", "-m", "init"]);

  return root;
}
// Commit the changed list so a HEAD-vs-worktree comparison would be vacuous.
function commitExceptionListChange(root, newList) {
  writeExceptionList(root, newList);
  git(root, ["add", "eslint.config.mjs"]);
  git(root, ["commit", "-q", "-m", "change list"]);
}

// ── Break-recipes: one per check-*.mjs tool ─────────────────────────────────
// Each recipe returns argv or argv with a fixture cwd. `bad` must drive a
// non-zero exit; `good` must drive exit 0.
const RECIPES = {
  "check-plugin-events.mjs": {
    bad: () => pluginEventFixture("routines.completion_changed"),
    good: () => pluginEventFixture("printing.completed"),
  },
  "check-exception-list.mjs": {
    // An added exception must fail against the committed predecessor.
    bad() {
      const root = initExceptionListRepo("mpk-neg-xlist-bad-", ["a.tsx", "b.tsx"]);
      commitExceptionListChange(root, ["a.tsx", "b.tsx", "c.tsx"]);
      return ["--root", root, "--base", "HEAD~1"];
    },
    // Removing an exception must pass against the committed predecessor.
    good() {
      const root = initExceptionListRepo("mpk-neg-xlist-good-", ["a.tsx", "b.tsx"]);
      commitExceptionListChange(root, ["a.tsx"]);
      return ["--root", root, "--base", "HEAD~1"];
    },
  },
};

// ── Exclusions: check-*.mjs tools that are deliberately NOT exit-code gates ──
// Each MUST carry a reason. The discovery test requires every repo-wide check tool to
// be in RECIPES *or* here — so a tool can only escape the negative-test net by an
// explicit, documented decision, never by living in a directory the glob missed.
const EXCLUSIONS = {
  "check-openapi-drift.mjs":
    "The CLI boots the staged application. Its route, shape, discovery and cohort checks " +
    "have negative fixtures in tools/check-openapi-drift.test.mjs.",
};

test("fresh root exception ratchet uses exact reviewed empty bootstrap list", () => {
  const root = initExceptionListRepo("mpk-bootstrap-xlist-", []);
  write(
    root,
    "tests/fixtures/assembly-cohort.json",
    JSON.stringify({ exceptionListBootstrap: [] })
  );
  const toolPath = path.join(REPO_ROOT, "tools", "dev", "check-exception-list.mjs");
  const argv = ["--root", root, "--bootstrap-fixture", "tests/fixtures/assembly-cohort.json"];
  assert.equal(run(toolPath, argv).status, 0);
  writeExceptionList(root, ["new.tsx"]);
  assert.notEqual(run(toolPath, argv).status, 0);
});

test("uncommitted B0 ratchet requires the reviewed candidate identity", () => {
  const root = tmp("mpk-uncommitted-xlist-");
  writeExceptionList(root, []);
  write(
    root,
    "tests/fixtures/assembly-cohort.json",
    JSON.stringify({ batch: "B0", candidate: "reviewed", exceptionListBootstrap: [] })
  );
  const toolPath = path.join(REPO_ROOT, "tools", "dev", "check-exception-list.mjs");
  const args = [
    toolPath,
    "--root",
    root,
    "--bootstrap-fixture",
    "tests/fixtures/assembly-cohort.json",
  ];
  const invoke = (candidate) =>
    spawnSync("node", args, {
      encoding: "utf8",
      env: { ...process.env, MP_CANDIDATE_ID: candidate },
    });
  assert.equal(invoke("reviewed").status, 0);
  assert.notEqual(invoke("wrong").status, 0);
  writeExceptionList(root, ["unreviewed.tsx"]);
  assert.notEqual(invoke("reviewed").status, 0);
});

test("runtime classifier cannot waive product checks for any changed path", () => {
  const pattern = new RegExp(
    readFileSync(path.join(REPO_ROOT, ".github", "runtime-paths.regex"), "utf8").trim()
  );
  for (const changed of [
    "src/server/app.ts",
    "tests/boundary/boot.test.ts",
    "tools/verify-coverage.mjs",
    "scripts/build-server.mjs",
    "vitest.config.ts",
    ".github/workflows/full-gate.yml",
    "docs/api/bootstrap/openapi.yaml",
    "package-lock.json",
    "README.md",
  ])
    assert.ok(pattern.test(changed), `${changed} could waive required checks`);
});

test("check-openapi-drift.mjs negative-test home (tools/check-openapi-drift.test.mjs) exists", () => {
  assert.ok(
    existsSync(path.join(REPO_ROOT, "tools", "check-openapi-drift.test.mjs")),
    "check-openapi-drift.mjs is excluded from the spawn net on the promise that " +
      "tools/check-openapi-drift.test.mjs negative-tests its checkOpenApiDrift core in-process — " +
      "but that file is missing."
  );
});

// ── 1. Discovery (REPO-WIDE): every check-*.mjs must be classified ───────────
// Walk the complete product tree so checks cannot evade classification by moving.
function findCheckTools(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "coverage", ".quality"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findCheckTools(full));
    else if (/^check-.*\.mjs$/.test(e.name) && !e.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}
const REPO_ROOT = path.resolve(TRACE_DIR, "..");
const CHECK_TOOLS = findCheckTools(REPO_ROOT).sort(); // full paths
const nameOf = (p) => path.basename(p);

test("every check-*.mjs tool (repo-wide) is classified: break-recipe or documented exclusion", () => {
  const unclassified = CHECK_TOOLS.map(nameOf).filter((n) => !RECIPES[n] && !EXCLUSIONS[n]);
  assert.deepEqual(
    unclassified,
    [],
    `these check tools are neither negative-tested nor excluded — add a break-recipe (or a documented EXCLUSIONS entry) in check-quality-tools-negative.test.mjs: ${unclassified.join(", ")}`
  );
});

// ── 2. Negative proof: each recipe tool exits non-zero on a violation, zero when clean ──
for (const toolPath of CHECK_TOOLS) {
  const name = nameOf(toolPath);
  const recipe = RECIPES[name];
  if (!recipe) continue; // excluded tools are classified above; no spawn test for them.

  test(`${name} — synthetic violation → NON-ZERO exit (not false-green)`, () => {
    const res = run(toolPath, recipe.bad());
    assert.notEqual(
      res.status,
      0,
      `${name} exited 0 on a violation (false-green). stdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  });

  test(`${name} — clean fixture → exit 0 (not always-red)`, () => {
    const res = run(toolPath, recipe.good());
    assert.equal(
      res.status,
      0,
      `${name} exited ${res.status} on a clean fixture (always-red). stdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  });
}
