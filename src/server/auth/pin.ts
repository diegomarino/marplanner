import argon2 from "argon2";

/** Hash-compare a submitted PIN against a stored argon2 pin_hash.
 * Returns false instead of throwing when `pinHash` is malformed.
 */
export async function verifyPin(pinHash: string, submitted: string): Promise<boolean> {
  try {
    return await argon2.verify(pinHash, submitted);
  } catch {
    return false;
  }
}
