import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

test("tracked checkout inventory comes from git and rejects untracked files", async () => {
  const { candidateIdentity } = await import("./candidate-identity.mjs");
  const root = mkdtempSync(join(tmpdir(), "candidate-git-"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git(["init", "-b", "main"]);
    writeFileSync(join(root, "tracked.txt"), "tracked");
    git(["add", "tracked.txt"]);
    const original = candidateIdentity(root);
    assert.match(original, /^[a-f0-9]{64}$/);
    writeFileSync(join(root, "notes.txt"), "untracked");
    assert.throws(() => candidateIdentity(root), /tracked files/i);
    rmSync(join(root, "notes.txt"));
    assert.equal(candidateIdentity(root), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI binds the checked-out tree instead of a stale embedded candidate hash", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const workflow = readFileSync(".github/workflows/coverage.yml", "utf8");
  assert.doesNotMatch(workflow, /MP_CANDIDATE_ID:\s*[a-f0-9]{64}/);
  const config = load(workflow);
  assert.deepEqual(Object.keys(config.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(config.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(config.jobs).sort(), [
    "container",
    "full",
    "native",
    "select",
    "standard",
  ]);
  assert.deepEqual(config.jobs.full.needs, ["select", "standard", "native", "container"]);
  assert.equal(config.jobs.full.if, "${{ always() }}");
  assert.equal(
    config.jobs.container["runs-on"],
    "${{ fromJSON(needs.select.outputs.container_runner) }}"
  );
  assert.deepEqual(config.jobs.container.needs, ["select"]);
  for (const job of ["standard", "native"]) {
    assert.equal(config.jobs[job]["runs-on"], "${{ fromJSON(needs.select.outputs.runner) }}");
    assert.ok(config.jobs[job].needs.includes("select"));
  }
  assert.equal(config.jobs.select.uses, "./.github/workflows/mac-mini-ci.yml");
  const steps = (job) => config.jobs[job].steps;
  const commands = (job) =>
    steps(job)
      .filter((step) => step.run)
      .map((step) => step.run);
  const root = mkdtempSync(join(tmpdir(), "candidate-ci-"));
  try {
    mkdirSync(join(root, "tools"));
    copyFileSync("tools/candidate-identity.mjs", join(root, "tools/candidate-identity.mjs"));
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-b", "main"]);
    writeFileSync(join(root, "tracked.txt"), "tracked");
    git(["add", "tracked.txt"]);
    writeFileSync(join(root, "extra.txt"), "untracked");
    for (const job of ["standard", "native", "container"]) {
      const run = commands(job).find((run) => run.includes("node tools/candidate-identity.mjs"));
      assert.ok(run);
      const envFile = join(root, `${job}-env`);
      const result = spawnSync("bash", ["-e", "-c", run], {
        cwd: root,
        env: { ...process.env, GITHUB_ENV: envFile },
        encoding: "utf8",
      });
      assert.match(result.stderr, /Candidate inventory differs/);
      assert.notEqual(result.status, 0, `${job} must stop when candidate identity fails`);
      assert.equal(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(commands("standard").filter((run) => run === "npm run check:standard").length, 1);
  assert.ok(commands("native").includes("npm run check:aggregate-only"));
  assert.ok(!commands("native").some((run) => /check:(standard|full)|cohorts:stamp/.test(run)));
  const upload = steps("standard").find(
    (step) => step.uses?.split("@")[0] === "actions/upload-artifact"
  );
  const download = steps("native").find(
    (step) => step.uses?.split("@")[0] === "actions/download-artifact"
  );
  assert.equal(
    upload.with.name,
    "standard-evidence-${{ github.run_id }}-${{ github.run_attempt }}"
  );
  assert.equal(download.with.name, upload.with.name);
  assert.equal(upload.with.overwrite, true);
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "warn");
  assert.ok(
    commands("standard").some((run) => run.includes('if [ "${#paths[@]}" -eq 0 ]; then exit 0; fi'))
  );
  assert.ok(
    commands("standard").some((run) =>
      run.includes('tar --format=pax -czf "$RUNNER_TEMP/standard-evidence.tar.gz"')
    )
  );
  assert.ok(
    commands("native").some(
      (run) => run === 'tar -xzf "$RUNNER_TEMP/standard-evidence/standard-evidence.tar.gz"'
    )
  );
  const gate = config.jobs.full.steps[0].run;
  const passing = Object.fromEntries(
    config.jobs.full.needs.map((name) => [name, { result: "success" }])
  );
  for (const status of ["success", "failure", "cancelled", "skipped"]) {
    for (const name of config.jobs.full.needs) {
      const results = structuredClone(passing);
      results[name].result = status;
      const result = spawnSync("bash", ["-e", "-c", gate], {
        env: { ...process.env, RESULTS: JSON.stringify(results) },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, status === "success", `${name}: ${status}`);
    }
  }
  assert.equal(existsSync(".github/workflows/full-gate.yml"), false);
});

test("time-announcements browser check runs only when requested and stays off the mac mini", async () => {
  const { readFileSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const workflow = load(readFileSync(".github/workflows/time-announcements.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.pull_request.types, ["labeled"]);
  assert.equal(workflow.on.push, undefined);
  const job = workflow.jobs["time-announcements"];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.match(job.if, /workflow_dispatch/);
  assert.match(job.if, /e2e-time-announcements/);
  const commands = job.steps.filter((step) => step.run).map((step) => step.run);
  assert.ok(commands.includes("npm run test:e2e:time-announcements"));
  assert.equal(
    commands.some((run) => /check:(standard|aggregate-only|full)/.test(run)),
    false
  );
  assert.equal(JSON.stringify(workflow).includes("macmini"), false);
});

test("runner selector queues trusted jobs and requires explicit hosted execution", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  const selector = load(readFileSync(".github/workflows/mac-mini-ci.yml", "utf8"));
  const coverage = load(readFileSync(".github/workflows/coverage.yml", "utf8"));
  const step = selector.jobs.select.steps[0];
  assert.match(step.env.TRUSTED, /head.repo.full_name == github.repository/);
  const trust = (actor, author, repository = "test/repo") => {
    const github = {
      actor,
      repository: "test/repo",
      event: author
        ? { pull_request: { user: { login: author }, head: { repo: { full_name: repository } } } }
        : {},
    };
    return Function("github", `return ${step.env.TRUSTED.slice(3, -2)}`)(github);
  };
  assert.equal(trust("maintainer", "maintainer"), true);
  assert.equal(trust("maintainer"), true);
  assert.equal(trust("contributor", "contributor", "fork/repo"), false);
  assert.equal(trust("dependabot[bot]", "dependabot[bot]"), false);
  assert.equal(trust("maintainer", "dependabot[bot]"), false);
  assert.equal(trust("dependabot[bot]"), false);
  assert.equal(step.env.FORCE_HOSTED, "${{ inputs.force_hosted || false }}");
  assert.equal(step.env.RUNNER_READ_TOKEN, undefined);
  assert.equal(coverage.jobs.select.secrets, undefined);
  for (const workflow of [selector, coverage]) {
    assert.equal(workflow.on.workflow_dispatch.inputs.force_hosted.type, "boolean");
    assert.equal(workflow.on.workflow_dispatch.inputs.force_hosted.default, false);
  }
  assert.equal(
    selector.on.workflow_call.outputs.container_runner.value,
    "${{ jobs.select.outputs.container_runner }}"
  );
  const script = step.run.split("python3 - <<'PY'\n")[1].split("\nPY")[0];
  const local = ["self-hosted", "macOS", "macmini"];
  const root = mkdtempSync(join(tmpdir(), "runner-selector-"));
  try {
    for (const [label, changes, trusted, forced, token, throws, expected, container] of [
      ["idle", {}, "true", "false", "test", false, local, local],
      ["busy", { busy: true }, "true", "false", "test", false, local, local],
      ["offline", { status: "offline" }, "true", "false", "test", false, local, local],
      ["disconnected", { runners: [] }, "true", "false", "test", false, local, local],
      ["lookup failure", {}, "true", "false", "test", true, local, local],
      ["no credentials", {}, "true", "false", "", true, local, local],
      ["fork", {}, "false", "false", "", true, ["ubuntu-latest"], ["ubuntu-latest"]],
      ["unknown trust", {}, "", "false", "", true, ["ubuntu-latest"], ["ubuntu-latest"]],
      [
        "dependabot",
        {},
        String(trust("dependabot[bot]", "dependabot[bot]")),
        "false",
        "",
        true,
        ["ubuntu-latest"],
        ["ubuntu-latest"],
      ],
      [
        "dependabot rerun",
        {},
        String(trust("maintainer", "dependabot[bot]")),
        "false",
        "",
        true,
        ["ubuntu-latest"],
        ["ubuntu-latest"],
      ],
      ["forced", {}, "true", "true", "", true, ["ubuntu-latest"], ["ubuntu-latest"]],
      ["forced fork", {}, "false", "true", "", true, ["ubuntu-latest"], ["ubuntu-latest"]],
    ]) {
      const output = join(root, label);
      const runner = {
        name: "macmini",
        status: "online",
        busy: false,
        labels: local.map((name) => ({ name })),
        ...changes,
      };
      const response = changes.runners ? changes : { runners: [runner] };
      const setup = throws
        ? "import urllib.request\ndef unavailable(*args, **kwargs):\n    raise OSError('lookup unavailable')\nurllib.request.urlopen = unavailable\n"
        : `import io, urllib.request\nurllib.request.urlopen = lambda *args, **kwargs: io.StringIO(${JSON.stringify(JSON.stringify(response))})\n`;
      const result = spawnSync("python3", ["-c", setup + script], {
        env: {
          ...process.env,
          ...step.env,
          RUNNER_READ_TOKEN: token,
          REPOSITORY: "test/repo",
          TRUSTED: trusted,
          FORCE_HOSTED: forced,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      const outputs = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const [key, value] = line.split("=");
            return [key, JSON.parse(value)];
          })
      );
      assert.deepEqual(outputs.runner, expected, label);
      assert.deepEqual(outputs.container_runner, container, label);
    }
    const dockerCheck = coverage.jobs.container.steps.find(
      (step) => step.name === "Require a configured Linux Docker engine"
    ).run;
    mkdirSync(join(root, "bin"));
    for (const [name, command, status] of [
      ["linux", "echo linux", 0],
      ["wrong engine", "echo windows", 1],
      ["unavailable", "exit 1", 1],
    ]) {
      writeFileSync(join(root, "bin", "docker"), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
      const result = spawnSync("bash", ["-e", "-c", dockerCheck], {
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
        encoding: "utf8",
      });
      assert.equal(result.status, status, name);
      if (status) assert.match(result.stdout, /::error::.*Linux Docker engine.*force_hosted=true/);
    }
    for (const labels of ["", "[]", "invalid", '["self-hosted"]', '["self-hosted","macOS",null]']) {
      const output = join(root, `missing-${labels.length}`);
      const result = spawnSync("python3", ["-c", script], {
        env: {
          ...process.env,
          TRUSTED: "true",
          FORCE_HOSTED: "false",
          LOCAL_RUNNER_LABELS: labels,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /LOCAL_RUNNER_LABELS.*self-hosted.*macOS.*macmini/
      );
      assert.equal(existsSync(output), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
