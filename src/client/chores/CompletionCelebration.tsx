import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { MEMBER_COLOR_KEYS, type MemberColorKey, type PeriodId } from "../../shared";
import { NotoEmoji } from "./noto-emoji";
import { playCelebrationSound } from "./celebration-sound";

export const CELEBRATION_TITLE_KEYS: Record<PeriodId, MessageKey> = {
  morning: "celebration.title.morning",
  afternoon: "celebration.title.afternoon",
  evening: "celebration.title.evening",
  night: "celebration.title.night",
};

/** Short encouragement lines; one is picked per celebration. */
export const CELEBRATION_CHEER_KEYS: readonly MessageKey[] = [
  "celebration.cheer.1",
  "celebration.cheer.2",
  "celebration.cheer.3",
  "celebration.cheer.4",
  "celebration.cheer.5",
  "celebration.cheer.6",
];

/** How long a celebration stays on screen before it removes itself. */
export const CELEBRATION_DURATION_MS = 3600;
const PARTICLE_COUNT = 56;
/** Reduced motion keeps a few emojis still around the card instead of a falling shower. */
const STATIC_PARTICLE_COUNT = 14;

export interface CompletionCelebrationProps {
  /** The member whose colour tints the wash, the card and the paper confetti. */
  colorKey: MemberColorKey;
  /** Glyphs to rain; empty draws coloured paper instead. */
  emojis: readonly string[];
  title: string;
  message?: string;
  /** Play the fanfare when the celebration appears (the household sound setting). */
  sound: boolean;
  onDismiss: () => void;
}

interface Particle {
  x: number;
  y: number;
  delay: number;
  duration: number;
  drift: number;
  rotate: number;
  size: number;
  symbol: string | null;
  color: MemberColorKey;
}

/** Deterministic per-index layout, so a celebration needs no randomness and tests are stable.
 * Paper confetti uses the member's own colour for half the pieces and the rest of the member
 * palette for the others.
 */
export function celebrationParticles(
  emojis: readonly string[],
  colorKey: MemberColorKey,
  count: number = PARTICLE_COUNT
): Particle[] {
  const others = MEMBER_COLOR_KEYS.filter((key) => key !== colorKey);
  return Array.from({ length: count }, (_, i) => ({
    x: 4 + ((i * 37) % 92),
    y: -12 + ((i * 23) % 40),
    delay: (i % 8) * 0.09,
    duration: 2.4 + (i % 6) * 0.14,
    drift: ((i * 29) % 160) - 80,
    rotate: (((i * 47) % 160) - 80) * 5,
    size: 30 + ((i * 13) % 3) * 8,
    symbol: emojis.length > 0 ? emojis[i % emojis.length] : null,
    color: i % 2 === 0 ? colorKey : others[(i >> 1) % others.length],
  }));
}

function usePrefersReducedMotion(): boolean {
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  return reduced;
}

/** Full-screen, non-interactive celebration played when a member finishes a block of chores.
 * Mounted once per surface: a new celebration replaces the current one (callers key it). Any
 * tap dismisses it without being swallowed, so the board stays usable underneath.
 */
export function CompletionCelebration({
  colorKey,
  emojis,
  title,
  message,
  sound,
  onDismiss,
}: CompletionCelebrationProps): React.ReactPortal {
  const reducedMotion = usePrefersReducedMotion();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // The fanfare belongs to the appearance: read once, so a re-render never replays it.
  const soundRef = useRef(sound);
  useEffect(() => {
    if (soundRef.current) playCelebrationSound();
  }, []);

  // Layout effect: the dismiss listener must exist as soon as the overlay is in the DOM,
  // or a tap landing before passive effects flush is lost.
  useLayoutEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), CELEBRATION_DURATION_MS);
    const dismiss = () => dismissRef.current();
    document.addEventListener("pointerdown", dismiss, { capture: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss, { capture: true });
    };
  }, []);

  const particles = celebrationParticles(
    emojis,
    colorKey,
    reducedMotion ? STATIC_PARTICLE_COUNT : PARTICLE_COUNT
  );

  // Portalled to the body: a transformed ancestor (a dialog) would otherwise clip the
  // fixed layer to itself.
  return createPortal(
    <div
      data-testid="completion-celebration"
      data-motion={reducedMotion ? "reduced" : "full"}
      data-preset-kind={emojis.length > 0 ? "emoji" : "paper"}
      className="completion-celebration pointer-events-none fixed inset-0 z-50 overflow-hidden"
      // eslint-disable-next-line ui-policy/debt -- The member identity is passed through one CSS custom property into the token layer.
      style={{ "--member-color": `var(--color-member-${colorKey}-500)` } as CSSProperties}
    >
      <div aria-hidden="true" className="completion-celebration-wash absolute inset-0" />
      <div aria-hidden="true" className="absolute inset-0">
        {particles.map((particle, index) => (
          <span
            key={index}
            data-testid="completion-celebration-particle"
            data-symbol={particle.symbol ?? ""}
            className={cn(
              "completion-celebration-particle absolute",
              particle.symbol === null && "completion-celebration-paper"
            )}
            // eslint-disable-next-line ui-policy/debt -- Per-particle layout and palette colour are passed as CSS custom properties to the keyframes.
            style={
              {
                "--particle-x": `${reducedMotion ? (index * 53) % 92 : particle.x}%`,
                "--particle-y": `${reducedMotion ? 6 + ((index * 31) % 86) : particle.y}%`,
                "--particle-delay": `${particle.delay}s`,
                "--particle-duration": `${particle.duration}s`,
                "--particle-drift": `${particle.drift}px`,
                "--particle-rotate": `${particle.rotate}deg`,
                "--particle-tilt": `${((index * 17) % 40) - 20}deg`,
                "--particle-size": `${particle.size}px`,
                "--particle-color": `var(--color-member-${particle.color}-500)`,
              } as CSSProperties
            }
          >
            {particle.symbol !== null && (
              <NotoEmoji emoji={particle.symbol} size={particle.size} className="block size-full" />
            )}
          </span>
        ))}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div
          role="status"
          aria-live="polite"
          className="completion-celebration-card bg-card flex max-w-md flex-col items-center gap-2 rounded-3xl border-4 px-10 py-8 text-center shadow-2xl"
        >
          <p className="font-serif text-4xl font-bold leading-tight">{title}</p>
          {message && <p className="text-muted-foreground text-xl font-semibold">{message}</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}
