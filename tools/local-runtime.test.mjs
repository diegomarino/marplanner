import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const timeout = (ms, value) => new Promise((done) => setTimeout(() => done(value), ms).unref());
async function until(check, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Runtime condition timed out");
}
function boot(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mp-local-"));
  const child = spawn(process.execPath, ["tools/dev/start-local.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      WEB_PORT: "0",
      DATA_DIR: dir,
      DATABASE_PATH: "marplanner.db",
      SCHEDULER_DISABLED: "1",
      MP_ACCESS_TOKEN: "mpg-test-secret-canary",
      MP_BOOTSTRAP_KEY: "mpk-test-secret-canary",
      ADMIN_PIN: "817239",
      ...overrides,
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
  const events = () =>
    log.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return {
    child,
    dir,
    exited,
    events,
    log: () => log,
    ready: () => until(() => events().find((event) => event.type === "local-ready")),
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        timeout(10000).then(() => {
          child.kill("SIGKILL");
          throw new Error("Shutdown timed out");
        }),
      ]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function closed(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(300) });
    return false;
  } catch {
    return true;
  }
}

test(
  "two live development stacks own four ports and track an API watch restart",
  { timeout: 60000 },
  async () => {
    const stacks = [boot(), boot()];
    const urls = [];
    try {
      const ready = await Promise.all(stacks.map((stack) => stack.ready()));
      urls.push(...ready.flatMap(({ api, frontend }) => [api, frontend]));
      assert.equal(new Set(urls.map((url) => new URL(url).port)).size, 4);
      const cookies = [];
      for (const [i, { api, frontend }] of ready.entries()) {
        assert.equal((await fetch(`${api}/health`)).status, 200);
        assert.equal((await fetch(`${frontend}/health`)).status, 200);
        assert.equal((await fetch(`${frontend}/api/members`)).status, 401);
        const provision = await fetch(`${frontend}/api/auth/provision`, {
          method: "POST",
          headers: { authorization: "Bearer mpk-test-secret-canary" },
        });
        assert.equal(provision.status, 200);
        const cookie = provision.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        cookies.push(cookie);
        const created = await fetch(`${frontend}/api/members`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ displayName: `Synthetic stack ${i}`, role: "child" }),
        });
        assert.equal(created.status, 201);
        const members = await (
          await fetch(`${frontend}/api/members`, { headers: { cookie } })
        ).json();
        assert.deepEqual(
          members.map((member) => member.displayName),
          [`Synthetic stack ${i}`]
        );
        const client = await (await fetch(`${frontend}/src/client/main.tsx`)).text();
        assert.doesNotMatch(client, /test-secret-canary|817239/);
      }
      const entry = join(root, "src/server/index.ts");
      const before = statSync(entry);
      utimesSync(entry, before.atime, new Date());
      await Promise.all(
        ready.map(({ frontend }) =>
          until(async () => {
            try {
              return (await fetch(`${frontend}/api/members`)).status === 503;
            } catch {
              return false;
            }
          })
        )
      );
      const next = await Promise.all(
        stacks.map((stack) =>
          until(() =>
            stack
              .events()
              .filter((event) => event.type === "api-ready")
              .at(1)
          )
        )
      );
      urls.push(...next.map(({ api }) => api));
      for (let i = 0; i < stacks.length; i++) {
        assert.notEqual(next[i].api, ready[i].api);
        assert.equal((await fetch(`${ready[i].frontend}/health`)).status, 200);
        const members = await (
          await fetch(`${ready[i].frontend}/api/members`, { headers: { cookie: cookies[i] } })
        ).json();
        assert.deepEqual(
          members.map((member) => member.displayName),
          [`Synthetic stack ${i}`]
        );
        assert.equal(await closed(ready[i].api), true);
        assert.doesNotMatch(stacks[i].log(), /test-secret-canary|817239/);
      }
      const config = join(root, "vite.config.ts");
      const configTime = statSync(config);
      utimesSync(config, configTime.atime, new Date());
      await Promise.all(
        stacks.map((stack) => until(() => stack.log().includes("server restarted")))
      );
      for (const [i, { frontend }] of ready.entries()) {
        const response = await fetch(`${frontend}/api/members`, {
          headers: { cookie: cookies[i] },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(
          (await response.json()).map((member) => member.displayName),
          [`Synthetic stack ${i}`]
        );
      }
    } finally {
      await Promise.all(stacks.map((stack) => stack.stop()));
    }
    for (const url of urls) assert.equal(await closed(url), true);
    const explicit = boot({ PORT: new URL(urls[0]).port, WEB_PORT: new URL(urls[1]).port });
    try {
      const ready = await explicit.ready();
      assert.equal(ready.api, urls[0]);
      assert.equal(ready.frontend, urls[1]);
      assert.equal((await fetch(`${ready.frontend}/health`)).status, 200);
    } finally {
      await explicit.stop();
    }
    for (const url of urls.slice(0, 2)) assert.equal(await closed(url), true);
  }
);

test(
  "invalid ports, early API failure, readiness timeout, and occupied listeners fail cleanly",
  { timeout: 60000 },
  async () => {
    const occupied = createServer();
    await new Promise((done) => occupied.listen(0, "127.0.0.1", done));
    try {
      const port = String(occupied.address().port);
      const preloadDir = mkdtempSync(join(tmpdir(), "mp-protocol-"));
      const preload = join(preloadDir, "malformed.mjs");
      writeFileSync(
        preload,
        `import fs from "node:fs"; import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";
      const original = cp.spawn;
      cp.spawn = function(...args) {
        const child = original.apply(this, args);
        if (args[1]?.includes("--watch")) fs.writeFileSync(process.env.MP_TEST_WATCH_PID, String(child.pid));
        return child;
      }; syncBuiltinESMExports();
      if (process.env.MP_LOCAL_READINESS === "1" && process.env.MP_TEST_MALFORMED === "1") console.log("MP_LOCAL_READY {broken");`
      );
      const pidFile = join(preloadDir, "watch.pid");
      const malformed = boot({
        NODE_OPTIONS: `--import=${preload}`,
        MP_TEST_WATCH_PID: pidFile,
        MP_TEST_MALFORMED: "1",
      });
      try {
        assert.equal(
          await Promise.race([malformed.exited, timeout(15000, "timeout")]),
          1,
          malformed.log()
        );
        assert.match(malformed.log(), /Invalid API readiness signal/);
      } finally {
        await malformed.stop();
        const failed = boot({ NODE_OPTIONS: `--import=${preload}`, MP_TEST_WATCH_PID: pidFile });
        try {
          const ready = await failed.ready();
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
          assert.equal(await Promise.race([failed.exited, timeout(15000, "timeout")]), 1);
          assert.equal(await closed(ready.api), true);
          assert.equal(await closed(ready.frontend), true);
        } finally {
          await failed.stop();
        }
        rmSync(preloadDir, { recursive: true, force: true });
      }

      for (const overrides of [
        { PORT: "bad" },
        { PORT: "-1" },
        { WEB_PORT: "1.5" },
        { WEB_PORT: "65536" },
        { PORT: port },
        { WEB_PORT: port },
        { DATA_DIR: "/dev/null/no-data" },
        { MP_LOCAL_READY_TIMEOUT_MS: "1" },
      ]) {
        const stack = boot(overrides);
        try {
          assert.equal(
            await Promise.race([stack.exited, timeout(15000, "timeout")]),
            1,
            stack.log()
          );
          assert.match(stack.log(), /Local development failed:/);
          for (const event of stack.events())
            if (event.api) assert.equal(await closed(event.api), true);
        } finally {
          await stack.stop();
        }
      }
    } finally {
      await new Promise((done) => occupied.close(done));
    }
  }
);
