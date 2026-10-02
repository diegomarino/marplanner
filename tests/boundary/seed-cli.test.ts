import { describe, expect, it, vi } from "vitest";
import type { SeedRunReport, SeedRunRequest } from "../../src/server/db/seeds/types";

type Deps = {
  runSeedProfile: (request: SeedRunRequest) => Promise<SeedRunReport>;
  seedsDirectory?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};
type Run = (argv: readonly string[], dependencies: Deps) => Promise<number>;
async function load(): Promise<Run> {
  const module = await import("../../src/server/db/seeds/cli");
  const value = Reflect.get(module, "runSeedCli");
  expect(value).toBeTypeOf("function");
  return value as Run;
}
function harness() {
  const requests: SeedRunRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: Deps = {
    async runSeedProfile(request) {
      requests.push(request);
      return {
        mode: request.mode,
        asOfDate: "2026-09-23",
        moduleIds: ["public:settings"],
        markerAction: "created",
        status: "complete",
      };
    },
    seedsDirectory: "/synthetic/seeds",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  };
  return { dependencies, requests, output, errors };
}

describe("seed CLI adapter", () => {
  it("imports without running seeds, writing streams or changing exit status", async () => {
    const before = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await load();
      await Promise.resolve();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(before);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = before;
    }
  });
  it("runs the public profile with an injected directory and formats its report", async () => {
    const run = await load();
    const h = harness();
    expect(await run(["--mode", "public", "--as-of", "2026-09-23"], h.dependencies)).toBe(0);
    expect(h.requests).toEqual([
      {
        mode: "public",
        asOfDate: "2026-09-23",
        disposableTarget: true,
        seedsDirectory: "/synthetic/seeds",
      },
    ]);
    expect(h.output).toEqual([
      "mode=public as-of=2026-09-23 modules=[public:settings] status=complete\n",
    ]);
    expect(h.errors).toEqual([]);
  });
  it("accepts private mode and rejects invalid arguments before effects", async () => {
    const run = await load();
    const h = harness();
    expect(await run(["--mode", "private"], h.dependencies)).toBe(0);
    expect(h.requests[0]?.mode).toBe("private");
    for (const args of [
      ["--mode", "public", "--mode", "private"],
      ["--mode", "public", "--as-of", "yesterday"],
      ["--mode", "public", "--as-of"],
      ["--mode", "public", "--token=secret-value"],
      ["--mode", "other"],
    ]) {
      expect(await run(args, h.dependencies)).toBe(1);
    }
    expect(h.requests).toHaveLength(1);
    expect(h.errors).toHaveLength(5);
    expect(h.errors.join(" ")).not.toContain("secret-value");
  });
  it("contains runner failures and unknown thrown values", async () => {
    const run = await load();
    const h = harness();
    h.dependencies.runSeedProfile = async () => {
      throw new Error("token=secret-value");
    };
    expect(await run(["--mode", "public"], h.dependencies)).toBe(1);
    h.dependencies.runSeedProfile = async () => {
      throw "token=secret-value";
    };
    expect(await run(["--mode", "public"], h.dependencies)).toBe(1);
    expect(h.errors).toEqual(["Seed runner failed\n", "Seed runner failed\n"]);
    expect(h.output).toEqual([]);
  });
});

it("executes the real CLI entrypoint with storage ownership and releases it after seeding", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = mkdtempSync(join(tmpdir(), "mp-seed-entry-"));
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    writeFileSync(
      join(directory, "seed-000-storage.mjs"),
      'export default { id: "public:storage", run() {} };'
    );
    vi.stubEnv("DATA_DIR", directory);
    vi.stubEnv("DATABASE_PATH", "marplanner.db");
    vi.stubEnv("SEED_DIRECTORY", directory);
    const entry = fileURLToPath(new URL("../../src/server/db/seeds/cli.ts", import.meta.url));
    process.argv = [process.execPath, entry, "--mode", "public", "--as-of", "2026-10-02"];
    process.exitCode = undefined;
    vi.resetModules();
    await import("../../src/server/db/seeds/cli");
    await vi.waitFor(() => expect(process.exitCode).toBe(0));
    expect(stdout).toHaveBeenCalledWith(
      "mode=public as-of=2026-10-02 modules=[public:storage] status=complete\n"
    );
    const { acquireStorageOwnership } = await import("../../src/server/db/runtime-storage");
    const release = acquireStorageOwnership(join(directory, "marplanner.db"));
    release();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(directory, { recursive: true, force: true });
  }
});
