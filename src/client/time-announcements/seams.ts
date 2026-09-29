/** Time-announcements test/telemetry seams.
 * - `Announcer` / `defaultAnnouncer`: the injectable speak-seam the firing service calls
 * through (default = the real Web Speech wrapper in `./speech`).
 * - `logSpeechMiss`: best-effort health signal routed to the client logger
 * (component `time-announcements`, level `warn`). Calls `log` directly with no
 * surrounding try/catch (2026-09-04): `log`'s own documented contract
 * (`src/client/lib/logger.ts` INV-01) is that it NEVER throws into its caller — a
 * try/catch here whose `catch` can provably never execute is dead code, not a genuine
 * fallback, and a console-mirror "fallback" behind unreachable dead code is worse than
 * no fallback (it looks like a safety net that isn't one). `log` already has its own
 * DEV console mirror internally, so this module doesn't need a second one.
 * - `mirrorAnnouncement` / `window.__mpAnnouncements`: the audio-free test sink (D9),
 * gated identically to the 013 `window.__mpTelemetry` hook
 * (`import.meta.env.DEV || VITE_E2E_HOOKS === "true"`) — absent from a production
 * build that doesn't set the e2e flag.
 */
import { log } from "@/lib/logger";
import { speak } from "./speech";
import type { Language } from "@/i18n/messages";

/** An announcement the firing engine hands to the announcer seam (D9). */
export interface AnnounceInput {
  ruleId: string;
  phrase: string;
  lang: Language;
}

/** Injectable announce seam — default is the real Web Speech wrapper (`./speech`). */
export interface Announcer {
  announce(input: AnnounceInput): void;
}

export const defaultAnnouncer: Announcer = {
  announce({ phrase, lang }) {
    speak(phrase, lang);
  },
};

/** Best-effort health signal (D8). Routes to the 013 client logger (component
 * `time-announcements`, level `warn`); never throws into its caller (`log`'s own
 * contract — see the module doc above).
 */
export function logSpeechMiss(kind: string, detail?: Record<string, unknown>): void {
  log("warn", "time-announcements", kind, detail);
}

/** One mirrored announcement entry (D9). */
export interface AnnouncementMirrorEntry extends AnnounceInput {
  at: number;
}

const MIRROR_CAP = 50;
export const ANNOUNCEMENT_EVENT = "mp:announcement";

// TS declaration merging (same pattern/rationale as `window.__mpTelemetry` in logger.ts):
// base ESLint's `no-unused-vars` doesn't understand declaration merging.
declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    __mpAnnouncements?: { entries: AnnouncementMirrorEntry[] };
  }
}

// Computed ONCE at module scope from `import.meta.env` (Vite build-time constants) —
// same shape as logger.ts's `hooksEnabled`. This is what lets a production build WITHOUT
// `VITE_E2E_HOOKS` set constant-fold the whole condition to `false` and dead-code-eliminate
// everything gated behind it, INCLUDING the `"__mpAnnouncements"` string itself: a
// function-call gate (`if (!hooksEnabled) return;` calling a separate function) does NOT
// reliably get cross-function-inlined by esbuild's minifier, so the string survives in the
// bundle even when unreachable at runtime — verified by grepping `dist/client/assets/*.js`
// for `__mpAnnouncements` with and without `VITE_E2E_HOOKS=true` at build time (DoD).
const HOOKS_ENABLED = Boolean(import.meta.env.DEV) || import.meta.env.VITE_E2E_HOOKS === "true";

/** Mirror one announcement to `window.__mpAnnouncements` (bounded array + `CustomEvent`),
 * gated to DEV/e2e builds (D9). Best-effort — never throws.
 */
export function mirrorAnnouncement(entry: AnnouncementMirrorEntry): void {
  if (!HOOKS_ENABLED) return;
  if (typeof window === "undefined") return;
  try {
    if (!window.__mpAnnouncements) {
      window.__mpAnnouncements = { entries: [] };
    }
    const entries = window.__mpAnnouncements.entries;
    entries.push(entry);
    if (entries.length > MIRROR_CAP) {
      entries.splice(0, entries.length - MIRROR_CAP);
    }
    window.dispatchEvent(new CustomEvent(ANNOUNCEMENT_EVENT, { detail: entry }));
  } catch {
    // best-effort mirror only — never let the test sink break production behavior
  }
}
