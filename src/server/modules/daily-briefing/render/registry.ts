// Register all supported briefing block renderers. Structural copy uses the household
// language through labels.ts; missing renderers remain visible as unrenderedBlocks.
import { createRegistry, type Registry } from "pressedslip";
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

export const dailyBriefingRenderRegistry: Registry = createRegistry([
  messageBlock,
  quoteOfDayBlock,
  dadJokeBlock,
  wordOfDayBlock,
  wouldYouRatherBlock,
  riddleBlock,
  animalFactBlock,
  numberFactBlock,
  triviaBlock,
  onThisDayBlock,
  drawingPromptBlock,
  birthdayBlock,
  todayBlock,
  remindersBlock,
  mealsBlock,
  streakBlock,
  streakTextBlock,
  weatherBlock,
  weatherTextBlock,
  shotgunBlock,
  wordSearchBlock,
  phonicsBlock,
]);
