import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveE2eDataDir({
  explicitDataDir,
  reuseExistingServer = false,
  tempRoot = tmpdir(),
} = {}) {
  if (explicitDataDir) {
    return { dataDir: explicitDataDir, owned: false };
  }

  if (reuseExistingServer) {
    throw new Error(
      "PW_REUSE_SERVER=1 requires E2E_DATA_DIR to identify the reused server's database"
    );
  }

  return {
    dataDir: mkdtempSync(join(tempRoot, "marplanner-e2e-")),
    owned: true,
  };
}

export function cleanupE2eDataDir({ dataDir, owned }) {
  if (!owned) return;
  rmSync(dataDir, { recursive: true, force: true });
}
