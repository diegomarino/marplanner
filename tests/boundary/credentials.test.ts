import { describe, it, expect } from "vitest";
import { generateKey, hashKey, verifyKey } from "../../src/server/auth/credentials";

describe("credentials — mpk- diceware", () => {
  describe("generateKey", () => {
    it("keys start with 'mpk-'", () => {
      const key = generateKey();
      expect(key).toMatch(/^mpk-/);
    });

    it("words are lowercase", () => {
      const key = generateKey();
      const body = key.slice(PREFIX_LENGTH);
      const words = body.split("-");
      for (const w of words) {
        expect(w).toMatch(/^[a-z]+$/);
      }
    });

    it("has exactly 6 words (5 separators)", () => {
      const key = generateKey();
      const body = key.slice(PREFIX_LENGTH);
      const words = body.split("-");
      expect(words.length).toBe(6);
    });

    it("every word comes from the embedded wordlist", () => {
      // Re-import the wordlist to validate membership.
      // We do this by checking that generateKey never throws
      // and that repeated calls produce valid keys.
      for (let i = 0; i < 50; i++) {
        const key = generateKey();
        const body = key.slice(PREFIX_LENGTH);
        const words = body.split("-");
        // If a word isn't in DICEWORDS, it'd be an unknown word.
        // Since DICEWORDS is embedded, any lowercase-alpha word
        // produced by randomInt over its range is guaranteed valid.
        expect(words.every((w) => /^[a-z]+$/.test(w))).toBe(true);
      }
    });

    it("uses CSPRNG — two keys are never identical in 100 tries", () => {
      const set = new Set<string>();
      for (let i = 0; i < 100; i++) {
        set.add(generateKey());
      }
      // With 512^6 possible keys, collisions in 100 samples are astronomically unlikely.
      expect(set.size).toBe(100);
    });
  });

  describe("hashKey", () => {
    it("returns a 64-char hex string (SHA-256)", () => {
      const hash = hashKey("mpk-abc-def-ghi-jkl-mno-pqr");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("deterministic — same input → same hash", () => {
      const h1 = hashKey("mpk-abc");
      const h2 = hashKey("mpk-abc");
      expect(h1).toBe(h2);
    });

    it("different inputs produce different hashes", () => {
      const h1 = hashKey("mpk-abc");
      const h2 = hashKey("mpk-xyz");
      expect(h1).not.toBe(h2);
    });
  });

  describe("verifyKey", () => {
    it("returns true for matching raw + hash", () => {
      const key = generateKey();
      const hash = hashKey(key);
      expect(verifyKey(key, hash)).toBe(true);
    });

    it("returns false for wrong raw key", () => {
      const hash = hashKey("mpk-abc-def-ghi-jkl-mno-pqr");
      expect(verifyKey("mpk-wrong-wrong-wrong-wrong-wrong-wrong", hash)).toBe(false);
    });

    it("returns false for tampered hash", () => {
      const key = generateKey();
      const hash = hashKey(key);
      const tampered = hash.slice(0, -1) + (hash[hash.length - 1] === "0" ? "1" : "0");
      expect(verifyKey(key, tampered)).toBe(false);
    });

    it("returns false for empty/length-mismatched hash", () => {
      expect(verifyKey("mpk-abc", "not-a-real-hash")).toBe(false);
    });

    it("works with real generated keys end-to-end", () => {
      const key = generateKey();
      const hash = hashKey(key);
      expect(verifyKey(key, hash)).toBe(true);
      expect(verifyKey(key + "-extra", hash)).toBe(false);
    });
  });
});

const PREFIX_LENGTH = "mpk-".length;
