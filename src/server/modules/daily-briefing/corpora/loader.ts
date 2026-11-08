/** Corpus loader (trap-sweep probe).
 * PROBE RESULT (Constitution XIV, revised): a first pass used `readFileSync` at module init,
 * mirroring `../render/theme.ts`'s font-loading pattern — it type-checked and passed under
 * `vitest`, but FAILED closed the moment it ran from the actual built `dist/server/index.js`
 * bundle (`tests/integration/daily-briefing-catchup-e2e.test.ts`, the only test that boots the
 * REAL built entrypoint): `scripts/build-server.mjs`'s main server bundle has no asset-copy step
 * (unlike the SEPARATE small render-only bundle, which copies `render/fonts/* ` alongside itself
 * for exactly this reason) — a same-directory `readFileSync` at runtime found nothing next to the
 * bundled JS.
 * Fix: static `import x from "./y.json"` instead. esbuild's DEFAULT loader for `.json` files
 * parses and INLINES the content directly into the JS bundle at build time — no on-disk file to
 * ship or copy, so the main server bundle carries the corpora with zero build-script changes
 * (`scripts/build-server.mjs` is outside this module's touch-set). Type-checking the import needs no
 * `resolveJsonModule` change to the shared `tsconfig.server.json` (also outside this module's
 * touch-set): `./json-modules.d.ts`'s ambient `declare module "*.json"` covers it instead. Each
 * corpus's real shape is asserted by an explicit `as Type[]` cast here, exactly mirroring v1's own
 * `require("./x.json") as Type[]` (`content-corpora.ts`).
 */
import type {
  AnimalFactEntry,
  PhonicsWordEntry,
  NumberFactEntry,
  RiddleEntry,
  TextEntry,
  TriviaEntry,
  VocabularyEntry,
  WordSearchCorpusShape,
  WordSearchDifficulty,
  WouldYouRatherEntry,
} from "./types";
import type { CorpusLanguage } from "./block-types";

import jokesJson from "./jokes.json";
import riddlesJson from "./riddles.json";
import triviaQuestionsJson from "./trivia-questions.json";
import vocabularyEntriesJson from "./vocabulary-entries.json";
import animalFactsEnJson from "./animal-facts.json";
import animalFactsEsJson from "./animal-facts.es.json";
import numberFactsEnJson from "./number-facts.json";
import numberFactsEsJson from "./number-facts.es.json";
import drawingPromptsEnJson from "./drawing-prompts.json";
import drawingPromptsEsJson from "./drawing-prompts.es.json";
import wouldYouRathersEnJson from "./would-you-rathers.json";
import wouldYouRathersEsJson from "./would-you-rathers.es.json";
import wordSearchCorpusJson from "./word-search-corpus.json";
import phonicsWordsJson from "./phonics-words.json";

// ── EN-only corpora ──────────────────────────────────────────────────────────
export const dadJokesCorpus = jokesJson as TextEntry[];
export const riddlesCorpus = riddlesJson as RiddleEntry[];
export const triviaCorpus = triviaQuestionsJson as TriviaEntry[];
export const vocabularyCorpus = vocabularyEntriesJson as VocabularyEntry[];
export const phonicsCorpus = phonicsWordsJson as PhonicsWordEntry[];

// ── EN + ES corpora (INV-06: language variant = the `.es.json` sibling) ─────────────
export const animalFactsCorpus: Record<CorpusLanguage, AnimalFactEntry[]> = {
  en: animalFactsEnJson as AnimalFactEntry[],
  es: animalFactsEsJson as AnimalFactEntry[],
};
export const numberFactsCorpus: Record<CorpusLanguage, NumberFactEntry[]> = {
  en: numberFactsEnJson as NumberFactEntry[],
  es: numberFactsEsJson as NumberFactEntry[],
};
export const drawingPromptsCorpus: Record<CorpusLanguage, TextEntry[]> = {
  en: drawingPromptsEnJson as TextEntry[],
  es: drawingPromptsEsJson as TextEntry[],
};
export const wouldYouRathersCorpus: Record<CorpusLanguage, WouldYouRatherEntry[]> = {
  en: wouldYouRathersEnJson as WouldYouRatherEntry[],
  es: wouldYouRathersEsJson as WouldYouRatherEntry[],
};

// ── Word search (v1 `word-search-corpus.ts` port — same `pools`-only accessor) ──────────────────
const wordSearchRaw = wordSearchCorpusJson as WordSearchCorpusShape;

export function getWordSearchPool(difficulty: WordSearchDifficulty): string[] {
  return wordSearchRaw.pools[difficulty] ?? [];
}
