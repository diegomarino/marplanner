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

/** Cancel-then-speak `text` at `volume` (0-1), tagged `lang`. Every step try/caught. */
function attemptSpeak(text: string, lang: string, volume: number): void {
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
    } else {
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
 */
export function primeOnFirstGesture(getLang: () => Language = () => "en"): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    markPrimed();
    attemptSpeak(" ", UTTERANCE_LANG[getLang()], 0);
    detach();
  };
  function detach() {
    window.removeEventListener("pointerdown", handler, true);
    window.removeEventListener("keydown", handler, true);
  }
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
