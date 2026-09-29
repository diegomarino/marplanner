/** Canonical briefing block types, shared by settings validation and generation order.
 * Corpus-backed blocks load local JSON; other blocks read domain or provider seams.
 */
export const ALL_BLOCK_TYPES = [
  "shotgun",
  "message",
  "streak",
  "today",
  "weather",
  "meals",
  "birthday",
  "reminders",
  "dadJoke",
  "wordOfDay",
  "animalFact",
  "numberFact",
  "onThisDay",
  "quoteOfDay",
  "trivia",
  "riddle",
  "wouldYouRather",
  "wordSearch",
  "drawingPrompt",
  "streakText",
  "weatherText",
] as const;

export type BlockRegistryType = (typeof ALL_BLOCK_TYPES)[number];

const ALL_BLOCK_TYPES_SET: ReadonlySet<string> = new Set(ALL_BLOCK_TYPES);

/** True for exactly the 21 registry types above — the write-boundary "known type" gate. */
export function isKnownBlockType(type: unknown): type is BlockRegistryType {
  return typeof type === "string" && ALL_BLOCK_TYPES_SET.has(type);
}

/** Block types default-disabled when no `daily_briefing_member_block_settings` row exists
 * (FR-013 — v1 parity: every other type defaults enabled). Consumed by `../settings.ts`'s * read-path default-resolution rule; no seed row is ever written for this.
 */
export const DEFAULT_DISABLED_BLOCK_TYPES: ReadonlySet<string> = new Set(["onThisDay"]);

/** Corpus-backed block types — the subset offering a `params.language` override (FR-008/FR-009). */
export const CORPUS_BLOCK_TYPES = [
  "dadJoke",
  "wordOfDay",
  "animalFact",
  "numberFact",
  "trivia",
  "riddle",
  "wouldYouRather",
  "wordSearch",
  "drawingPrompt",
] as const;

export type CorpusBlockType = (typeof CORPUS_BLOCK_TYPES)[number];

const CORPUS_BLOCK_TYPES_SET: ReadonlySet<string> = new Set(CORPUS_BLOCK_TYPES);

export function isCorpusBackedBlockType(type: unknown): type is CorpusBlockType {
  return typeof type === "string" && CORPUS_BLOCK_TYPES_SET.has(type);
}

export type CorpusLanguage = "en" | "es";

/** Which languages have an on-disk corpus for each corpus-backed type (INV-06).
 * `wordOfDay` (vocabulary) and `trivia` ship EN-only in v1 (no `.es.json` sibling exists);
 * `riddle` is EN-only BY POLICY (v1 study) even though a translated corpus could technically be
 * added later. `wordSearch` selects from an English word list — no translated variant exists.
 */
export const CORPUS_LANGUAGE_AVAILABILITY: Readonly<
  Record<CorpusBlockType, readonly CorpusLanguage[]>
> = {
  dadJoke: ["en"],
  wordOfDay: ["en"],
  animalFact: ["en", "es"],
  numberFact: ["en", "es"],
  trivia: ["en"],
  riddle: ["en"],
  wouldYouRather: ["en", "es"],
  wordSearch: ["en"],
  drawingPrompt: ["en", "es"],
};

export function corpusLanguagesFor(type: CorpusBlockType): readonly CorpusLanguage[] {
  return CORPUS_LANGUAGE_AVAILABILITY[type];
}

/** FR-009: true only when `type` is corpus-backed AND `language` has an on-disk corpus for it.
 * A non-corpus type (e.g. "message") or an unsupported language (e.g. riddle/es) both resolve to
 * `false` — the single check the settings write boundary needs for the 400
 * `corpus_language_unavailable` rejection.
 */
export function isCorpusLanguageAvailable(type: string, language: string): boolean {
  if (!isCorpusBackedBlockType(type)) return false;
  return (CORPUS_LANGUAGE_AVAILABILITY[type] as readonly string[]).includes(language);
}
