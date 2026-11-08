/** Corpus port barrel — the single import surface for both `../
 * settings.ts` (block-type/language validation) and the future block generators.
 */
export * from "./block-types";
export type {
  AnimalFactEntry,
  FirstWordsEntry,
  NumberFactEntry,
  RiddleEntry,
  TextEntry,
  TriviaEntry,
  VocabularyEntry,
  WordSearchCorpusShape,
  WordSearchDifficulty,
  WouldYouRatherEntry,
} from "./types";
export { hashSeed, fisherYates, seededRandom, withSeededMathRandom } from "./determinism";
export {
  animalFactsCorpus,
  dadJokesCorpus,
  drawingPromptsCorpus,
  firstWordsCorpus,
  getWordSearchPool,
  numberFactsCorpus,
  riddlesCorpus,
  triviaCorpus,
  vocabularyCorpus,
  wouldYouRathersCorpus,
} from "./loader";
