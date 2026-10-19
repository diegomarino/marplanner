import type { DatabaseConnection } from "../client";

export type SeedMode = "public" | "private";

export interface SeedContext {
  db: DatabaseConnection;
  asOfDate: string;
  nowMs: number;
}

export interface SeedModule {
  id: string;
  run(context: SeedContext): void | Promise<void>;
}

export interface SeedRunRequest {
  mode: SeedMode;
  asOfDate?: string;
  nowMs?: number;
  /** Direct callers must explicitly acknowledge that this target is disposable. */
  disposableTarget: boolean;
  /** Test-only or operator-provided module location; defaults to the repository's seeds directory. */
  seedsDirectory?: string;
  /** Preloaded public modules (the production bundle has no seeds directory). When set, directory
   * discovery is skipped; module ids are still validated and must be unique. Public mode only. */
  modules?: readonly SeedModule[];
  /** Seed started by the server itself (MP_SEED_ON_EMPTY): rows the server writes on its own are
   * tolerated, and a failure after the ownership check discards the partial profile. Public only. */
  serverBoot?: boolean;
  /** Test-only migration location; defaults to the repository's drizzle directory. */
  migrationsDirectory?: string;
}

export interface SeedRunReport {
  mode: SeedMode;
  asOfDate: string;
  /** Public module IDs plus ordinal-safe labels for private overlays. */
  moduleIds: readonly string[];
  markerAction: "created" | "repair" | "rerun";
  status: "complete";
}
