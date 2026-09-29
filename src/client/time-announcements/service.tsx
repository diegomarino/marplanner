/** Browser announcement service, registered before Shell first renders.
 * Rules refresh on mount, periodically, and after an admin save. Household timezone
 * and language come from the shared settings context. One bounded timer schedules
 * the next occurrence and visibility changes trigger a fresh check.
 * Before speaking, recheck the armed instant, browser-local leadership and dedupe
 * journal. Only the leader records a consumed occurrence; missed or stale slots are
 * not replayed. Multiple devices may speak independently, as required by ADR-065.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { registerShellService } from "@/shell/Shell";
import { resolveLang, type Language } from "@/i18n/messages";
import type { TimeAnnouncementRule } from "../../shared";
import {
  computeNext,
  isFireDue,
  localDateFor,
  dedupeKey,
  DedupeJournal,
  type FireDecision,
} from "./engine";
import { acquireLeadership, type LeaderDeps } from "./leader";
import { buildPhrase } from "./phrases";
import { primeOnFirstGesture } from "./speech";
import { defaultAnnouncer, logSpeechMiss, mirrorAnnouncement, type Announcer } from "./seams";
import { RULES_CHANGED_EVENT } from "./events";

// Re-exported for existing internal consumers of this module's own export surface — the
// canonical definition (and every EXTERNAL import) lives in the
// side-effect-free `./events` module, never here (this module's own top-of-file docblock
// explains why importing IT has a side effect that must never leak into a jsdom render).
export { RULES_CHANGED_EVENT };

const RULES_ENDPOINT = "/api/time-announcements";
/** Timer re-evaluation ceiling (D11, v1 evidence): survives browser timer clamping/suspension. */
export const SAFETY_INTERVAL_MS = 30_000;
/** How stale an armed fire may be and still be honored (a very late timer re-evaluates to the NEXT occurrence instead). Judgment call — generous enough for background-tab throttling, tight enough that a real long suspension (which also gets a `visibilitychange` resume) doesn't fire a dramatically late announcement. */
export const STALE_WINDOW_MS = 5 * 60_000;
/** Background rule refetch cadence (D11 "slow refetch") — a save while this service is idle still lands within this window even if the CustomEvent signal is somehow missed. */
export const SLOW_REFETCH_MS = 5 * 60_000;

export interface AnnouncementServiceProps {
  /** Injectable announce seam — test-only; production uses the real Web Speech wrapper. */
  announcer?: Announcer;
  /** Injectable clock — test-only; production uses `Date.now`. */
  now?: () => number;
  /** Injectable leader-election primitives — test-only; production uses `leader.ts`'s defaults. */
  leaderDeps?: Partial<LeaderDeps>;
  /** Injectable dedupe journal — test-only (lets a test pin per-instance journal access); production creates its own. */
  journal?: DedupeJournal;
}

export function AnnouncementService({
  announcer = defaultAnnouncer,
  now = Date.now,
  leaderDeps,
  journal: injectedJournal,
}: AnnouncementServiceProps = {}) {
  const { timezone, language } = useHouseholdSettings();
  const [rules, setRules] = useState<TimeAnnouncementRule[]>([]);

  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const timezoneRef = useRef(timezone);
  timezoneRef.current = timezone;
  const languageRef = useRef(language);
  languageRef.current = language;

  const isLeaderRef = useRef(false);
  const wasLeaderRef = useRef(false);
  const journalRef = useRef<DedupeJournal | undefined>(undefined);
  if (!journalRef.current) {
    journalRef.current = injectedJournal ?? new DedupeJournal();
  }
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedRef = useRef<FireDecision | null>(null);
  const reevaluateRef = useRef<() => void>(() => {});
  const rearmFreshRef = useRef<() => void>(() => {});

  /** Fires from the ARMED decision's own SNAPSHOT (`decision.time`/`decision.isActive`,
   * captured by `computeNext` at ARM time) — NEVER a fresh `rulesRef` lookup for the
   * phrase/dedupe content (2026-09-04). The rule id is still checked for
   * EXISTENCE only (a deleted rule announces nothing), never for its current `.time`.
   */
  const performFire = useCallback(
    (decision: FireDecision) => {
      if (!isLeaderRef.current) return; // leader gate — a follower never touches the journal
      const tz = timezoneRef.current;
      if (!tz) return;
      const ruleStillExists = rulesRef.current.some((r) => r.id === decision.ruleId);
      if (!ruleStillExists) return; // deleted since this decision was armed — nothing to announce

      const localDate = localDateFor(decision.nextAt, tz);
      const key = dedupeKey(localDate, decision.time, decision.ruleId);
      const journal = journalRef.current!;
      if (journal.hasFired(key)) return; // per-browser dedupe — already spoken this rule-minute
      journal.recordFired(key); // LEADER ONLY writes the shared journal (D11)

      const lang: Language = resolveLang(languageRef.current ?? undefined);
      const [hh, mm] = decision.time.split(":").map(Number);
      const phrase = buildPhrase(lang, hh, mm);
      announcer.announce({ ruleId: decision.ruleId, phrase, lang });
      mirrorAnnouncement({ ruleId: decision.ruleId, phrase, lang, at: now() });
    },
    [announcer, now]
  );

  /** Arm ONE timeout for `decision`, clamped to the safety interval. Does not itself check/fire. */
  const arm = useCallback(
    (decision: FireDecision) => {
      const delay = Math.max(0, decision.nextAt - now());
      const clamped = Math.min(delay, SAFETY_INTERVAL_MS);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        reevaluateRef.current();
      }, clamped);
    },
    [now]
  );

  /** Recompute the next decision from CURRENT rules/tz and arm it. Does not check any prior decision. */
  const computeAndArm = useCallback(() => {
    const tz = timezoneRef.current;
    if (!tz) {
      armedRef.current = null;
      return; // settings not loaded yet — nothing to arm, not an error
    }
    const currentRules = rulesRef.current;
    const decision = computeNext(currentRules, tz, now());
    armedRef.current = decision;
    if (!decision) {
      // No armable occurrence. The only way this happens with an active rule present is a
      // defensively-invalid tz (INV-11) — a rule with no listed weekdays is filtered by
      // `nextRuleOccurrence` itself and is not, on its own, a health-signal-worthy event.
      if (currentRules.some((r) => r.isActive)) {
        logSpeechMiss("invalid-tz", { timezone: tz });
      }
      return;
    }
    arm(decision);
  }, [now, arm]);

  /** The "timer/visibility" re-evaluation entry point — called on the armed timeout's own
   * tick (the safety-interval loop), on `visibilitychange` resume, and on a
   * false->true leadership promotion. FIRST check whether the CURRENTLY armed decision
   * (if any) is now due and fire it if so — this is what makes visibility-resume (and a
   * promoted follower) able to "catch up" a fire whose timer never got to run (a
   * long-suspended/backgrounded tab, or a follower that only just became leader) instead
   * of silently skipping straight to next week's occurrence — THEN recompute and re-arm
   * fresh (which naturally rolls forward past whatever was just fired, since
   * `computeNext` only ever returns a strictly-future occurrence relative to `now`).
   */
  const reevaluate = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const tz = timezoneRef.current;
    const armed = armedRef.current;
    if (armed && tz && isFireDue(armed.nextAt, now(), STALE_WINDOW_MS)) {
      performFire(armed);
    }
    computeAndArm();
  }, [now, performFire, computeAndArm]);

  /** The "rules changed" re-evaluation entry point (+ N-1, 2026-09-04). Every
   * successful refetch lands here (fresh array identity), so an UNCONDITIONAL discard of
   * the armed decision would swallow a genuinely-due announcement on ANY refetch — the
   * INV-08 forbidden direction (a backgrounded leader under timer throttling loses ~13%
   * of fires against the 5-min refetch cadence). Instead: if the armed decision is due
   * AND its snapshot still matches the current rule's `{time, isActive}` (i.e. the
   * content did NOT change), fire it before rearming; if the content changed, discard —
   * a decision armed against stale content must not announce the stale time.
   */
  const rearmFresh = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const tz = timezoneRef.current;
    const armed = armedRef.current;
    if (armed && tz && isFireDue(armed.nextAt, now(), STALE_WINDOW_MS)) {
      const current = rulesRef.current.find((r) => r.id === armed.ruleId);
      if (current && current.time === armed.time && current.isActive === armed.isActive) {
        performFire(armed);
      }
    }
    armedRef.current = null;
    computeAndArm();
  }, [now, performFire, computeAndArm]);

  reevaluateRef.current = reevaluate;
  rearmFreshRef.current = rearmFresh;

  const fetchRules = useCallback(() => {
    authFetch(RULES_ENDPOINT, { credentials: "include" })
      .then((res) =>
        res.ok
          ? (res.json() as Promise<TimeAnnouncementRule[]>)
          : Promise.reject(new Error(String(res.status)))
      )
      .then((data) => setRules(Array.isArray(data) ? data : []))
      .catch(() => {
        // best-effort — keep whatever was last successfully fetched, never crash the service
      });
  }, []);

  useEffect(() => {
    fetchRules();
    const interval = setInterval(fetchRules, SLOW_REFETCH_MS);
    const onRulesChanged = () => fetchRules();
    window.addEventListener(RULES_CHANGED_EVENT, onRulesChanged);
    return () => {
      clearInterval(interval);
      window.removeEventListener(RULES_CHANGED_EVENT, onRulesChanged);
    };
  }, [fetchRules]);

  useEffect(() => {
    const release = acquireLeadership((leader) => {
      isLeaderRef.current = leader;
      // (2026-09-04): on a false->true promotion, re-evaluate immediately —
      // a promoted follower must not have to wait out the 30s safety interval to notice
      // an in-window minute it just became responsible for. `reevaluate` (not
      // `rearmFresh`) is correct here: `isFireDue` + the leader-only dedupe record
      // already make this safe even if the newly-promoted leader's OWN prior armed
      // decision (from when it was still a follower, silently tracking the same rules)
      // turns out to be the one that fires.
      const wasLeader = wasLeaderRef.current;
      wasLeaderRef.current = leader;
      if (leader && !wasLeader) {
        reevaluateRef.current();
      }
    }, leaderDeps);
    return release;
    // `leaderDeps` is test-only (production always passes `undefined`, a stable
    // reference) — re-running election on every render would thrash real Web Locks.
  }, []);

  useEffect(() => {
    // (2026-09-04): install the capture-phase gesture primer — WITHOUT this,
    // speech.ts's autoplay-gate NEVER gets satisfied in production and every fire is a
    // silent no-op (the feature was shippable-looking but inert). read the
    // household language at the moment the user actually gestures (not at install time,
    // when settings may not have loaded yet) via a getter over `languageRef`, so the
    // silent priming utterance is tagged with the real household locale instead of
    // always defaulting to en-US (which would log a spurious voice-miss in es
    // households). The returned teardown removes the listener on unmount.
    return primeOnFirstGesture(() => resolveLang(languageRef.current ?? undefined));
  }, []);

  useEffect(() => {
    //: rules/tz changed — discard any stale armed decision rather than risk firing
    // it against content that's since moved on (see `rearmFresh`'s doc).
    rearmFreshRef.current();
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [rules, timezone]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        reevaluateRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return null;
}

registerShellService(AnnouncementService);
