#!/usr/bin/env node
/**
 * DEV-only: copy gitignored private seed overlays into this worktree's seeds/.
 *
 * Git worktrees do not carry untracked files. Keep canonical `seed*-PRIVATE.*`
 * in the primary checkout seeds/ (or MP_PRIVATE_SEEDS_DIR) and sync here before
 * `npm run seed`.
 *
 * Source resolution (first hit wins):
 * 1. --from <dir>
 * 2. MP_PRIVATE_SEEDS_DIR
 * 3. Primary git worktree seeds/ when cwd is another worktree
 * 4. This worktree seeds/ if it already has private files (no-op copy)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const PRIVATE_NAME = /^seed[a-z0-9_-]*-PRIVATE\.(?:[cm]?[jt]s?)$/;

try {
  loadEnvFile(resolve(ROOT, ".env.local"));
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
}

function usage() {
  return `Usage: node tools/dev/sync-private-seeds.mjs [--from <dir>] [--dry-run] [--prune]

Copies seed*-PRIVATE.* into ./seeds/ (gitignored).

  --from <dir>   canonical source directory
  --dry-run      print actions only
  --prune        remove local private seeds absent from the source

Environment:
  MP_PRIVATE_SEEDS_DIR   default source directory
`;
}

function parseArgs(argv) {
  let from;
  let dryRun = false;
  let prune = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--prune") {
      prune = true;
      continue;
    }
    if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
      continue;
    }
    if (arg === "--from") {
      const value = argv[++i];
      if (!value) throw new Error("--from requires a directory");
      from = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, from, dryRun, prune };
}

function listPrivateSeedNames(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => PRIVATE_NAME.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function primaryWorktreeRoot() {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const match = /^worktree (.+)$/m.exec(result.stdout);
  return match ? match[1] : null;
}

function resolveSourceDir(explicit) {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(ROOT, explicit);
    if (!existsSync(path)) throw new Error(`Private seeds source not found: ${path}`);
    return path;
  }
  const envDir = process.env.MP_PRIVATE_SEEDS_DIR?.trim();
  if (envDir) {
    const path = isAbsolute(envDir) ? envDir : resolve(ROOT, envDir);
    if (!existsSync(path)) throw new Error(`MP_PRIVATE_SEEDS_DIR not found: ${path}`);
    return path;
  }
  const primary = primaryWorktreeRoot();
  if (primary) {
    const candidate = join(primary, "seeds");
    if (resolve(primary) !== ROOT && existsSync(candidate)) return candidate;
    if (existsSync(candidate) && listPrivateSeedNames(candidate).length > 0) return candidate;
  }
  const local = join(ROOT, "seeds");
  if (existsSync(local) && listPrivateSeedNames(local).length > 0) return local;
  throw new Error(
    "No private seed source found. Set MP_PRIVATE_SEEDS_DIR, pass --from <dir>, or keep seed*-PRIVATE.* in the primary checkout seeds/."
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const sourceDir = resolveSourceDir(options.from);
  const destDir = join(ROOT, "seeds");
  const names = listPrivateSeedNames(sourceDir);

  if (names.length === 0) {
    console.log(
      JSON.stringify({
        type: "private-seeds-sync",
        sourceDir,
        destDir,
        copied: [],
        pruned: [],
        note: "source has no seed*-PRIVATE.* files",
        dryRun: options.dryRun,
      })
    );
    return;
  }

  if (resolve(sourceDir) === resolve(destDir)) {
    console.log(
      JSON.stringify({
        type: "private-seeds-sync",
        sourceDir,
        destDir,
        copied: [],
        pruned: [],
        note: "source is already this worktree seeds/",
        dryRun: options.dryRun,
      })
    );
    return;
  }

  mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const name of names) {
    if (!options.dryRun) copyFileSync(join(sourceDir, name), join(destDir, name));
    copied.push(name);
  }

  const pruned = [];
  if (options.prune) {
    for (const name of listPrivateSeedNames(destDir)) {
      if (names.includes(name)) continue;
      if (!options.dryRun) unlinkSync(join(destDir, name));
      pruned.push(name);
    }
  }

  console.log(
    JSON.stringify({
      type: "private-seeds-sync",
      sourceDir,
      destDir,
      copied,
      pruned,
      dryRun: options.dryRun,
    })
  );
}

try {
  main();
} catch (error) {
  console.error(`sync-private-seeds failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
