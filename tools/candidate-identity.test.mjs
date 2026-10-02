import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const { readFileSync } = await import("node:fs");
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
  for (const job of ["standard", "full"])
    assert.ok(commands(job).some((run) => run.includes("node tools/candidate-identity.mjs")));
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
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(".github/workflows/full-gate.yml"), false);
});
