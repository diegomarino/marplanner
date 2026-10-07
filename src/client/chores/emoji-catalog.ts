export interface EmojiCatalogItem {
  emoji: string;
  label: string;
  keywords: string[];
}

export interface EmojiCategory {
  id: string;
  name: string;
  items: EmojiCatalogItem[];
}

/** Curated catalog of emojis grouped by semantic category for chore and routine assignment.
 * Categories are ordered from most-used to least-used, so the first options presented to
 * the user are the most relevant for everyday family planner tasks.
 */
export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "daily",
    name: "Daily Routines",
    items: [
      { emoji: "⏰", label: "Alarm", keywords: ["alarm", "wake"] },
      { emoji: "🌅", label: "Sunrise", keywords: ["morning", "sunrise"] },
      { emoji: "🌙", label: "Night", keywords: ["night", "evening"] },
      { emoji: "🛏️", label: "Bed", keywords: ["bed", "sleep"] },
      { emoji: "🪥", label: "Toothbrush", keywords: ["teeth", "brush"] },
      { emoji: "🚿", label: "Shower", keywords: ["shower", "bath"] },
      { emoji: "👕", label: "Clothes", keywords: ["dress", "clothes"] },
      { emoji: "👘", label: "Pajamas", keywords: ["pajamas", "sleepwear", "night"] },
      { emoji: "👟", label: "Shoe", keywords: ["shoe", "sneakers", "footwear"] },
      { emoji: "🎒", label: "Backpack", keywords: ["school", "bag"] },
      { emoji: "👔", label: "Blazer & Tie", keywords: ["blazer", "tie", "formal", "work"] },
      { emoji: "🪮", label: "Hair Brush", keywords: ["hair", "brush", "comb", "grooming"] },
      {
        emoji: "👱‍♀️",
        label: "Ponytail",
        keywords: ["ponytail", "hair", "coleta", "pelo", "peinar"],
      },
      { emoji: "🔇", label: "Silence", keywords: ["silence", "mute", "quiet"] },
    ],
  },
  {
    id: "home",
    name: "Home & Cleaning",
    items: [
      { emoji: "🧹", label: "Broom", keywords: ["clean", "sweep"] },
      { emoji: "🧺", label: "Laundry", keywords: ["laundry", "wash"] },
      { emoji: "🧼", label: "Soap", keywords: ["soap", "clean"] },
      { emoji: "🧽", label: "Sponge", keywords: ["kitchen", "clean"] },
      { emoji: "🗑️", label: "Trash", keywords: ["trash", "bin"] },
      { emoji: "🪣", label: "Bucket", keywords: ["bucket", "clean"] },
      { emoji: "🧴", label: "Lotion", keywords: ["care", "hygiene"] },
      { emoji: "🧪", label: "Spray Bottle", keywords: ["spray", "bottle", "cleaning"] },
      { emoji: "🫧", label: "Dishwasher", keywords: ["dishwasher", "dishes", "kitchen", "clean"] },
      {
        emoji: "🧫",
        label: "Dishwasher (Open)",
        keywords: ["dishwasher", "appliance", "open", "kitchen", "dishes"],
      },
      { emoji: "🧯", label: "Spray", keywords: ["spray", "bottle", "cleaning"] },
      { emoji: "🪴", label: "Plant", keywords: ["plants", "garden"] },
    ],
  },
  {
    id: "food",
    name: "Food & Kitchen",
    items: [
      { emoji: "🍳", label: "Cook", keywords: ["cook", "breakfast"] },
      { emoji: "🥣", label: "Bowl", keywords: ["breakfast", "cereal"] },
      { emoji: "🍽️", label: "Meal", keywords: ["meal", "eat"] },
      { emoji: "🥪", label: "Sandwich", keywords: ["lunch", "snack"] },
      { emoji: "🍎", label: "Apple", keywords: ["fruit", "snack"] },
      { emoji: "🥕", label: "Carrot", keywords: ["veggie", "food"] },
      { emoji: "🥛", label: "Milk", keywords: ["drink", "milk"] },
      { emoji: "🥤", label: "Water Glass", keywords: ["water", "glass", "drink"] },
      { emoji: "🍞", label: "Bread", keywords: ["bread", "food"] },
    ],
  },
  {
    id: "school",
    name: "School & Study",
    items: [
      { emoji: "📚", label: "Books", keywords: ["study", "homework"] },
      { emoji: "📝", label: "Write", keywords: ["write", "notes"] },
      { emoji: "✏️", label: "Pencil", keywords: ["pencil", "study"] },
      { emoji: "📖", label: "Reading", keywords: ["read", "book"] },
      { emoji: "🎓", label: "Graduation", keywords: ["school", "class"] },
      { emoji: "🧠", label: "Brain", keywords: ["focus", "learn"] },
      { emoji: "🧮", label: "Abacus", keywords: ["math", "numbers"] },
      { emoji: "💻", label: "Computer", keywords: ["computer", "online"] },
      {
        emoji: "🎼",
        label: "Musical Score",
        keywords: ["music", "música", "musica", "pentagrama", "clave de sol"],
      },
      { emoji: "🎵", label: "Musical Note", keywords: ["music", "música", "musica", "nota"] },
      { emoji: "🎶", label: "Musical Notes", keywords: ["music", "música", "musica", "notas"] },
      {
        emoji: "🎸",
        label: "Guitar",
        keywords: ["guitar", "guitarra", "music", "música", "musica"],
      },
      { emoji: "🎹", label: "Piano", keywords: ["piano", "music", "practice"] },
    ],
  },
  {
    id: "sports",
    name: "Sports & Activity",
    items: [
      { emoji: "⚽", label: "Football", keywords: ["football", "futbol", "match", "partido"] },
      { emoji: "🏀", label: "Basketball", keywords: ["basketball", "sport"] },
      { emoji: "🏊", label: "Swimming", keywords: ["swim", "pool"] },
      { emoji: "🚴", label: "Cycling", keywords: ["bike", "cycling"] },
      { emoji: "🏃", label: "Running", keywords: ["run", "exercise"] },
      { emoji: "🎾", label: "Tennis", keywords: ["tennis", "sport"] },
      { emoji: "🥋", label: "Martial Arts", keywords: ["karate", "martial"] },
      { emoji: "🏋️", label: "Gym", keywords: ["gym", "weights", "gimnasio", "pesas", "exercise"] },
      { emoji: "🧘", label: "Yoga", keywords: ["yoga", "calm"] },
      { emoji: "🚗", label: "Car", keywords: ["car", "drive", "trip"] },
      { emoji: "🧳", label: "Sports Bag", keywords: ["sports", "bag", "duffel", "training"] },
    ],
  },
  {
    id: "health",
    name: "Health & Care",
    items: [
      { emoji: "💊", label: "Medicine", keywords: ["medicine", "pill"] },
      { emoji: "🌡️", label: "Thermometer", keywords: ["fever", "temperature"] },
      { emoji: "🩹", label: "Bandage", keywords: ["injury", "care"] },
      { emoji: "🏥", label: "Hospital", keywords: ["doctor", "hospital"] },
      { emoji: "😴", label: "Sleep", keywords: ["sleep", "rest"] },
      { emoji: "🦷", label: "Dentist", keywords: ["teeth", "dentist"] },
      { emoji: "👓", label: "Glasses", keywords: ["vision", "glasses"] },
      { emoji: "❤️", label: "Heart", keywords: ["love", "care"] },
    ],
  },
  {
    id: "events",
    name: "Events & Celebration",
    items: [
      { emoji: "🎂", label: "Birthday", keywords: ["birthday", "cumple", "cumpleanos", "fiesta"] },
      { emoji: "🎉", label: "Party Popper", keywords: ["party", "celebration"] },
      { emoji: "🎁", label: "Gift", keywords: ["gift", "present"] },
      { emoji: "🎈", label: "Balloon", keywords: ["birthday", "party"] },
      { emoji: "🎊", label: "Confetti", keywords: ["party", "event"] },
      { emoji: "🧸", label: "Toys", keywords: ["toys", "toy", "play", "kids"] },
      { emoji: "☮️", label: "Peace", keywords: ["peace", "calm", "zen", "tranquil"] },
      { emoji: "📅", label: "Calendar", keywords: ["calendar", "event"] },
      { emoji: "🏆", label: "Trophy", keywords: ["win", "award"] },
      { emoji: "⭐", label: "Star", keywords: ["important", "star"] },
    ],
  },
];
