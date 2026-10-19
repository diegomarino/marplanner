import type { SeedModule } from "./types";

/** Public seed modules compiled into the production server bundle, which ships without the
 * `seeds/` directory and without a TypeScript loader. `scripts/seed-bundle-plugin.mjs` replaces
 * this file at build time with static imports of every public `seeds/seed-NNN-*.ts`. Under tsx
 * (development, tests, the seed CLI) it returns undefined and the runner discovers `seeds/`.
 */
export function bundledPublicSeedModules(): readonly SeedModule[] | undefined {
  return undefined;
}
