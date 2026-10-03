import { appPathname } from "@/lib/base-path";
import { useState, useRef, useEffect } from "react";
import { isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";
import { authFetch } from "@/lib/credential";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorNotice } from "@/components/ErrorNotice";
import { AdminRoutes } from "./AdminRoutes";
import { LanguageProvider } from "@/i18n";
import { navigateHousehold } from "@/shell/routes";

/* ------------------------------------------------------------------ */
/* Shapes (contracts/openapi.yaml — VerifyPinRequest / VerifyPinResult */
/* ------------------------------------------------------------------ */

interface VerifyPinRequest {
  pin: string;
}

interface VerifyPinResult {
  match: boolean;
}

/** Auto re-lock: `setUnlocked(false)` was previously called nowhere, so a kitchen kiosk stayed unlocked
 * indefinitely once a parent opened it, including for children using the kiosk
 * afterwards. Two complementary triggers, chosen TOGETHER rather than either alone:
 * 1. An inactivity timeout (below) — the common case: a parent finishes an admin
 * task and walks away without remembering to lock it back up.
 * 2. An explicit "Lock" control in the admin nav (`admin-lock-button`, in
 * `AdminContent`) — for the case a parent wants to hand the kiosk back to a
 * child immediately, without waiting out the timeout.
 * The timeout is a plain inactivity window, reset by ANY pointer or keyboard
 * interaction anywhere on the page while unlocked — this surface has no router,
 * so "activity" is the only signal available; there is no
 * route change to hook a lock-on-navigate trigger to. Five minutes is a recorded
 * product judgement call, not a derived constant: short enough that an unattended
 * kiosk doesn't stay open for the rest of the day, long enough that a parent
 * re-reading a long reminder list before saving isn't logged out mid-task. Revisit
 * this interval if real usage shows it is wrong in either
 * direction.
 */
const ADMIN_IDLE_LOCK_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* AdminGate — touch-first PIN gate (FR-017/018) */
/* */
/* ADR-061 (60-66): the settings-backed LanguageProvider mounts */
/* INSIDE the admin-unlock subtree — the shell performs no boot-time */
/* /api probe. So the PRE-unlock PIN gate uses ENGLISH LITERALS by */
/* design; only */
/* the post-unlock admin content (AdminContent) is localized. */
/* Localizing the pre-unlock chrome is deferred to the */
/* i18n-localization domain. Guarded by */
/* tests/client/admin-gate-no-boot-probe.test.tsx. */
/* ------------------------------------------------------------------ */

export function AdminGate() {
  const { unlocked, setUnlocked } = useAdminUnlock();
  const bypassPin = isAdminPinBypassEnabled();
  const adminUnlocked = unlocked || bypassPin;

  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* -- auto re-lock ----------------------------------------------- */

  const adminPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!adminUnlocked || bypassPin) return;
    // Attach idle listeners to the admin subtree, not `window`. `Shell.tsx` renders this gate and
    // the family surface as siblings, so window-scoped listeners let activity on the family
    // surface keep the admin panel unlocked. Only activity inside the panel resets the timer.
    const panel = adminPanelRef.current;
    if (!panel) return;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setUnlocked(false), ADMIN_IDLE_LOCK_MS);
    };

    resetIdleTimer();
    // CAPTURE phase, deliberately. On the bubble phase a single descendant calling
    // `stopPropagation` on keydown would make real user activity invisible to this timer and
    // lock a parent out mid-task — a silent failure with no way to diagnose it from the outside.
    // Nothing in the app or in Radix does that today; capture costs nothing and removes the class.
    //
    // `click` is in the set for the same reason the Options-menu Admin control accepts synthetic
    // activation: switch, voice-control and screen-reader users operate via clicks that
    // carry NO pointerdown and NO keydown. Without it, an AT user actively working in the panel is
    // locked out mid-task at the original deadline. For pointer users the click follows a
    // pointerdown, so the extra reset is idempotent.
    const opts = { capture: true } as const;
    panel.addEventListener("pointerdown", resetIdleTimer, opts);
    panel.addEventListener("keydown", resetIdleTimer, opts);
    panel.addEventListener("click", resetIdleTimer, opts);

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      panel.removeEventListener("pointerdown", resetIdleTimer, opts);
      panel.removeEventListener("keydown", resetIdleTimer, opts);
      panel.removeEventListener("click", resetIdleTimer, opts);
    };
  }, [adminUnlocked, bypassPin, setUnlocked]);

  /* -- pin submit ----------------------------------------------- */

  const handleSubmit = () => {
    if (pin.length < 4 || pin.length > 6 || submitting) return;

    setSubmitting(true);
    setError(null);

    authFetch("/api/auth/verify-pin", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin } satisfies VerifyPinRequest),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`verify-pin: ${res.status}`);
        return res.json() as Promise<VerifyPinResult>;
      })
      .then((data) => {
        if (data.match) {
          setUnlocked(true);
          setPin("");
        } else {
          setError("Incorrect PIN.");
        }
      })
      .catch(() => {
        setError("Request failed.");
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  /* -- unlocked: localized admin content (LanguageProvider mounts */
  /* HERE, post-unlock, so /api/settings fires only after unlock) */

  if (adminUnlocked) {
    return (
      <LanguageProvider>
        {/* `contents` creates no box, so layout is untouched; the element exists solely as the
 idle-timer's event scope (see the effect above). */}
        <div ref={adminPanelRef} className="contents" data-testid="admin-panel-scope">
          <AdminContent onLock={() => setUnlocked(false)} />
        </div>
      </LanguageProvider>
    );
  }

  /* -- locked: PIN gate (English, pre-unlock) -------------------- */

  const addDigit = (digit: string) => {
    if (submitting || pin.length >= 6) return;
    setPin((current) => `${current}${digit}`);
    setError(null);
  };

  const cancelPin = () => {
    setPin("");
    setError(null);
    const returnPath = window.history.state?.marplannerAdminReturnPath;
    if (typeof returnPath === "string" && !returnPath.startsWith("/admin")) {
      window.history.back();
      return;
    }
    navigateHousehold("/");
  };

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-2 text-center">
          <CardTitle>Admin PIN</CardTitle>
          <CardDescription>Enter the admin PIN to unlock admin surfaces.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex h-16 items-center justify-center">
            <output
              aria-label="Entered PIN"
              data-testid="admin-pin-display"
              className="min-w-48 text-center font-mono text-4xl tracking-[0.5em]"
            >
              {"●".repeat(pin.length)}
            </output>
          </div>
          <ErrorNotice id="admin-pin-error" message={error} />
          <div className="mx-auto grid max-w-70 grid-cols-3 gap-4" data-testid="admin-pin-keypad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
              <Button
                key={digit}
                type="button"
                variant="outline"
                size="lg"
                // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
                className="h-[64px] w-[64px] rounded-full text-[24px] font-semibold"
                aria-label={`Digit ${digit}`}
                data-testid={`admin-pin-digit-${digit}`}
                disabled={submitting || pin.length >= 6}
                onClick={() => addDigit(String(digit))}
              >
                {digit}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="lg"
              // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
              className="h-[64px] w-[64px] rounded-full text-[24px]"
              aria-label="Backspace"
              data-testid="admin-pin-backspace"
              disabled={submitting || pin.length === 0}
              onClick={() => {
                setPin((current) => current.slice(0, -1));
                setError(null);
              }}
            >
              ⌫
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
              className="h-[64px] w-[64px] rounded-full text-[24px] font-semibold"
              aria-label="Digit 0"
              data-testid="admin-pin-digit-0"
              disabled={submitting || pin.length >= 6}
              onClick={() => addDigit("0")}
            >
              0
            </Button>
            <Button
              type="button"
              size="lg"
              // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
              className="h-[64px] w-[64px] rounded-full text-[24px]"
              aria-label="Unlock Admin"
              data-testid="admin-pin-unlock"
              disabled={submitting || pin.length < 4 || pin.length > 6}
              onClick={handleSubmit}
            >
              {submitting ? "…" : "→"}
            </Button>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            data-testid="admin-pin-cancel"
            onClick={cancelPin}
          >
            Cancel
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AdminContent — the post-unlock, localized admin surface. Lives */
/* under LanguageProvider so the parent-facing admin NAV routes */
/* through t. The settings probe fires here, */
/* post-unlock, per ADR-061. */
/* ------------------------------------------------------------------ */

function AdminContent({ onLock }: { onLock: () => void }) {
  const adminPathname = () =>
    appPathname() === "/admin" || appPathname().startsWith("/admin/") ? appPathname() : "/admin";
  const [pathname, setPathname] = useState(adminPathname);

  useEffect(() => {
    const handlePopState = () => setPathname(adminPathname());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return <AdminRoutes pathname={pathname} onLock={onLock} />;
}
