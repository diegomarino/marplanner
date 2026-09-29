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
  for (const name of ["full-gate", "coverage"]) {
    const workflow = readFileSync(`.github/workflows/${name}.yml`, "utf8");
    assert.doesNotMatch(workflow, /MP_CANDIDATE_ID:\s*[a-f0-9]{64}/);
    assert.match(workflow, /node tools\/candidate-identity\.mjs/);
  }
});
