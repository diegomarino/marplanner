import assert from "node:assert/strict";
import test from "node:test";

import { parseRouteTree } from "./gen-openapi.mjs";

test("parseRouteTree joins radix suffixes while preserving slash children and parameters", () => {
  const tree = [
    "└── /api/daily-briefing/generate (POST)",
    "    ├── -all (POST)",
    "    ├── /preview (POST)",
    "    └── /:memberId (GET, HEAD)",
  ].join("\n");

  assert.deepEqual(
    parseRouteTree(tree),
    new Set([
      "POST /api/daily-briefing/generate",
      "POST /api/daily-briefing/generate-all",
      "POST /api/daily-briefing/generate/preview",
      "GET /api/daily-briefing/generate/{memberId}",
    ])
  );
});

test("route discovery preserves caller database bytes and creates no adjacent state", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "openapi-owner-"));
  try {
    const database = join(directory, "owned.db");
    writeFileSync(database, "operator-owned data, not a SQLite database");
    const output = execFileSync(process.execPath, ["tools/gen-openapi.mjs"], {
      env: { ...process.env, DATA_DIR: directory, DATABASE_PATH: database },
      encoding: "utf8",
    });
    assert.ok(JSON.parse(output).includes("GET /health"));
    assert.equal(readFileSync(database, "utf8"), "operator-owned data, not a SQLite database");
    assert.deepEqual(readdirSync(directory), ["owned.db"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
