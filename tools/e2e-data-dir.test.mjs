import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupE2eDataDir, resolveE2eDataDir } from "./e2e-data-dir.mjs";

test("creates and removes one owned data directory for a normal E2E run", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "marplanner-e2e-data-test-"));

  try {
    const state = resolveE2eDataDir({ tempRoot });

    assert.equal(state.owned, true);
    assert.equal(state.dataDir.startsWith(join(tempRoot, "marplanner-e2e-")), true);
    assert.equal(existsSync(state.dataDir), true);

    cleanupE2eDataDir(state);

    assert.equal(existsSync(state.dataDir), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("preserves an explicitly supplied data directory", () => {
  const explicitDataDir = mkdtempSync(join(tmpdir(), "marplanner-e2e-explicit-test-"));

  try {
    const state = resolveE2eDataDir({ explicitDataDir });

    assert.deepEqual(state, { dataDir: explicitDataDir, owned: false });

    cleanupE2eDataDir(state);

    assert.equal(existsSync(explicitDataDir), true);
  } finally {
    rmSync(explicitDataDir, { recursive: true, force: true });
  }
});

test("rejects server reuse without an explicit matching data directory", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "marplanner-e2e-reuse-test-"));

  try {
    assert.throws(
      () => resolveE2eDataDir({ reuseExistingServer: true, tempRoot }),
      /PW_REUSE_SERVER=1 requires E2E_DATA_DIR/
    );
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
