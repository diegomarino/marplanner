import fanfareOggUrl from "./audio/win-jingle.ogg?url";
import fanfareMp3Url from "./audio/win-jingle.mp3?url";

/** The completion fanfare: "Win Jingle" by Fupi (CC0 1.0), https://opengameart.org/content/win-jingle.
 * Imported through the bundle (`?url`) so it resolves under a non-root BASE_PATH. One element is
 * created once and reused, so a celebration plays with no network or decode delay.
 */
const VOLUME = 0.5;

let fanfare: HTMLAudioElement | null = null;

function fanfareSource(audio: HTMLAudioElement): string {
  // Older Safari kiosks cannot decode Ogg Vorbis; every target plays the MP3 copy.
  return audio.canPlayType('audio/ogg; codecs="vorbis"') ? fanfareOggUrl : fanfareMp3Url;
}

/** Create and start loading the shared fanfare element. Safe to call repeatedly. */
export function preloadCelebrationSound(): void {
  if (fanfare !== null || typeof Audio === "undefined") return;
  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = VOLUME;
  audio.src = fanfareSource(audio);
  fanfare = audio;
}

/** Play the fanfare from the start. A refused `play()` (autoplay policy, no audio device) is
 * expected on a kiosk and fails silently.
 */
export function playCelebrationSound(): void {
  preloadCelebrationSound();
  const audio = fanfare;
  if (audio === null) return;
  try {
    audio.currentTime = 0;
    const playing = audio.play() as Promise<void> | undefined;
    playing?.catch(() => undefined);
  } catch {
    // Some engines throw synchronously instead of rejecting.
  }
}

/** Test seam: forget the shared element so the next call creates a fresh one. */
export function resetCelebrationSoundForTests(): void {
  fanfare = null;
}
