import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fs from "node:fs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function boot(dir, database = "marplanner.db", script = "src/server/index.ts", args = []) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    env: {
      ...process.env,
      MP_ACCESS_TOKEN: "",
      MP_BOOTSTRAP_KEY: "",
      MP_MANAGEMENT_KEY: "",
      BACKUPS_ROOT: join(dir, "backups"),
      SCHEDULER_SMOKE_JOB: "0",
      SEED_DIRECTORY: dir,
      BASE_PATH: "/",
      DATA_DIR: dir,
      DATABASE_PATH: database,
      PORT: "0",
      HOST: "127.0.0.1",
      SCHEDULER_DISABLED: "1",
      MP_LOCAL_READINESS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const exited = new Promise((done) => child.on("exit", (code) => done(code)));
  return {
    child,
    exited,
    log: () => log,
    async ready() {
      for (let i = 0; i < 300; i++) {
        if (log.includes('"type":"ready"')) return;
        if (child.exitCode !== null) throw new Error(log);
        await delay(20);
      }
      throw new Error(`Startup timed out: ${log}`);
    },
  };
}
async function stop(instance, signal = "SIGTERM") {
  if (instance.child.exitCode === null && instance.child.signalCode === null)
    instance.child.kill(signal);
  await instance.exited;
}

test(
  "storage ownership rejects aliases, and releases after clean exit and crash",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-storage-"));
    const running = [];
    const start = (root = dir, file) => {
      const child = boot(root, file);
      running.push(child);
      return child;
    };
    try {
      const owner = start();
      await owner.ready();
      const second = start();
      await Promise.race([second.exited, delay(3000)]);
      assert.equal(second.child.exitCode, 1, `Second process accepted storage: ${second.log()}`);
      assert.match(second.log(), /already.*(owned|in use)|another.*instance/i);
      assert.doesNotMatch(second.log(), /"type":"ready"|scheduler disabled/);
      writeFileSync(
        join(dir, "seed-000-storage.mjs"),
        'export default { id: "public:storage", run() {} };'
      );
      const seedArgs = ["--mode", "public", "--as-of", "2026-10-02"];
      const seed = boot(dir, "marplanner.db", "src/server/db/seeds/cli.ts", seedArgs);
      running.push(seed);
      assert.equal(await seed.exited, 1);
      const alias = join(dir, "alias");
      symlinkSync(dir, alias);
      const aliased = start(alias);
      assert.equal(await aliased.exited, 1);
      const separate = start(dir, "other.db");
      await separate.ready();
      await stop(separate);
      await stop(owner);
      const unownedSeed = boot(dir, "marplanner.db", "src/server/db/seeds/cli.ts", seedArgs);
      running.push(unownedSeed);
      assert.equal(await unownedSeed.exited, 0, unownedSeed.log());
      const restarted = start();
      await restarted.ready();
      await stop(restarted, "SIGKILL");
      const recovered = start();
      await recovered.ready();
      await stop(recovered);
      symlinkSync(join(dir, "marplanner.db"), join(dir, "linked.db"));
      const linked = start(dir, "linked.db");
      assert.equal(await linked.exited, 1);
      assert.match(linked.log(), /symbolic link/i);
      linkSync(join(dir, "marplanner.db"), join(dir, "hardlinked.db"));
      const hardlinked = start(dir, "hardlinked.db");
      assert.equal(await hardlinked.exited, 1);
      assert.match(hardlinked.log(), /hard link/i);
      const sentinel = join(dir, "malformed.db.instance-lock.sqlite");
      writeFileSync(sentinel, "malformed sentinel");
      const malformed = start(dir, "malformed.db");
      assert.equal(await malformed.exited, 1);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "malformed sentinel");
      assert.equal(existsSync(join(dir, "malformed.db")), false);
      symlinkSync(join(dir, "other.db"), join(dir, "sentinel-link.db.instance-lock.sqlite"));
      const sentinelLink = start(dir, "sentinel-link.db");
      assert.equal(await sentinelLink.exited, 1);
      assert.match(sentinelLink.log(), /symbolic link/i);
      assert.equal(existsSync(join(dir, "sentinel-link.db")), false);
    } finally {
      await Promise.all(running.map((instance) => stop(instance, "SIGKILL")));
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "ownership remains held while the product connection is reset and its inode replaced",
  { timeout: 10000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-reset-storage-"));
    const script = join(dir, "owner.mjs");
    writeFileSync(
      script,
      `
    import { acquireStorageOwnership } from ${JSON.stringify(new URL("../src/server/db/runtime-storage.ts", import.meta.url).href)};
    import { getDb, resetDb } from ${JSON.stringify(new URL("../src/server/db/client.ts", import.meta.url).href)};
    import fs from "node:fs";
    import path from "node:path";
    acquireStorageOwnership(path.join(process.env.DATA_DIR, "marplanner.db"));
    getDb().exec("CREATE TABLE marker (id INTEGER)");
    resetDb();
    fs.renameSync(path.join(process.env.DATA_DIR, "marplanner.db"), path.join(process.env.DATA_DIR, "old.db"));
    getDb();
    console.log('MP_LOCAL_READY {"type":"ready"}');
    setInterval(() => {}, 1000);
  `
    );
    const owner = boot(dir, "marplanner.db", script);
    let competing;
    try {
      await owner.ready();
      competing = boot(dir);
      assert.equal(await competing.exited, 1);
      assert.match(competing.log(), /already owned/);
    } finally {
      await stop(owner, "SIGKILL");
      if (competing) await stop(competing, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("installed native SQLite is at least 3.51.3 with an exact reviewed dependency pin", async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(
    fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
  );
  assert.equal(
    pkg.dependencies["better-sqlite3"],
    lock.packages["node_modules/better-sqlite3"].version
  );
  assert.equal(
    lock.packages[""].dependencies["better-sqlite3"],
    pkg.dependencies["better-sqlite3"]
  );
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  try {
    const version = db.prepare("SELECT sqlite_version()").pluck().get();
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version.split(".").map(Number);
    assert.ok(
      major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))),
      `Bundled SQLite ${version} must be >=3.51.3`
    );
  } finally {
    db.close();
  }
});
