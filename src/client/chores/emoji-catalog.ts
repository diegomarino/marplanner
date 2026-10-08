import type { MessageKey } from "@/i18n/messages";

export interface EmojiCatalogItem {
  emoji: string;
  label: MessageKey;
  keywords: string[];
}

export interface EmojiCategory {
  id: string;
  name: MessageKey;
  items: EmojiCatalogItem[];
}

/** Curated catalog of emojis grouped by semantic category for chore and routine assignment.
 * Categories are ordered from most-used to least-used, so the first options presented to
 * the user are the most relevant for everyday family planner tasks.
 */
export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "daily",
    name: "routines.emojiPicker.category.daily-routines",
    items: [
      { emoji: "⏰", label: "routines.emojiPicker.icon.alarm", keywords: ["alarm", "wake"] },
      { emoji: "🌅", label: "routines.emojiPicker.icon.sunrise", keywords: ["morning", "sunrise"] },
      { emoji: "🌙", label: "routines.emojiPicker.icon.night", keywords: ["night", "evening"] },
      { emoji: "🛏️", label: "routines.emojiPicker.icon.bed", keywords: ["bed", "sleep"] },
      { emoji: "🪥", label: "routines.emojiPicker.icon.toothbrush", keywords: ["teeth", "brush"] },
      { emoji: "🚿", label: "routines.emojiPicker.icon.shower", keywords: ["shower", "bath"] },
      { emoji: "👕", label: "routines.emojiPicker.icon.clothes", keywords: ["dress", "clothes"] },
      {
        emoji: "👘",
        label: "routines.emojiPicker.icon.pajamas",
        keywords: ["pajamas", "sleepwear", "night"],
      },
      {
        emoji: "👟",
        label: "routines.emojiPicker.icon.shoe",
        keywords: ["shoe", "sneakers", "footwear"],
      },
      { emoji: "🎒", label: "routines.emojiPicker.icon.backpack", keywords: ["school", "bag"] },
      {
        emoji: "👔",
        label: "routines.emojiPicker.icon.blazer-tie",
        keywords: ["blazer", "tie", "formal", "work"],
      },
      {
        emoji: "🪮",
        label: "routines.emojiPicker.icon.hair-brush",
        keywords: ["hair", "brush", "comb", "grooming"],
      },
      {
        emoji: "👱‍♀️",
        label: "routines.emojiPicker.icon.ponytail",
        keywords: ["ponytail", "hair", "coleta", "pelo", "peinar"],
      },
      {
        emoji: "🔇",
        label: "routines.emojiPicker.icon.silence",
        keywords: ["silence", "mute", "quiet"],
      },
    ],
  },
  {
    id: "home",
    name: "routines.emojiPicker.category.home-cleaning",
    items: [
      { emoji: "🧹", label: "routines.emojiPicker.icon.broom", keywords: ["clean", "sweep"] },
      { emoji: "🧺", label: "routines.emojiPicker.icon.laundry", keywords: ["laundry", "wash"] },
      { emoji: "🧼", label: "routines.emojiPicker.icon.soap", keywords: ["soap", "clean"] },
      { emoji: "🧽", label: "routines.emojiPicker.icon.sponge", keywords: ["kitchen", "clean"] },
      { emoji: "🗑️", label: "routines.emojiPicker.icon.trash", keywords: ["trash", "bin"] },
      { emoji: "🪣", label: "routines.emojiPicker.icon.bucket", keywords: ["bucket", "clean"] },
      { emoji: "🧴", label: "routines.emojiPicker.icon.lotion", keywords: ["care", "hygiene"] },
      {
        emoji: "🧪",
        label: "routines.emojiPicker.icon.spray-bottle",
        keywords: ["spray", "bottle", "cleaning"],
      },
      {
        emoji: "🫧",
        label: "routines.emojiPicker.icon.dishwasher",
        keywords: ["dishwasher", "dishes", "kitchen", "clean"],
      },
      {
        emoji: "🧫",
        label: "routines.emojiPicker.icon.dishwasher-open",
        keywords: ["dishwasher", "appliance", "open", "kitchen", "dishes"],
      },
      {
        emoji: "🧯",
        label: "routines.emojiPicker.icon.spray",
        keywords: ["spray", "bottle", "cleaning"],
      },
      { emoji: "🪴", label: "routines.emojiPicker.icon.plant", keywords: ["plants", "garden"] },
    ],
  },
  {
    id: "food",
    name: "routines.emojiPicker.category.food-kitchen",
    items: [
      { emoji: "🍳", label: "routines.emojiPicker.icon.cook", keywords: ["cook", "breakfast"] },
      { emoji: "🥣", label: "routines.emojiPicker.icon.bowl", keywords: ["breakfast", "cereal"] },
      { emoji: "🍽️", label: "routines.emojiPicker.icon.meal", keywords: ["meal", "eat"] },
      { emoji: "🥪", label: "routines.emojiPicker.icon.sandwich", keywords: ["lunch", "snack"] },
      { emoji: "🍎", label: "routines.emojiPicker.icon.apple", keywords: ["fruit", "snack"] },
      { emoji: "🥕", label: "routines.emojiPicker.icon.carrot", keywords: ["veggie", "food"] },
      { emoji: "🥛", label: "routines.emojiPicker.icon.milk", keywords: ["drink", "milk"] },
      {
        emoji: "🥤",
        label: "routines.emojiPicker.icon.water-glass",
        keywords: ["water", "glass", "drink"],
      },
      { emoji: "🍞", label: "routines.emojiPicker.icon.bread", keywords: ["bread", "food"] },
    ],
  },
  {
    id: "school",
    name: "routines.emojiPicker.category.school-study",
    items: [
      { emoji: "📚", label: "routines.emojiPicker.icon.books", keywords: ["study", "homework"] },
      { emoji: "📝", label: "routines.emojiPicker.icon.write", keywords: ["write", "notes"] },
      { emoji: "✏️", label: "routines.emojiPicker.icon.pencil", keywords: ["pencil", "study"] },
      { emoji: "📖", label: "routines.emojiPicker.icon.reading", keywords: ["read", "book"] },
      { emoji: "🎓", label: "routines.emojiPicker.icon.graduation", keywords: ["school", "class"] },
      { emoji: "🧠", label: "routines.emojiPicker.icon.brain", keywords: ["focus", "learn"] },
      { emoji: "🧮", label: "routines.emojiPicker.icon.abacus", keywords: ["math", "numbers"] },
      {
        emoji: "💻",
        label: "routines.emojiPicker.icon.computer",
        keywords: ["computer", "online"],
      },
      {
        emoji: "🎼",
        label: "routines.emojiPicker.icon.musical-score",
        keywords: ["music", "música", "musica", "pentagrama", "clave de sol"],
      },
      {
        emoji: "🎵",
        label: "routines.emojiPicker.icon.musical-note",
        keywords: ["music", "música", "musica", "nota"],
      },
      {
        emoji: "🎶",
        label: "routines.emojiPicker.icon.musical-notes",
        keywords: ["music", "música", "musica", "notas"],
      },
      {
        emoji: "🎸",
        label: "routines.emojiPicker.icon.guitar",
        keywords: ["guitar", "guitarra", "music", "música", "musica"],
      },
      {
        emoji: "🎹",
        label: "routines.emojiPicker.icon.piano",
        keywords: ["piano", "music", "practice"],
      },
    ],
  },
  {
    id: "sports",
    name: "routines.emojiPicker.category.sports-activity",
    items: [
      {
        emoji: "⚽",
        label: "routines.emojiPicker.icon.football",
        keywords: ["football", "futbol", "match", "partido"],
      },
      {
        emoji: "🏀",
        label: "routines.emojiPicker.icon.basketball",
        keywords: ["basketball", "sport"],
      },
      { emoji: "🏊", label: "routines.emojiPicker.icon.swimming", keywords: ["swim", "pool"] },
      { emoji: "🚴", label: "routines.emojiPicker.icon.cycling", keywords: ["bike", "cycling"] },
      { emoji: "🏃", label: "routines.emojiPicker.icon.running", keywords: ["run", "exercise"] },
      { emoji: "🎾", label: "routines.emojiPicker.icon.tennis", keywords: ["tennis", "sport"] },
      {
        emoji: "🥋",
        label: "routines.emojiPicker.icon.martial-arts",
        keywords: ["karate", "martial"],
      },
      {
        emoji: "🏋️",
        label: "routines.emojiPicker.icon.gym",
        keywords: ["gym", "weights", "gimnasio", "pesas", "exercise"],
      },
      { emoji: "🧘", label: "routines.emojiPicker.icon.yoga", keywords: ["yoga", "calm"] },
      { emoji: "🚗", label: "routines.emojiPicker.icon.car", keywords: ["car", "drive", "trip"] },
      {
        emoji: "🧳",
        label: "routines.emojiPicker.icon.sports-bag",
        keywords: ["sports", "bag", "duffel", "training"],
      },
    ],
  },
  {
    id: "health",
    name: "routines.emojiPicker.category.health-care",
    items: [
      { emoji: "💊", label: "routines.emojiPicker.icon.medicine", keywords: ["medicine", "pill"] },
      {
        emoji: "🌡️",
        label: "routines.emojiPicker.icon.thermometer",
        keywords: ["fever", "temperature"],
      },
      { emoji: "🩹", label: "routines.emojiPicker.icon.bandage", keywords: ["injury", "care"] },
      {
        emoji: "🏥",
        label: "routines.emojiPicker.icon.hospital",
        keywords: ["doctor", "hospital"],
      },
      { emoji: "😴", label: "routines.emojiPicker.icon.sleep", keywords: ["sleep", "rest"] },
      { emoji: "🦷", label: "routines.emojiPicker.icon.dentist", keywords: ["teeth", "dentist"] },
      { emoji: "👓", label: "routines.emojiPicker.icon.glasses", keywords: ["vision", "glasses"] },
      { emoji: "❤️", label: "routines.emojiPicker.icon.heart", keywords: ["love", "care"] },
    ],
  },
  {
    id: "events",
    name: "routines.emojiPicker.category.events-celebration",
    items: [
      {
        emoji: "🎂",
        label: "routines.emojiPicker.icon.birthday",
        keywords: ["birthday", "cumple", "cumpleanos", "fiesta"],
      },
      {
        emoji: "🎉",
        label: "routines.emojiPicker.icon.party-popper",
        keywords: ["party", "celebration"],
      },
      { emoji: "🎁", label: "routines.emojiPicker.icon.gift", keywords: ["gift", "present"] },
      { emoji: "🎈", label: "routines.emojiPicker.icon.balloon", keywords: ["birthday", "party"] },
      { emoji: "🎊", label: "routines.emojiPicker.icon.confetti", keywords: ["party", "event"] },
      {
        emoji: "🧸",
        label: "routines.emojiPicker.icon.toys",
        keywords: ["toys", "toy", "play", "kids"],
      },
      {
        emoji: "☮️",
        label: "routines.emojiPicker.icon.peace",
        keywords: ["peace", "calm", "zen", "tranquil"],
      },
      { emoji: "📅", label: "routines.emojiPicker.icon.calendar", keywords: ["calendar", "event"] },
      { emoji: "🏆", label: "routines.emojiPicker.icon.trophy", keywords: ["win", "award"] },
      { emoji: "⭐", label: "routines.emojiPicker.icon.star", keywords: ["important", "star"] },
    ],
  },
];
