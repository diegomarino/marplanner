/** Time-announcement phrase builders.
 * `buildPhrase(lang, hour, minute)` dispatches to a per-locale procedural builder that
 * selects among STATIC i18n keys (`timeAnnouncements.phrase.*` in `@/i18n/messages`) —
 * midnight/noon/quarter-past/quarter-to/half special forms, plus a generic hour+minute
 * form — and interpolates locale-specific hour/minute NUMBER-WORDS into them. Those
 * number-words are plain per-locale data tables in this module, not a further layer of
 * i18n keys: D7 describes the static keys as the SENTENCE SHAPES ("select among static
 * keys... and interpolate numerals/hour-words INTO them"), so the ~70 individual number
 * words per locale live here rather than as ~140 additional flat catalog entries. This
 * keeps the `t`/`MessageKey` static-key contract intact (FR-010: "no dynamic-key
 * registry exists" — every `messages[locale][key]` lookup below uses a literal key name,
 * never a template-constructed one) while avoiding an unreasonably large catalog.
 * `es` reproduces v1's 12-case golden table VERBATIM (the oracle — embedded in
 * `tests/client/time-announcements-phrases.test.ts`). `en` uses a natural spoken
 * register for the special forms (midnight/noon/quarter/half) and a literal
 * "hour + digital-style minute" reading for the generic form (e.g. "It's five ten",
 * "It's five fifty") — deliberately NOT the Spanish "menos" (to-the-next-hour) shape,
 * which the Spanish generic-past-half form uses; see `buildPhraseEn` below.
 */
import { messages, type Language, type MessageKey } from "@/i18n/messages";

/** `messages[locale][key] ?? messages.en[key]` — never throws (FR-010 edge case: a missing es key falls back to en text). */
function phraseText(locale: Language, key: MessageKey): string {
  return messages[locale][key] ?? messages.en[key];
}

/** `{name}`-token interpolation — the only templating this module needs. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match
  );
}

/** 12-hour-clock hour index (1..12) for a raw 0..23 hour — noon/midnight are special-cased by callers before reaching this. */
function hour12(hour: number): number {
  const h = ((hour % 12) + 12) % 12;
  return h === 0 ? 12 : h;
}

const HOUR_WORDS_ES: Record<number, string> = {
  1: "una",
  2: "dos",
  3: "tres",
  4: "cuatro",
  5: "cinco",
  6: "seis",
  7: "siete",
  8: "ocho",
  9: "nueve",
  10: "diez",
  11: "once",
  12: "doce",
};

const HOUR_WORDS_EN: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
};

// Spanish cardinal 1-29 — sufficient for both the direct minute reading (0-29) and the
// "menos {remaining}" complement (60-minute, also always 1-29 once:30/:45 are special-cased).
const MINUTE_WORDS_ES: Record<number, string> = {
  1: "uno",
  2: "dos",
  3: "tres",
  4: "cuatro",
  5: "cinco",
  6: "seis",
  7: "siete",
  8: "ocho",
  9: "nueve",
  10: "diez",
  11: "once",
  12: "doce",
  13: "trece",
  14: "catorce",
  15: "quince",
  16: "dieciséis",
  17: "diecisiete",
  18: "dieciocho",
  19: "diecinueve",
  20: "veinte",
  21: "veintiuno",
  22: "veintidós",
  23: "veintitrés",
  24: "veinticuatro",
  25: "veinticinco",
  26: "veintiséis",
  27: "veintisiete",
  28: "veintiocho",
  29: "veintinueve",
};

const ONES_EN = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS_EN: Record<number, string> = { 2: "twenty", 3: "thirty", 4: "forty", 5: "fifty" };

/** English literal minute reading (1-59): single digits read "oh five"-style, else the full cardinal. */
function minuteWordEn(minute: number): string {
  if (minute < 10) return `oh ${ONES_EN[minute]}`;
  if (minute < 20) return ONES_EN[minute];
  const tens = TENS_EN[Math.floor(minute / 10)];
  const ones = minute % 10;
  return ones === 0 ? tens : `${tens}-${ONES_EN[ones]}`;
}

function buildPhraseEs(hour: number, minute: number): string {
  if (hour === 0 && minute === 0) return phraseText("es", "timeAnnouncements.phrase.midnight");
  if (hour === 12 && minute === 0) return phraseText("es", "timeAnnouncements.phrase.noon");

  const h12 = hour12(hour);
  const singular = h12 === 1;

  if (minute === 0) {
    return interpolate(
      phraseText(
        "es",
        singular ? "timeAnnouncements.phrase.hourSingular" : "timeAnnouncements.phrase.hourPlural"
      ),
      { hour: HOUR_WORDS_ES[h12] }
    );
  }
  if (minute === 15) {
    return interpolate(
      phraseText(
        "es",
        singular
          ? "timeAnnouncements.phrase.quarterPastSingular"
          : "timeAnnouncements.phrase.quarterPastPlural"
      ),
      { hour: HOUR_WORDS_ES[h12] }
    );
  }
  if (minute === 30) {
    return interpolate(
      phraseText(
        "es",
        singular
          ? "timeAnnouncements.phrase.halfPastSingular"
          : "timeAnnouncements.phrase.halfPastPlural"
      ),
      { hour: HOUR_WORDS_ES[h12] }
    );
  }
  if (minute === 45) {
    const nextH12 = hour12(hour + 1);
    const nextSingular = nextH12 === 1;
    return interpolate(
      phraseText(
        "es",
        nextSingular
          ? "timeAnnouncements.phrase.quarterToSingular"
          : "timeAnnouncements.phrase.quarterToPlural"
      ),
      { hour: HOUR_WORDS_ES[nextH12] }
    );
  }
  if (minute < 30) {
    return interpolate(
      phraseText(
        "es",
        singular
          ? "timeAnnouncements.phrase.genericSingular"
          : "timeAnnouncements.phrase.genericPlural"
      ),
      { hour: HOUR_WORDS_ES[h12], minute: MINUTE_WORDS_ES[minute] }
    );
  }
  // minute in (30, 60), excluding the exact 45 handled above — "{nextHour} menos {remaining}".
  const nextH12 = hour12(hour + 1);
  const nextSingular = nextH12 === 1;
  const remaining = 60 - minute;
  return interpolate(
    phraseText(
      "es",
      nextSingular
        ? "timeAnnouncements.phrase.genericToSingular"
        : "timeAnnouncements.phrase.genericToPlural"
    ),
    { hour: HOUR_WORDS_ES[nextH12], minute: MINUTE_WORDS_ES[remaining] }
  );
}

function buildPhraseEn(hour: number, minute: number): string {
  if (hour === 0 && minute === 0) return phraseText("en", "timeAnnouncements.phrase.midnight");
  if (hour === 12 && minute === 0) return phraseText("en", "timeAnnouncements.phrase.noon");

  const h12 = hour12(hour);
  const singular = h12 === 1;

  if (minute === 0) {
    return interpolate(
      phraseText(
        "en",
        singular ? "timeAnnouncements.phrase.hourSingular" : "timeAnnouncements.phrase.hourPlural"
      ),
      { hour: HOUR_WORDS_EN[h12] }
    );
  }
  if (minute === 15) {
    return interpolate(
      phraseText(
        "en",
        singular
          ? "timeAnnouncements.phrase.quarterPastSingular"
          : "timeAnnouncements.phrase.quarterPastPlural"
      ),
      { hour: HOUR_WORDS_EN[h12] }
    );
  }
  if (minute === 30) {
    return interpolate(
      phraseText(
        "en",
        singular
          ? "timeAnnouncements.phrase.halfPastSingular"
          : "timeAnnouncements.phrase.halfPastPlural"
      ),
      { hour: HOUR_WORDS_EN[h12] }
    );
  }
  if (minute === 45) {
    const nextH12 = hour12(hour + 1);
    const nextSingular = nextH12 === 1;
    return interpolate(
      phraseText(
        "en",
        nextSingular
          ? "timeAnnouncements.phrase.quarterToSingular"
          : "timeAnnouncements.phrase.quarterToPlural"
      ),
      { hour: HOUR_WORDS_EN[nextH12] }
    );
  }
  // Generic minutes (both < 30 and > 30, 45 excluded above): a literal digital-style
  // reading of the ACTUAL hour+minute (no "to the next hour" wraparound — that's the
  // Spanish-specific "menos" idiom, not natural English clock speech for non-exact
  // quarter/half marks).
  const key: MessageKey =
    minute < 30
      ? singular
        ? "timeAnnouncements.phrase.genericSingular"
        : "timeAnnouncements.phrase.genericPlural"
      : singular
        ? "timeAnnouncements.phrase.genericToSingular"
        : "timeAnnouncements.phrase.genericToPlural";
  return interpolate(phraseText("en", key), {
    hour: HOUR_WORDS_EN[h12],
    minute: minuteWordEn(minute),
  });
}

/** Build the spoken phrase for `hour:minute` (24h, 0-23 / 0-59) in `lang`
 * (TIME-ANNOUNCEMENTS-AC-05, -INV-09). Pure — no I/O, no clock.
 */
export function buildPhrase(lang: Language, hour: number, minute: number): string {
  return lang === "es" ? buildPhraseEs(hour, minute) : buildPhraseEn(hour, minute);
}

/** Test-only: exercise the static-key fallback path (`phraseText`) directly. */
export const __testables = { phraseText, interpolate, hour12, minuteWordEn };
