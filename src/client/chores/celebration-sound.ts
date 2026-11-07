import fanfareOggUrl from "./audio/win-jingle.ogg?url";
import fanfareMp3Url from "./audio/win-jingle.mp3?url";

/** The completion fanfare: "Win Jingle" by Fupi (CC0 1.0), https://opengameart.org/content/win-jingle.
 * Imported through the bundle (`?url`) so it resolves under a non-root BASE_PATH. One element is
 * created once and reused, so a celebration plays with no network or decode delay.
 */
const VOLUME = 0.5;

let fanfare: HTMLAudioElement | null = null;
/** Set once a gesture-time play() of the element succeeded; WebKit then lets later, non-gesture
 * play() calls on the same element through. */
let primed = false;
/** Bumped by every real play, so a still-settling priming play() never pauses it. */
let playGeneration = 0;

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

/** Unlock the fanfare for a later play. Call synchronously inside the user's tap, before any
 * awaited work: the celebration is only known after the completion request and board refetch,
 * when the tap's user activation may have expired, and Safari/iOS refuse play() without it. A
 * muted play() that is paused again right away counts as the element's user-initiated start.
 */
export function primeCelebrationSound(): void {
  preloadCelebrationSound();
  const audio = fanfare;
  if (audio === null || primed) return;
  const generation = playGeneration;
  const settle = (unlocked: boolean) => {
    if (unlocked) primed = true;
    if (generation !== playGeneration) return; // A real play has started; leave it alone.
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
  };
  try {
    audio.muted = true;
    const playing = audio.play() as Promise<void> | undefined;
    if (playing) {
      playing.then(
        () => settle(true),
        () => settle(false)
      );
    } else settle(true);
  } catch {
    settle(false);
  }
}

/** Play the fanfare from the start. A refused `play()` (autoplay policy, no audio device) is
 * expected on a kiosk and fails silently.
 */
export function playCelebrationSound(): void {
  preloadCelebrationSound();
  const audio = fanfare;
  if (audio === null) return;
  playGeneration += 1;
  try {
    audio.muted = false;
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
  primed = false;
  playGeneration = 0;
}
