import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  formatLocalReadyBanner,
  formatSeedWarning,
  inspectLocalSeedStatus,
  parseDensity,
  parsePort,
  readLocalReady,
  resolveDensityFromArgv,
  writeLocalReady,
} from "./dev/chrome-dev-shared.mjs";

test("parsePort accepts only usable TCP ports", () => {
  assert.equal(parsePort("9222", "CHROME_CDP_PORT"), 9222);
  assert.equal(parsePort(undefined, "CHROME_CDP_PORT"), null);
  assert.throws(() => parsePort("0", "CHROME_CDP_PORT"), /1 to 65535/);
  assert.throws(() => parsePort("abc", "CHROME_CDP_PORT"), /1 to 65535/);
});

test("parseDensity accepts product and script aliases", () => {
  assert.equal(parseDensity("comfortable"), "comfortable");
  assert.equal(parseDensity("desktop"), "comfortable");
  assert.equal(parseDensity("kiosk"), "kiosk");
  assert.equal(parseDensity("dense"), "kiosk");
  assert.throws(() => parseDensity("touch"), /density must be/);
});

test("resolveDensityFromArgv defaults to comfortable when density is deferred", () => {
  assert.equal(resolveDensityFromArgv([]), "comfortable");
  assert.equal(resolveDensityFromArgv(["--origin", "http://127.0.0.1:1"]), "comfortable");
  assert.equal(resolveDensityFromArgv(["--density=kiosk"]), "kiosk");
});

test("local-ready round-trips under an isolated data directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-ready-"));
  try {
    const written = writeLocalReady(
      {
        api: "http://127.0.0.1:3001",
        frontend: "http://127.0.0.1:5173",
        cdpPort: 9222,
      },
      dir
    );
    assert.equal(written.type, "local-ready");
    const read = readLocalReady(dir);
    assert.deepEqual(read, {
      type: "local-ready",
      api: "http://127.0.0.1:3001",
      frontend: "http://127.0.0.1:5173",
      cdpPort: 9222,
    });
    const raw = JSON.parse(readFileSync(join(dir, "local-ready.json"), "utf8"));
    assert.equal(raw.frontend, "http://127.0.0.1:5173");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-ready banner lists API frontend CDP and session commands", () => {
  const withCdp = formatLocalReadyBanner({
    api: "http://127.0.0.1:1",
    frontend: "http://127.0.0.1:2",
    cdpPort: 9333,
  });
  assert.deepEqual(withCdp[0], "API:      http://127.0.0.1:1");
  assert.deepEqual(withCdp[1], "Frontend: http://127.0.0.1:2");
  assert.match(withCdp[2], /CDP:\s+9333/);
  assert.match(withCdp[3], /dev:session(?!-)/);
  assert.match(withCdp[3], /dev:session-reset/);
  assert.doesNotMatch(withCdp[3], /dev:session-desktop|dev:session-dense/);

  const without = formatLocalReadyBanner({
    api: "http://127.0.0.1:1",
    frontend: "http://127.0.0.1:2",
    cdpPort: null,
  });
  assert.match(without[2], /CDP:\s+unset/);
});

test("inspectLocalSeedStatus distinguishes missing unseeded incomplete and complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-seed-status-"));
  const missingPath = join(dir, "missing.db");
  assert.equal(inspectLocalSeedStatus(missingPath).kind, "missing-db");

  const dbPath = join(dir, "seed.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE seed_profile_state (
      profile text PRIMARY KEY NOT NULL,
      version integer NOT NULL,
      as_of_date text NOT NULL,
      status text NOT NULL,
      started_at integer NOT NULL,
      completed_at integer
    );
  `);
  assert.equal(inspectLocalSeedStatus(dbPath).kind, "unseeded");
  assert.match(formatSeedWarning(inspectLocalSeedStatus(dbPath)) ?? "", /npm run seed/);

  db.prepare(
    `INSERT INTO seed_profile_state (profile, version, as_of_date, status, started_at, completed_at)
     VALUES ('simpsons-demo', 1, '2026-01-15', 'running', 1, NULL)`
  ).run();
  assert.equal(inspectLocalSeedStatus(dbPath).kind, "incomplete");

  db.prepare(`UPDATE seed_profile_state SET status = 'complete', completed_at = 2`).run();
  assert.equal(inspectLocalSeedStatus(dbPath).kind, "complete");
  assert.equal(formatSeedWarning(inspectLocalSeedStatus(dbPath)), null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
