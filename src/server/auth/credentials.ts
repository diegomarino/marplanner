import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { EFF_WORDLIST } from "./eff-wordlist";

const WORD_COUNT = 6;
const SEPARATOR = "-";
const PREFIX = "mpk-";

// The key body is split on SEPARATOR to recover the words, so a word that itself
// contains the separator is indistinguishable from a word boundary — it inflates
// the token count and breaks the "WORD_COUNT words / WORD_COUNT-1 separators"
// invariant. The EFF large wordlist has 4 such entries (drop-down, felt-tip,
// t-shirt, yo-yo); exclude them once at load. Entropy loss is negligible
// (7772 vs 7776 words ≈ 0.003 bits over 6 words).
const WORD_POOL: readonly string[] = EFF_WORDLIST.filter((w) => !w.includes(SEPARATOR));

/** Generate a diceware-style credential key.
 * Picks WORD_COUNT random words from WORD_POOL (the EFF wordlist minus any
 * separator-containing entries) using Node's CSPRNG (crypto.randomInt) and joins
 * them with SEPARATOR. The result is prefixed with "mpk-" and is entirely lowercase.
 */
export function generateKey(): string {
  const words: string[] = [];
  for (let i = 0; i < WORD_COUNT; i++) {
    const idx = randomInt(WORD_POOL.length);
    words.push(WORD_POOL[idx]);
  }
  return PREFIX + words.join(SEPARATOR);
}

/** Hash a raw key to a SHA-256 hex digest.
 */
export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Verify a raw key against a stored hash.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * Returns true only when both strings match exactly.
 */
export function verifyKey(raw: string, hash: string): boolean {
  const expected = hashKey(raw);
  const rawBuf = Buffer.from(expected, "utf8");
  const hashBuf = Buffer.from(hash, "utf8");

  if (rawBuf.length !== hashBuf.length) {
    return false;
  }

  return timingSafeEqual(rawBuf, hashBuf);
}
