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

test("CI binds the checked-out tree instead of a stale embedded candidate hash", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const workflow = readFileSync(".github/workflows/coverage.yml", "utf8");
  assert.doesNotMatch(workflow, /MP_CANDIDATE_ID:\s*[a-f0-9]{64}/);
  const config = load(workflow);
  assert.deepEqual(Object.keys(config.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(config.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(config.jobs).sort(), ["full", "standard"]);
  assert.equal(config.jobs.full.needs, "standard");
  const steps = (job) => config.jobs[job].steps;
  const commands = (job) =>
    steps(job)
      .filter((step) => step.run)
      .map((step) => step.run);
  const root = mkdtempSync(join(tmpdir(), "candidate-ci-"));
  try {
    mkdirSync(join(root, "tools"));
    mkdirSync(join(root, "tests/fixtures"), { recursive: true });
    copyFileSync("tools/candidate-identity.mjs", join(root, "tools/candidate-identity.mjs"));
    writeFileSync(
      join(root, "tests/fixtures/assembly-cohort.json"),
      JSON.stringify({ productFiles: ["missing.txt"] })
    );
    for (const job of ["standard", "full"]) {
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
  assert.ok(commands("full").includes("npm run check:aggregate-only"));
  assert.ok(!commands("full").some((run) => /check:(standard|full)|cohorts:stamp/.test(run)));
  const upload = steps("standard").find((step) => step.uses === "actions/upload-artifact@v4");
  const download = steps("full").find((step) => step.uses === "actions/download-artifact@v4");
  assert.equal(upload.with.name, "standard-evidence-${{ github.run_id }}");
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
    commands("full").some(
      (run) => run === 'tar -xzf "$RUNNER_TEMP/standard-evidence/standard-evidence.tar.gz"'
    )
  );
  assert.equal(existsSync(".github/workflows/full-gate.yml"), false);
});
