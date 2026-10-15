/** Web Speech wrapper.
 * `speak(phrase, lang)`: cancel-then-speak; `utterance.lang` is ALWAYS the household
 * locale (never left unset); the first voice whose `lang` prefix-matches is used, else
 * the default voice is kept and a `"voice-miss"` health signal is logged. Every
 * `speechSynthesis` touch is wrapped in try/catch — a throwing/blocked API degrades to a
 * swallowed no-op + logged miss, and the NEXT call is unaffected (INV-08: best-effort,
 * never persists a retry, never silences a future fire).
 * Browser autoplay policy gates `speechSynthesis.speak` behind a user gesture
 * (spec Clarifications): `primeOnFirstGesture` installs a one-shot capture-phase
 * `pointerdown`/`keydown` listener that speaks a zero-volume utterance and marks the
 * module primed; a fire attempted before that (or after the ~4am reload resets it) is a
 * swallowed no-op + logged `"unprimed"` miss — no new UI control (INV-10). The admin
 * Test-voice button (`testVoice`) doubles as an explicit manual primer (FR-014).
 */
import { logSpeechMiss } from "./seams";
import type { Language } from "@/i18n/messages";
import { buildPhrase } from "./phrases";

/** BCP-47 utterance tag per household language — the ONE place this mapping lives. */
const UTTERANCE_LANG: Record<Language, string> = { en: "en-US", es: "es-ES" };

let primed = false;

/** Test-only: reset the primed flag between test cases (the flag is otherwise page-lifetime). */
export function __resetSpeechPrimedForTests(): void {
  primed = false;
}

/** Whether speech has been primed by a user gesture (or `testVoice`) this session. */
export function isPrimed(): boolean {
  return primed;
}

/** Mark speech as primed. Idempotent. */
export function markPrimed(): void {
  primed = true;
}

function getSynth(): SpeechSynthesis | null {
  try {
    if (typeof window === "undefined") return null;
    return window.speechSynthesis ?? null;
  } catch {
    return null;
  }
}

function pickVoice(synth: SpeechSynthesis, lang: string): SpeechSynthesisVoice | null {
  try {
    const voices = synth.getVoices();
    const prefix = lang.toLowerCase().split("-")[0];
    return voices.find((v) => v.lang?.toLowerCase().startsWith(prefix)) ?? null;
  } catch {
    return null;
  }
}

/** Name of the voice `speak`/`testVoice` would use for `lang`, or `null` when none matches (the
 * default voice is used then) or the API is unavailable. Read-only and never throws: the admin
 * panel shows it next to Test voice. Chromium loads voices lazily, so callers re-read it. */
export function voiceNameFor(lang: Language): string | null {
  const synth = getSynth();
  if (!synth) return null;
  return pickVoice(synth, UTTERANCE_LANG[lang])?.name ?? null;
}

/** Start the browser's voice load. Chrome fills `getVoices()` lazily: the first call on a
 * page returns `[]` and only kicks off the load, so a lookup made cold would report a
 * spurious `"voice-miss"` on a device that does have the voice. Best-effort, never throws.
 */
function warmVoices(): void {
  try {
    getSynth()?.getVoices();
  } catch {
    // best-effort warm-up only — a blocked API is reported by the real speak path
  }
}

/** Cancel-then-speak `text` at `volume` (0-1), tagged `lang`. Every step try/caught.
 * `reportVoiceMiss` is false for the silent primer: it is not an announcement, so it
 * must not emit the pronunciation health signal.
 */
function attemptSpeak(text: string, lang: string, volume: number, reportVoiceMiss = true): void {
  const synth = getSynth();
  if (!synth) {
    logSpeechMiss("api-missing", { lang });
    return;
  }
  try {
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang; // ALWAYS set — even when no matching voice is found below.
    utterance.volume = volume;
    const voice = pickVoice(synth, lang);
    if (voice) {
      utterance.voice = voice;
    } else if (reportVoiceMiss) {
      logSpeechMiss("voice-miss", { lang });
    }
    synth.speak(utterance);
  } catch {
    logSpeechMiss("speech-failed", { lang });
  }
}

/** Speak `phrase` in the household `lang`. No-op + logged `"unprimed"` miss until speech
 * has been primed by a user gesture (or `testVoice`).
 */
export function speak(phrase: string, lang: Language): void {
  const tag = UTTERANCE_LANG[lang];
  if (!primed) {
    logSpeechMiss("unprimed", { lang: tag });
    return;
  }
  attemptSpeak(phrase, tag, 1);
}

/** One-shot capture-phase `pointerdown`/`keydown` listener: the first user gesture
 * anywhere in the shell primes speech (a zero-volume utterance satisfies autoplay
 * gating) and then detaches itself. Returns a teardown function.
 * `getLang` (2026-09-04) is read INSIDE the handler — at the moment the
 * user actually gestures, not when the listener is installed — so the silent priming
 * utterance carries the real household locale once settings have loaded, rather than
 * always defaulting to en-US (which would log a spurious `"voice-miss"` on every prime
 * in an es household). Defaults to `"en"` for callers that don't have a language source
 * (e.g. calling this directly outside the service).
 * Installing also warms the voice list (`warmVoices`), so it is loaded long before the
 * first gesture, the Test-voice button or a real fire looks a voice up.
 */
export function primeOnFirstGesture(getLang: () => Language = () => "en"): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    markPrimed();
    attemptSpeak(" ", UTTERANCE_LANG[getLang()], 0, false);
    detach();
  };
  function detach() {
    window.removeEventListener("pointerdown", handler, true);
    window.removeEventListener("keydown", handler, true);
  }
  warmVoices();
  window.addEventListener("pointerdown", handler, true);
  window.addEventListener("keydown", handler, true);
  return detach;
}

/** Admin Test-voice button (FR-014): speaks `time` (`HH:MM`) in `lang` locally — no rule
 * is created or fired — and doubles as a manual primer.
 */
export function testVoice(time: string, lang: Language): void {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    logSpeechMiss("invalid-time", { time });
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const phrase = buildPhrase(lang, hour, minute);
  markPrimed();
  attemptSpeak(phrase, UTTERANCE_LANG[lang], 1);
}
