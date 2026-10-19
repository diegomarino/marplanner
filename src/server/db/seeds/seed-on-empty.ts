import { getDb } from "../client";
import { readSeedProfileMarker, SeedOwnershipError, type SeedProfileMarkerState } from "./ownership";
import { bundledPublicSeedModules } from "./public-modules";
import { runSeedProfile } from "./runner";
import type { SeedModule, SeedRunReport, SeedRunRequest } from "./types";

/** `MP_SEED_ON_EMPTY=true` seeds the public demo profile on the first boot of an empty database,
 * which is what the one-click deploy templates rely on. The private profile is never involved.
 *
 * It runs in the server process, which already holds the storage lock, and before
 * `reconcileBootstrap()`: the bootstrap key row would make the database look non-empty to the
 * ownership guard. Seeding is a convenience, so no outcome here ever stops the server booting.
 */
export type SeedOnEmptyOutcome = "disabled" | "seeded" | "repaired" | "skipped" | "refused" | "failed";

export interface SeedOnEmptyDependencies {
  env: NodeJS.ProcessEnv;
  readMarker: () => SeedProfileMarkerState;
  runSeed: (request: SeedRunRequest) => Promise<SeedRunReport>;
  modules: () => readonly SeedModule[] | undefined;
  log: Pick<Console, "log" | "warn" | "error">;
}

const defaultDependencies: SeedOnEmptyDependencies = {
  env: process.env,
  readMarker: () => readSeedProfileMarker(getDb()),
  runSeed: runSeedProfile,
  modules: bundledPublicSeedModules,
  log: console,
};

export function seedOnEmptyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MP_SEED_ON_EMPTY?.trim().toLowerCase();
  return value === "true" || value === "1";
}

export async function seedOnEmpty(
  overrides: Partial<SeedOnEmptyDependencies> = {}
): Promise<SeedOnEmptyOutcome> {
  const deps = { ...defaultDependencies, ...overrides };
  if (!seedOnEmptyEnabled(deps.env)) return "disabled";

  let marker: SeedProfileMarkerState;
  try {
    marker = deps.readMarker();
  } catch (err) {
    deps.log.error("Seed on empty: could not read the seed profile marker (continuing):", err);
    return "failed";
  }
  if (marker === "complete") {
    deps.log.log("Seed on empty: demo profile already seeded, skipping");
    return "skipped";
  }
  if (marker === "unrecognized") {
    deps.log.warn("Seed on empty: database holds another seed profile, leaving it untouched");
    return "refused";
  }

  try {
    // A "running" marker means a previous boot stopped mid-seed; rerunning repairs it.
    const report = await deps.runSeed({
      mode: "public",
      disposableTarget: true,
      modules: deps.modules(),
    });
    deps.log.log(
      `Seed on empty: demo profile ${marker === "running" ? "repaired" : "seeded"} as of ${report.asOfDate} (${report.moduleIds.length} modules)`
    );
    return marker === "running" ? "repaired" : "seeded";
  } catch (err) {
    if (err instanceof SeedOwnershipError) {
      deps.log.warn(
        `Seed on empty: database already holds data, leaving it untouched (${err.message})`
      );
      return "refused";
    }
    deps.log.error("Seed on empty: demo seed failed (continuing without it):", err);
    return "failed";
  }
}
