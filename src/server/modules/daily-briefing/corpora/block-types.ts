/** Server-side view of the briefing block catalogue. The declarations live in
 * `src/shared/dailyBriefingBlocks.ts` (one entry per block type); this module re-exports the
 * derived lists so existing `./corpora` imports keep working.
 */
export {
  ALL_BLOCK_TYPES,
  CORPUS_BLOCK_TYPES,
  CORPUS_LANGUAGE_AVAILABILITY,
  DEFAULT_DISABLED_BLOCK_TYPES,
  corpusLanguagesFor,
  isCorpusBackedBlockType,
  isCorpusLanguageAvailable,
  isKnownBlockType,
} from "../../../../shared/dailyBriefingBlocks";
export type {
  BlockRegistryType,
  CorpusBlockType,
  CorpusLanguage,
} from "../../../../shared/dailyBriefingBlocks";
