import assert from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deployFly, parseDeployArgs } from "./deploy/fly.mjs";

const SECRET = "mpg-ACCESS-SENTINEL";
const ENV = `MP_ACCESS_TOKEN=${SECRET}\nMP_BOOTSTRAP_KEY=mpk-BOOT-SENTINEL\nADMIN_PIN=8642\n`;
const SHA = "abc1234";

function workspace(env = ENV) {
  const root = mkdtempSync(join(tmpdir(), "deploy-fly-"));
  mkdirSync(join(root, "infra/fly"), { recursive: true });
  mkdirSync(join(root, "docs/api"), { recursive: true });
  writeFileSync(join(root, ".env.fly"), env);
  writeFileSync(join(root, "infra/fly/fly.toml"), 'app = "demo-app"\n');
  writeFileSync(
    join(root, "docs/api/openapi.json"),
    JSON.stringify({ paths: { "/health": { get: {} }, "/api/members": { get: {} } } })
  );
  return root;
}

function provisioned() {
  const headers = new Headers();
  headers.append("set-cookie", "mp_device_key=COOKIE-SENTINEL; HttpOnly; Path=/");
  return new Response('{"provisioned":true}', { headers });
}

/** Fakes for every side effect; `trace` records one entry per external call, in order. */
function deps({
  dirty = "",
  flyCodes = {},
  remoteSecrets = [],
  shas = [SHA],
  smokeStatus = 200,
} = {}) {
  const trace = [];
  const flyCalls = [];
  const lines = [];
  let statusCalls = 0;
  return {
    trace,
    flyCalls,
    lines,
    deps: {
      async runFly(args, options = {}) {
        const name = args.slice(0, args[0] === "secrets" ? 2 : 1).join(" ");
        trace.push(`fly ${name}`);
        flyCalls.push({ args, options });
        const stdout =
          name === "secrets list" ? JSON.stringify(remoteSecrets.map((Name) => ({ Name }))) : "";
        return { code: flyCodes[name] ?? 0, stdout };
      },
      async git(args) {
        trace.push(`git ${args[0]}`);
        if (args[0] === "status") return { code: 0, stdout: dirty };
        if (args[0] === "rev-parse") return { code: 0, stdout: `${SHA}\n` };
        return { code: 0, stdout: "feat: subject\n" };
      },
      async runNpm(script) {
        trace.push(`npm ${script}`);
        return 0;
      },
      async fetch(url, init = {}) {
        const path = new URL(url).pathname;
        trace.push(`${init.method ?? "GET"} ${path}`);
        if (path === "/api/auth/provision") return provisioned();
        if (path === "/health") return Response.json({ status: "ok" });
        if (path === "/api/telemetry/system-status") {
          const sha = shas[Math.min(statusCalls++, shas.length - 1)];
          return Response.json({ build: { sha } });
        }
        return new Response("[]", { status: smokeStatus });
      },
      fs,
      log: (line) => lines.push(line),
      sleep: async () => {},
    },
  };
}

const defaults = parseDeployArgs([]);
const writes = (flyCalls) =>
  flyCalls.filter(({ args }) => args[0] === "deploy" || ["import", "unset"].includes(args[1]));

test("parseDeployArgs knows every flag and rejects unknown ones", () => {
  assert.deepEqual(
    parseDeployArgs([
      "--full",
      "--skip-checks",
      "--skip-smoke",
      "--allow-dirty",
      "--prune",
      "--dry-run",
      "--reprovision",
      "--url",
      "https://x.test/",
    ]),
    {
      full: true,
      skipChecks: true,
      skipSmoke: true,
      allowDirty: true,
      prune: true,
      dryRun: true,
      reprovision: true,
      url: "https://x.test",
    }
  );
  assert.equal(defaults.full, false);
  assert.equal(defaults.url, null);
  assert.throws(() => parseDeployArgs(["--yolo"]), /Usage/);
});

test("deployFly runs pre-flight, checks, secrets, deploy, health, release and smoke in order", async () => {
  const fake = deps();
  const code = await deployFly({ ...defaults, root: workspace() }, fake.deps);
  assert.equal(code, 0);
  assert.deepEqual(fake.trace, [
    "fly version",
    "fly auth",
    "git status",
    "git rev-parse",
    "git log",
    "npm check:fast",
    "fly secrets list",
    "fly secrets import",
    "fly deploy",
    "GET /health",
    "POST /api/auth/provision",
    "GET /api/telemetry/system-status",
    "GET /api/members",
  ]);
});

test("--full runs check:standard and --skip-checks runs none", async () => {
  const full = deps();
  await deployFly({ ...defaults, full: true, root: workspace() }, full.deps);
  assert.ok(full.trace.includes("npm check:standard"));
  const skip = deps();
  await deployFly({ ...defaults, skipChecks: true, root: workspace() }, skip.deps);
  assert.ok(!skip.trace.some((step) => step.startsWith("npm")));
});

test("a dirty tree stops before any Fly write unless --allow-dirty", async () => {
  const dirty = deps({ dirty: " M file\n" });
  assert.equal(await deployFly({ ...defaults, root: workspace() }, dirty.deps), 1);
  assert.deepEqual(writes(dirty.flyCalls), []);
  const allowed = deps({ dirty: " M file\n" });
  assert.equal(
    await deployFly({ ...defaults, allowDirty: true, root: workspace() }, allowed.deps),
    0
  );
});

test("invalid .env.fly stops at pre-flight and names the keys", async () => {
  const fake = deps();
  const code = await deployFly({ ...defaults, root: workspace("ADMIN_PIN=0000\n") }, fake.deps);
  assert.equal(code, 1);
  assert.deepEqual(writes(fake.flyCalls), []);
  const text = fake.lines.join("\n");
  for (const key of ["MP_ACCESS_TOKEN", "MP_BOOTSTRAP_KEY", "ADMIN_PIN"])
    assert.match(text, new RegExp(key));
});

test("secrets are staged through stdin and extras are only unset with --prune", async () => {
  const keep = deps({ remoteSecrets: ["MP_ACCESS_TOKEN", "OLD_KEY"] });
  await deployFly({ ...defaults, root: workspace() }, keep.deps);
  const imported = keep.flyCalls.find(({ args }) => args[1] === "import");
  assert.deepEqual(imported.args, [
    "secrets",
    "import",
    "--stage",
    "--config",
    "infra/fly/fly.toml",
  ]);
  assert.ok(imported.options.input.includes(`MP_ACCESS_TOKEN=${SECRET}\n`));
  assert.equal(imported.options.quiet, true);
  assert.ok(!keep.flyCalls.some(({ args }) => args[1] === "unset"));
  assert.match(keep.lines.join("\n"), /OLD_KEY/);

  const prune = deps({ remoteSecrets: ["OLD_KEY"] });
  await deployFly({ ...defaults, prune: true, root: workspace() }, prune.deps);
  const unset = prune.flyCalls.find(({ args }) => args[1] === "unset");
  assert.deepEqual(unset.args, [
    "secrets",
    "unset",
    "--stage",
    "--config",
    "infra/fly/fly.toml",
    "OLD_KEY",
  ]);
});

test("--dry-run performs no Fly writes and prints the deploy command", async () => {
  const fake = deps();
  const root = workspace();
  assert.equal(await deployFly({ ...defaults, dryRun: true, root }, fake.deps), 0);
  assert.deepEqual(writes(fake.flyCalls), []);
  assert.ok(!fake.trace.some((step) => step.startsWith("POST") || step.startsWith("npm")));
  assert.match(fake.lines.join("\n"), /fly deploy \. --config infra\/fly\/fly\.toml --ha=false/);
});

test("a flyctl failure reports the step and exit code", async () => {
  const fake = deps({ flyCodes: { deploy: 3 } });
  assert.equal(await deployFly({ ...defaults, root: workspace() }, fake.deps), 1);
  assert.match(fake.lines.join("\n"), /deploy.*exit 3/);
  assert.ok(!fake.trace.includes("GET /health"));
});

test("release check waits until the new sha is serving", async () => {
  const late = deps({ shas: ["old1111", "old1111", SHA] });
  assert.equal(await deployFly({ ...defaults, root: workspace() }, late.deps), 0);
  assert.equal(late.trace.filter((step) => step === "GET /api/telemetry/system-status").length, 3);
  const stuck = deps({ shas: ["old1111"] });
  assert.equal(await deployFly({ ...defaults, root: workspace() }, stuck.deps), 1);
  assert.match(stuck.lines.join("\n"), /old1111/);
});

test("no secret value reaches the log", async () => {
  const fake = deps({ smokeStatus: 500 });
  await deployFly({ ...defaults, root: workspace() }, fake.deps);
  const text = fake.lines.join("\n");
  for (const sentinel of [SECRET, "mpk-BOOT-SENTINEL", "8642", "COOKIE-SENTINEL"])
    assert.ok(!text.includes(sentinel), sentinel);
});

test("--reprovision discards the cached smoke device", async () => {
  const root = workspace();
  writeFileSync(join(root, "infra/fly/.smoke-device"), "stale\n");
  const fake = deps();
  await deployFly({ ...defaults, reprovision: true, root }, fake.deps);
  assert.ok(fake.trace.includes("POST /api/auth/provision"));
  assert.ok(existsSync(join(root, "infra/fly/.smoke-device")));
});

test("a missing flyctl stops at pre-flight with install advice", async () => {
  const fake = deps();
  fake.deps.runFly = async () => {
    throw Object.assign(new Error("spawn flyctl ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await deployFly({ ...defaults, root: workspace() }, fake.deps), 1);
  assert.match(fake.lines.join("\n"), /pre-flight: flyctl not found.*brew install flyctl/);
});

test("a provisioning failure during the release check is reported as the release step", async () => {
  const fake = deps();
  const inner = fake.deps.fetch;
  fake.deps.fetch = async (url, init) =>
    new URL(url).pathname === "/api/auth/provision"
      ? new Response("{}", { status: 429 })
      : inner(url, init);
  assert.equal(await deployFly({ ...defaults, root: workspace() }, fake.deps), 1);
  assert.match(fake.lines.join("\n"), /✘ release: provisioning the smoke device failed \(429\)/);
});

test("a logged-out flyctl says how to log in", async () => {
  const fake = deps({ flyCodes: { auth: 1 } });
  assert.equal(await deployFly({ ...defaults, root: workspace() }, fake.deps), 1);
  assert.match(fake.lines.join("\n"), /pre-flight: .*fly auth login/);
});

test("only commands carrying secret values hide flyctl's stderr", async () => {
  const fake = deps({ remoteSecrets: ["OLD_KEY"] });
  await deployFly({ ...defaults, prune: true, root: workspace() }, fake.deps);
  for (const { args, options } of fake.flyCalls) {
    const carriesSecrets = args[0] === "secrets" && ["import", "unset"].includes(args[1]);
    assert.equal(Boolean(options.quiet), carriesSecrets, args.join(" "));
  }
});

test("a failed deploy warns that secrets are already staged", async () => {
  const fake = deps({ flyCodes: { deploy: 2 } });
  await deployFly({ ...defaults, root: workspace() }, fake.deps);
  assert.match(fake.lines.join("\n"), /staged on Fly.*next deploy or restart/);
});

test("the smoke device key never enters the Docker build context", () => {
  const lines = fs.readFileSync(new URL("../.dockerignore", import.meta.url), "utf8").split("\n");
  assert.ok(lines.includes("infra/fly/.smoke-device"));
});

test("the release check replaces a revoked (403) smoke device", async () => {
  const root = workspace();
  writeFileSync(join(root, "infra/fly/.smoke-device"), "revoked\n");
  const fake = deps();
  const inner = fake.deps.fetch;
  fake.deps.fetch = async (url, init = {}) =>
    new URL(url).pathname === "/api/telemetry/system-status" &&
    init.headers?.cookie === "mp_device_key=revoked"
      ? new Response("{}", { status: 403 })
      : inner(url, init);
  assert.equal(await deployFly({ ...defaults, root }, fake.deps), 0);
  assert.ok(fake.trace.includes("POST /api/auth/provision"));
});
