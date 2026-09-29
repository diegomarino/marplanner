/** Deterministic seeded-selection helpers — ported verbatim from v1
 * (`apps/api/src/lib/daily-briefing/determinism.ts` + the `seededRandom`/`withSeededMathRandom`
 * pair from `blocks/word-search.ts`). Pure functions, no I/O, no module state beyond
 * the temporary `Math.random` swap `withSeededMathRandom` itself owns and always restores.
 * Per-block seed recipes (e.g. `${date}|joke`, `${date}|trivia|${memberId}`) are NOT this module's
 * concern — they are recorded per block in the v1 study and ported by the block generators,
 * which call `hashSeed`/`fisherYates` below with their own recipe strings.
 */
import { createHash } from "node:crypto";

/** SHA-1 of `input`, taken as an unsigned 32-bit integer (v1 exact recipe). */
export function hashSeed(input: string): number {
  const buf = createHash("sha1").update(input).digest();
  return buf.readUInt32BE(0);
}

// Mulberry32 seeded PRNG; constants are defined by the algorithm (v1 exact port).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates shuffle: the same `(items, seed)` pair always yields the same order. */
export function fisherYates<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A `Math.random`-shaped generator seeded by `mulberry32` — for libraries that call `Math.random` internally. */
export function seededRandom(seed: number): () => number {
  return mulberry32(seed);
}

/** Runs `fn` with the GLOBAL `Math.random` temporarily replaced by a seeded generator, always
 * restoring the original afterward (even on throw) — v1's confinement for third-party generators
 * (e.g. the word-search placement library) that offer no seed injection point of their own.
 * FR-020 requires the block loop calling this to be STRICTLY serial: this patch is process-global,
 * so two confined calls running concurrently would corrupt each other's randomness.
 */
export function withSeededMathRandom<T>(seed: number, fn: () => T): T {
  const originalRandom = Math.random;
  Math.random = seededRandom(seed);
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
}
