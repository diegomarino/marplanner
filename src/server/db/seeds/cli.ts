import { runSeedProfile, SeedRunnerError } from "./runner";
import type { SeedMode, SeedRunReport } from "./types";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseAsOfDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--as-of must use YYYY-MM-DD");
  }
  return value;
}

function parseArguments(argv: readonly string[]): { mode: SeedMode; asOfDate?: string } {
  let mode: SeedMode | undefined;
  let asOfDate: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      if (mode !== undefined) throw new Error("--mode may only be provided once");
      const value = argv[++index];
      if (value === "public" || value === "private") {
        mode = value;
        continue;
      }
      throw new Error("--mode must be public or private");
    }
    if (argument === "--as-of") {
      const value = argv[++index];
      if (!value) throw new Error("--as-of requires YYYY-MM-DD");
      asOfDate = parseAsOfDate(value);
      continue;
    }
    throw new Error("Unknown argument");
  }

  if (!mode) throw new Error("--mode must be public or private");
  return { mode, asOfDate };
}

function formatReport(report: SeedRunReport): string {
  return `mode=${report.mode} as-of=${report.asOfDate} modules=[${report.moduleIds.join(",")}] status=${report.status}`;
}

type SeedCliDependencies = {
  runSeedProfile: typeof runSeedProfile;
  seedsDirectory?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export async function runSeedCli(
  argv: readonly string[],
  dependencies: SeedCliDependencies
): Promise<number> {
  let arguments_: ReturnType<typeof parseArguments>;
  try {
    arguments_ = parseArguments(argv);
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : "Invalid arguments"}\n`);
    return 1;
  }
  try {
    const report = await dependencies.runSeedProfile({
      ...arguments_,
      disposableTarget: true,
      seedsDirectory: dependencies.seedsDirectory,
    });
    dependencies.stdout(`${formatReport(report)}\n`);
    return 0;
  } catch (error) {
    const safePublicModuleFailure =
      error instanceof SeedRunnerError &&
      /^Seed module failed: public:[a-z0-9-]+$/.test(error.message);
    dependencies.stderr(`${safePublicModuleFailure ? error.message : "Seed runner failed"}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runSeedCli(process.argv.slice(2), {
    runSeedProfile,
    seedsDirectory: process.env.SEED_DIRECTORY,
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
