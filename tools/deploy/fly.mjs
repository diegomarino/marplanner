#!/usr/bin/env node
// npm run deploy:fly — pre-flight → checks → secrets from .env.fly → deploy → health →
// release check → smoke. Everything deployment-specific comes from the git-ignored
// infra/fly/fly.toml and .env.fly; see infra/fly/USING_FLYIO.md.
import { execFile, spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readFlyEnv, validateFlyEnv } from "./env.mjs";
import {
  deployArgs,
  FLY_CONFIG,
  parseSecretsList,
  planSecrets,
  readFlyApp,
  runFly,
  secretsImportPayload,
} from "./fly-cli.mjs";
import { deviceCookie, runSmoke, SMOKE_CACHE } from "./smoke.mjs";

const USAGE = `Usage: npm run deploy:fly -- [flags]
  --dry-run       Check and show the plan; change nothing
  --full          Run check:standard instead of check:fast
  --skip-checks   Skip the repository checks
  --skip-smoke    Skip the post-deploy smoke test
  --allow-dirty   Deploy with uncommitted changes
  --prune         Unset Fly secrets that are not in .env.fly
  --reprovision   Provision a new smoke device (applies a changed ADMIN_PIN)
  --url <url>     Public URL (default https://<app>.fly.dev)`;

const FLAGS = {
  "--full": "full",
  "--skip-checks": "skipChecks",
  "--skip-smoke": "skipSmoke",
  "--allow-dirty": "allowDirty",
  "--prune": "prune",
  "--dry-run": "dryRun",
  "--reprovision": "reprovision",
};

const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 3000;

/** @param {string[]} argv */
export function parseDeployArgs(argv) {
  const options = { url: null };
  for (const key of Object.values(FLAGS)) options[key] = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) options.url = argv[++i].replace(/\/+$/, "");
    else if (FLAGS[argv[i]]) options[FLAGS[argv[i]]] = true;
    else throw new Error(`Unknown flag: ${argv[i]}\n${USAGE}`);
  }
  return options;
}

class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

/**
 * @param {ReturnType<typeof parseDeployArgs> & { root?: string }} options
 * @param {{ runFly: typeof runFly, git: Function, runNpm: Function, fetch: typeof fetch,
 *   fs: typeof nodeFs, log: (line: string) => void, sleep: (ms: number) => Promise<void> }} deps
 * @returns {Promise<number>} process exit code
 */
export async function deployFly(options, deps) {
  const { git, runNpm, fetch, fs, log, sleep } = deps;
  const root = options.root ?? process.cwd();
  const cachePath = join(root, SMOKE_CACHE);
  const fly = async (step, args, flyOptions) => {
    let result;
    try {
      result = await deps.runFly(args, flyOptions);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new StepError(step, "flyctl not found on PATH (brew install flyctl)");
    }
    if (result.code !== 0) throw new StepError(step, `flyctl exit ${result.code}`);
    return result;
  };

  let staged = false;
  let deployed = false;
  try {
    log("▸ Pre-flight");
    await fly("pre-flight", ["version"]);
    await fly("pre-flight", ["auth", "whoami"]).catch((error) => {
      if (!(error instanceof StepError) || error.message.startsWith("flyctl not found"))
        throw error;
      throw new StepError("pre-flight", "not logged in to Fly (run fly auth login)");
    });
    let app;
    let env;
    try {
      app = readFlyApp(fs.readFileSync(join(root, FLY_CONFIG), "utf8"));
      env = readFlyEnv(join(root, ".env.fly"), fs);
    } catch (error) {
      throw new StepError("pre-flight", error.message);
    }
    const { errors } = validateFlyEnv(env);
    if (errors.length)
      throw new StepError("pre-flight", `.env.fly is not deployable:\n  ${errors.join("\n  ")}`);
    const baseUrl = options.url ?? `https://${app}.fly.dev`;

    log("▸ Git");
    const status = await git(["status", "--porcelain"]);
    if (status.stdout.trim() && !options.allowDirty)
      throw new StepError(
        "git",
        "working tree has uncommitted changes (use --allow-dirty to deploy anyway)"
      );
    const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
    const subject = (await git(["log", "-1", "--format=%s"])).stdout.trim();
    log(`  Deploying ${sha} "${subject}" to ${app}`);

    if (!options.skipChecks && !options.dryRun) {
      const script = options.full ? "check:standard" : "check:fast";
      log(`▸ npm run ${script}`);
      const code = await runNpm(script);
      if (code !== 0) throw new StepError("checks", `npm run ${script} exited ${code}`);
    }

    log("▸ Secrets");
    const remote = parseSecretsList(
      (await fly("secrets", ["secrets", "list", "--json", "--config", FLY_CONFIG])).stdout
    );
    const plan = planSecrets(env, remote);
    log(`  Staging ${plan.stage.length} keys from .env.fly: ${plan.stage.join(", ")}`);
    if (plan.added.length) log(`  New on Fly: ${plan.added.join(", ")}`);
    if (plan.extra.length)
      log(
        `  On Fly but not in .env.fly: ${plan.extra.join(", ")}${options.prune ? " (unsetting)" : " (kept; --prune unsets)"}`
      );
    const deployCommand = deployArgs({ sha, subject });
    if (options.dryRun) {
      log(`  Dry run — would run: fly ${deployCommand.join(" ")}`);
      return 0;
    }
    let payload;
    try {
      payload = secretsImportPayload(env);
    } catch (error) {
      throw new StepError("secrets", error.message);
    }
    await fly("secrets", ["secrets", "import", "--stage", "--config", FLY_CONFIG], {
      input: payload,
      quiet: true,
    });
    staged = true;
    if (options.prune && plan.extra.length)
      await fly("secrets", ["secrets", "unset", "--stage", "--config", FLY_CONFIG, ...plan.extra], {
        quiet: true,
      });

    log("▸ Deploy");
    await fly("deploy", deployCommand, { stream: true });
    deployed = true;

    log(`▸ Health ${baseUrl}/health`);
    await poll("health", sleep, async () => {
      const response = await fetch(`${baseUrl}/health`).catch(() => null);
      return response?.ok ? true : `last status ${response?.status ?? "unreachable"}`;
    });

    log("▸ Release");
    if (options.reprovision) fs.rmSync(cachePath, { force: true });
    const auth = { baseUrl, bootstrapKey: env.MP_BOOTSTRAP_KEY, cachePath, fetch, fs };
    let cookie = await asStep("release", () => deviceCookie(auth));
    let refreshed = options.reprovision;
    await poll("release", sleep, async () => {
      const response = await fetch(`${baseUrl}/api/telemetry/system-status`, {
        headers: { cookie: `mp_device_key=${cookie}`, accept: "application/json" },
      }).catch(() => null);
      if (response?.status === 401 && !refreshed) {
        refreshed = true;
        fs.rmSync(cachePath, { force: true });
        cookie = await asStep("release", () => deviceCookie(auth));
        return "smoke device re-provisioned";
      }
      if (!response?.ok) return `last status ${response?.status ?? "unreachable"}`;
      const serving = (await response.json().catch(() => null))?.build?.sha ?? "unknown";
      return serving === sha ? true : `serving ${serving}, expected ${sha}`;
    });
    log(`  ${sha} is serving`);

    if (!options.skipSmoke) {
      log("▸ Smoke");
      const spec = JSON.parse(fs.readFileSync(join(root, "docs/api/openapi.json"), "utf8"));
      const result = await asStep("smoke", () => runSmoke({ ...auth, spec, log }));
      if (result.failures.length)
        throw new StepError(
          "smoke",
          `${result.failures.length} route(s) failed: ${result.failures.join(", ")}`
        );
    }

    log(`✔ Deployed ${sha} to ${baseUrl}`);
    log(
      "  ADMIN_PIN applies only when a device provisions; run with --reprovision after changing it."
    );
    return 0;
  } catch (error) {
    if (!(error instanceof StepError)) throw error;
    log(`✘ ${error.step}: ${error.message}`);
    if (staged && !deployed)
      log("  Secrets from .env.fly are staged on Fly and apply at the next deploy or restart.");
    return 1;
  }
}

/** Runs `fn`, reporting any plain error as a failure of `step`. */
async function asStep(step, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof StepError) throw error;
    throw new StepError(step, error.message);
  }
}

async function poll(step, sleep, attempt) {
  let last = "";
  for (let i = 1; i <= POLL_ATTEMPTS; i++) {
    const outcome = await attempt();
    if (outcome === true) return;
    last = outcome;
    if (i < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  throw new StepError(step, `gave up after ${POLL_ATTEMPTS} attempts (${last})`);
}

const execFileAsync = promisify(execFile);

async function main() {
  const options = parseDeployArgs(process.argv.slice(2));
  const code = await deployFly(options, {
    runFly,
    git: async (args) => ({ code: 0, stdout: (await execFileAsync("git", args)).stdout }),
    runNpm: (script) =>
      new Promise((resolve) => {
        const child = spawn("npm", ["run", script], { stdio: "inherit" });
        child.on("close", (exitCode) => resolve(exitCode ?? 1));
      }),
    fetch: globalThis.fetch,
    fs: nodeFs,
    log: console.log,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
