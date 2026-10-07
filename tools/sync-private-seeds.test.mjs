import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "tools/dev/sync-private-seeds.mjs");

test("seed:sync-private is wired", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["seed:sync-private"], "node tools/dev/sync-private-seeds.mjs");
});

test("sync-private-seeds copies PRIVATE modules from --from into seeds/", () => {
  const source = mkdtempSync(join(tmpdir(), "mp-priv-src-"));
  const destSeeds = join(root, "seeds");
  const marker = `seed-sync-test-${Date.now()}-PRIVATE.ts`;
  const destFile = join(destSeeds, marker);
  writeFileSync(join(source, marker), "export default { id: 'private:sync-test' };\n");
  try {
    const result = spawnSync(process.execPath, [script, "--from", source], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(payload.type, "private-seeds-sync");
    assert.ok(payload.copied.includes(marker));
    assert.equal(existsSync(destFile), true);
    assert.match(readFileSync(destFile, "utf8"), /private:sync-test/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    if (existsSync(destFile)) rmSync(destFile, { force: true });
  }
});

test("sync-private-seeds --dry-run does not write", () => {
  const source = mkdtempSync(join(tmpdir(), "mp-priv-dry-"));
  const marker = `seed-dry-${Date.now()}-PRIVATE.ts`;
  const destFile = join(root, "seeds", marker);
  writeFileSync(join(source, marker), "export default {};\n");
  try {
    const result = spawnSync(process.execPath, [script, "--from", source, "--dry-run"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(destFile), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
