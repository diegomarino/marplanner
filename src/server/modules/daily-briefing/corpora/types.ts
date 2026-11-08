/** Hand-typed corpus entry shapes — ported verbatim from v1's
 * `apps/api/src/lib/daily-briefing/corpora/content-corpora.ts` ("typed loader with
 * compile-time shapes"). Kept separate from `./loader.ts` so tests can import shapes without
 * pulling in the (eager, disk-reading) loader module.
 */

export interface AnimalFactEntry {
  text: string;
  animal: string;
}

export interface TextEntry {
  text: string;
}

export interface RiddleEntry {
  question: string;
  answer: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface WouldYouRatherEntry {
  optionA: string;
  optionB: string;
}

export interface NumberFactEntry {
  number: number;
  fact: string;
  kind: "math" | "trivia";
}

export interface TriviaEntry {
  question: string;
  correctAnswer: string;
  options: string[];
  difficulty: "easy" | "medium" | "hard";
  category: string;
}

export interface VocabularyEntry {
  word: string;
  level: "L1" | "L2" | "L3" | "L4";
  type: string;
  definition: string;
  example: string | null;
  pronunciation: string | null;
}

/** One early-reader word (`phonics-words.json`). `graphemes` spell `word` exactly, one entry per
 * sound (`ship` -> `["sh", "i", "p"]`); `tricky` words are printed without sound buttons.
 */
export interface PhonicsWordEntry {
  word: string;
  level: "L1" | "L2" | "L3" | "L4";
  graphemes: string[];
  tricky: boolean;
}

export type WordSearchDifficulty = "easy" | "medium" | "hard";

/** The on-disk word-search corpus shape (v1 `word-search-corpus.ts`) is a superset of this —
 * `source`/`filters`/`thresholds`/`allWithFrequency` metadata is preserved unchanged on disk
 * ("copy unchanged") but only `pools` is actually consumed (v1 parity: v1's own
 * `getWordSearchPool` reads nothing else either).
 */
export interface WordSearchCorpusShape {
  pools: Record<WordSearchDifficulty, string[]>;
}
