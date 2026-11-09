// Register all supported briefing block renderers. Structural copy uses the household
// language through labels.ts; missing renderers remain visible as unrenderedBlocks.
import { createRegistry, type Registry } from "pressedslip";
import type { BlockRegistryType } from "../../../../shared/dailyBriefingBlocks";
import { animalFactBlock } from "./blocks/animal-fact";
import { birthdayBlock } from "./blocks/birthday";
import { dadJokeBlock } from "./blocks/dad-joke";
import { drawingPromptBlock } from "./blocks/drawing-prompt";
import { phonicsBlock } from "./blocks/phonics";
import { mealsBlock } from "./blocks/meals";
import { messageBlock } from "./blocks/message";
import { numberFactBlock } from "./blocks/number-fact";
import { onThisDayBlock } from "./blocks/on-this-day";
import { quoteOfDayBlock } from "./blocks/quote-of-day";
import { remindersBlock } from "./blocks/reminders";
import { riddleBlock } from "./blocks/riddle";
import { shotgunBlock } from "./blocks/shotgun";
import { streakBlock } from "./blocks/streak";
import { streakTextBlock } from "./blocks/streak-text";
import { todayBlock } from "./blocks/today";
import { triviaBlock } from "./blocks/trivia";
import { weatherBlock } from "./blocks/weather";
import { weatherTextBlock } from "./blocks/weather-text";
import { wordOfDayBlock } from "./blocks/word-of-day";
import { wordSearchBlock } from "./blocks/word-search";
import { wouldYouRatherBlock } from "./blocks/would-you-rather";

/** One render definition per catalogue block type; a missing entry fails typecheck. */
export const RENDER_BLOCKS = {
  shotgun: shotgunBlock,
  message: messageBlock,
  streak: streakBlock,
  today: todayBlock,
  weather: weatherBlock,
  meals: mealsBlock,
  birthday: birthdayBlock,
  reminders: remindersBlock,
  dadJoke: dadJokeBlock,
  wordOfDay: wordOfDayBlock,
  animalFact: animalFactBlock,
  numberFact: numberFactBlock,
  onThisDay: onThisDayBlock,
  quoteOfDay: quoteOfDayBlock,
  trivia: triviaBlock,
  riddle: riddleBlock,
  wouldYouRather: wouldYouRatherBlock,
  wordSearch: wordSearchBlock,
  drawingPrompt: drawingPromptBlock,
  streakText: streakTextBlock,
  weatherText: weatherTextBlock,
  phonics: phonicsBlock,
} satisfies Record<BlockRegistryType, { readonly type: string }>;

export const dailyBriefingRenderRegistry: Registry = createRegistry(Object.values(RENDER_BLOCKS));
