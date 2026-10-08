import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("candidate identity binds bytes, modes and exact maintained inventory", async () => {
  const { candidateIdentity, requireCandidate } = await import("./candidate-identity.mjs");
  const root = mkdtempSync(join(tmpdir(), "candidate-identity-"));
  try {
    writeFileSync(join(root, "file.txt"), "reviewed");
    const files = ["file.txt"];
    const original = candidateIdentity(root, files);
    assert.match(original, /^[a-f0-9]{64}$/);
    assert.equal(requireCandidate(original, root, files), original);
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "generated.json"), "{}");
    assert.equal(candidateIdentity(root, files), original);
    chmodSync(join(root, "file.txt"), 0o755);
    assert.notEqual(candidateIdentity(root, files), original);
    chmodSync(join(root, "file.txt"), 0o644);
    writeFileSync(join(root, "file.txt"), "changed");
    assert.notEqual(candidateIdentity(root, files), original);
    assert.throws(() => requireCandidate(original, root, files), /candidate/i);
    writeFileSync(join(root, "extra.txt"), "unexpected");
    assert.throws(() => candidateIdentity(root, files), /inventory/i);
    assert.throws(() => candidateIdentity(root, []), /inventory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracked checkout inventory comes from git and rejects untracked files", async () => {
  const { candidateIdentity } = await import("./candidate-identity.mjs");
  const root = mkdtempSync(join(tmpdir(), "candidate-git-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git(["init", "-b", "main"]);
    writeFileSync(join(root, "tracked.txt"), "tracked");
    git(["add", "tracked.txt"]);
    const original = candidateIdentity(root);
    assert.match(original, /^[a-f0-9]{64}$/);
    writeFileSync(join(root, "notes.txt"), "untracked");
    assert.throws(() => candidateIdentity(root), /tracked files/i);
    rmSync(join(root, "notes.txt"));
    assert.equal(candidateIdentity(root), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI binds the checked-out tree instead of a stale embedded candidate hash", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const workflow = readFileSync(".github/workflows/coverage.yml", "utf8");
  assert.doesNotMatch(workflow, /MP_CANDIDATE_ID:\s*[a-f0-9]{64}/);
  const config = load(workflow);
  assert.deepEqual(Object.keys(config.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(config.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(config.jobs).sort(), [
    "container",
    "full",
    "native",
    "select",
    "standard",
  ]);
  assert.deepEqual(config.jobs.full.needs, ["select", "standard", "native", "container"]);
  assert.equal(config.jobs.full.if, "${{ always() }}");
  assert.equal(config.jobs.container["runs-on"], "ubuntu-latest");
  for (const job of ["standard", "native"]) {
    assert.equal(config.jobs[job]["runs-on"], "${{ fromJSON(needs.select.outputs.runner) }}");
    assert.ok(config.jobs[job].needs.includes("select"));
  }
  assert.equal(config.jobs.select.uses, "./.github/workflows/mac-mini-ci.yml");
  const steps = (job) => config.jobs[job].steps;
  const commands = (job) =>
    steps(job)
      .filter((step) => step.run)
      .map((step) => step.run);
  const root = mkdtempSync(join(tmpdir(), "candidate-ci-"));
  try {
    mkdirSync(join(root, "tools"));
    copyFileSync("tools/candidate-identity.mjs", join(root, "tools/candidate-identity.mjs"));
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-b", "main"]);
    writeFileSync(join(root, "tracked.txt"), "tracked");
    git(["add", "tracked.txt"]);
    writeFileSync(join(root, "extra.txt"), "untracked");
    for (const job of ["standard", "native", "container"]) {
      const run = commands(job).find((run) => run.includes("node tools/candidate-identity.mjs"));
      assert.ok(run);
      const envFile = join(root, `${job}-env`);
      const result = spawnSync("bash", ["-e", "-c", run], {
        cwd: root,
        env: { ...process.env, GITHUB_ENV: envFile },
        encoding: "utf8",
      });
      assert.match(result.stderr, /Candidate inventory differs/);
      assert.notEqual(result.status, 0, `${job} must stop when candidate identity fails`);
      assert.equal(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(commands("standard").filter((run) => run === "npm run check:standard").length, 1);
  assert.ok(commands("native").includes("npm run check:aggregate-only"));
  assert.ok(!commands("native").some((run) => /check:(standard|full)|cohorts:stamp/.test(run)));
  const upload = steps("standard").find(
    (step) => step.uses?.split("@")[0] === "actions/upload-artifact"
  );
  const download = steps("native").find(
    (step) => step.uses?.split("@")[0] === "actions/download-artifact"
  );
  assert.equal(
    upload.with.name,
    "standard-evidence-${{ github.run_id }}-${{ github.run_attempt }}"
  );
  assert.equal(download.with.name, upload.with.name);
  assert.equal(upload.with.overwrite, true);
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "warn");
  assert.ok(
    commands("standard").some((run) => run.includes('if [ "${#paths[@]}" -eq 0 ]; then exit 0; fi'))
  );
  assert.ok(
    commands("standard").some((run) =>
      run.includes('tar --format=pax -czf "$RUNNER_TEMP/standard-evidence.tar.gz"')
    )
  );
  assert.ok(
    commands("native").some(
      (run) => run === 'tar -xzf "$RUNNER_TEMP/standard-evidence/standard-evidence.tar.gz"'
    )
  );
  const gate = config.jobs.full.steps[0].run;
  const passing = Object.fromEntries(
    config.jobs.full.needs.map((name) => [name, { result: "success" }])
  );
  for (const status of ["success", "failure", "cancelled", "skipped"]) {
    for (const name of config.jobs.full.needs) {
      const results = structuredClone(passing);
      results[name].result = status;
      const result = spawnSync("bash", ["-e", "-c", gate], {
        env: { ...process.env, RESULTS: JSON.stringify(results) },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, status === "success", `${name}: ${status}`);
    }
  }
  assert.equal(existsSync(".github/workflows/full-gate.yml"), false);
});

test("runner selector admits only trusted online idle macmini and falls back safely", async () => {
  const { readFileSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const selector = load(readFileSync(".github/workflows/mac-mini-ci.yml", "utf8"));
  assert.match(
    selector.jobs.select.steps[0].env.TRUSTED,
    /head.repo.full_name == github.repository/
  );
  const script = selector.jobs.select.steps[0].run.split("python3 - <<'PY'\n")[1].split("\nPY")[0];
  const root = mkdtempSync(join(tmpdir(), "runner-selector-"));
  try {
    const runner = {
      name: "macmini",
      status: "online",
      busy: false,
      labels: ["self-hosted", "macOS", "macmini"].map((name) => ({ name })),
    };
    for (const [label, changes, trusted, forced, expected] of [
      ["idle", {}, "true", "false", ["self-hosted", "macOS", "macmini"]],
      ["busy", { busy: true }, "true", "false", ["macos-15"]],
      ["offline", { status: "offline" }, "true", "false", ["macos-15"]],
      ["wrong name", { name: "other" }, "true", "false", ["macos-15"]],
      ["missing label", { labels: [] }, "true", "false", ["macos-15"]],
      ["fork", {}, "false", "false", ["macos-15"]],
      ["forced", {}, "true", "true", ["macos-15"]],
    ]) {
      const output = join(root, label);
      const setup = `import io, urllib.request\nurllib.request.urlopen = lambda *args, **kwargs: io.StringIO(${JSON.stringify(JSON.stringify({ runners: [{ ...runner, ...changes }] }))})\n`;
      const result = spawnSync("python3", ["-c", setup + script], {
        env: {
          ...process.env,
          RUNNER_READ_TOKEN: "test",
          REPOSITORY: "test/repo",
          TRUSTED: trusted,
          FORCE_HOSTED: forced,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(readFileSync(output, "utf8").trim().slice("runner=".length)),
        expected,
        label
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
