import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  deployArgs,
  parseSecretsList,
  planSecrets,
  readFlyApp,
  runFly,
  secretsImportPayload,
} from "./deploy/fly-cli.mjs";

function fakeSpawn(record, { code = 0, stdout = "" } = {}) {
  return (bin, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = "";
    child.stdin.on("data", (chunk) => (stdin += chunk));
    child.stdin.on("finish", () => {
      record.push({ bin, args, stdin });
      child.stdout.end(stdout);
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    });
    return child;
  };
}

test("readFlyApp reads the top-level app name", () => {
  const toml = 'app = "demo-app"\nprimary_region="ams"\n[build]\n  app = "no"\n';
  assert.equal(readFlyApp(toml), "demo-app");
});

test("readFlyApp refuses the template placeholder", () => {
  assert.throws(() => readFlyApp('app = "your-marplanner-app"\n'), /fly\.toml/);
  assert.throws(() => readFlyApp("[build]\n"), /fly\.toml/);
});

test("planSecrets stages every local key and reports added and extra names", () => {
  assert.deepEqual(planSecrets({ B: "1", A: "2" }, ["A", "OLD"]), {
    stage: ["A", "B"],
    added: ["B"],
    extra: ["OLD"],
  });
});

test("secretsImportPayload keeps =, # and spaces intact", () => {
  assert.equal(secretsImportPayload({ K: "a=b #c d" }), "K=a=b #c d\n");
});

test("secretsImportPayload rejects multi-line values by key name only", () => {
  assert.throws(
    () => secretsImportPayload({ K: "SENTINEL\nVALUE" }),
    (error) => error.message.includes("K") && !error.message.includes("SENTINEL")
  );
});

test("parseSecretsList accepts both flyctl name casings", () => {
  assert.deepEqual(parseSecretsList('[{"Name":"A"},{"name":"B"}]'), ["A", "B"]);
});

test("deployArgs pins single-machine remote deploys with build provenance", () => {
  assert.deepEqual(deployArgs({ sha: "abc1234", subject: "feat: x" }), [
    "deploy",
    ".",
    "--config",
    "infra/fly/fly.toml",
    "--ha=false",
    "--remote-only",
    "--build-arg",
    "MP_BUILD_SHA=abc1234",
    "--build-arg",
    "MP_BUILD_SUBJECT=feat: x",
  ]);
});

test("runFly sends secrets through stdin, never argv", async () => {
  const record = [];
  const result = await runFly(["secrets", "import", "--stage"], {
    input: "K=v-secret\n",
    quiet: true,
    spawn: fakeSpawn(record, { stdout: "ok" }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(record.length, 1);
  assert.ok(!record[0].args.join(" ").includes("v-secret"));
  assert.equal(record[0].stdin, "K=v-secret\n");
});

test("runFly can stream flyctl output to the terminal", async () => {
  let stdio;
  const spawn = (bin, args, options) => {
    stdio = options.stdio;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.on("finish", () => setImmediate(() => child.emit("close", 0)));
    return child;
  };
  const result = await runFly(["deploy"], { stream: true, spawn });
  assert.deepEqual(stdio, ["pipe", "inherit", "inherit"]);
  assert.equal(result.code, 0);
});
