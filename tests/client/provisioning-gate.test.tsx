/** Provisioning gate spec (FR-009/FR-019) — `ProvisioningScreen`,
 * the pre-provisioning screen `Shell.tsx` renders when the `mp_provisioned` device-credential
 * marker cookie is absent (FR-031/ADR-059). This is the executable evidence for the per-change
 * DoD (the component acceptance criteria): it CALLS the frozen density assertion over the screen's
 * rendered control set with kiosk density active (not merely imports it), across every reachable
 * state with an exact control-count census per phase (proven capable of detecting a REMOVED
 * control, not just returning a constant), records a deliberate negative proving the assertion
 * can fail on this surface's own controls, asserts the shared L2 components were genuinely
 * ADOPTED (region + heading landmark, `Field`'s label association, `ErrorNotice`'s identity), and
 * asserts the structural copy in BOTH household languages per FR-019 (Traces:
 * I18N-LOCALIZATION-INV-12).
 * * Language, not household settings (FR-019, ADR-031):* this screen renders BEFORE the device
 * holds any credential, so there is no household to read a language from — FR-031/ADR-059
 * forbid an authenticated `/api/settings` probe before one exists. ADR-031 is explicit: "The
 * pre-provisioning connection-setup screen renders using the browser's language and a default
 * timezone, converging to household settings once the device is provisioned and holds a key."
 * `ProvisioningScreen` therefore reads `navigator.language` directly (no `LanguageProvider`
 * mounts here at all — see `Shell.tsx`'s `resolveProvisioningLanguage`), and this file mocks
 * that browser setting per locale rather than mocking `/api/settings` the way every OTHER
 * surface's i18n test does.
 * * The perimeter access gate is explicitly NOT covered here* — it is a
 * hardcoded HTML string in `src/server/auth/gate.ts`, outside `src/client/* ` and every counter;
 * styling it is a separate server change.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProvisioningScreen } from "@/shell/Shell";
import { messages } from "@/i18n/messages";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

/** Mirrors `density.ts`'s own selector/filter — see `printing-surfaces.test.tsx`'s identical
 * helper for why this is duplicated rather than imported (the frozen file exposes no census API
 * by design). Lets THIS spec assert an exact control count per phase, not just "compliant or
 * not". */
const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return Array.from(container.querySelectorAll(CENSUS_CONTROL_SELECTOR)).filter((element) => {
    if (element instanceof HTMLElement && element.hidden) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

/** Overrides `navigator.language` for the duration of one test — see `weather-management.
 * test.tsx`the identical `navigator.geolocation` precedent. Returns a restore function. */
function stubBrowserLanguage(value: string): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", { value, configurable: true });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "language", original);
    } else {
      // @ts-expect-error test-only cleanup of a property this helper itself defined
      delete navigator.language;
    }
  };
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("ProvisioningScreen — the shared L2 components were actually ADOPTED (FR-009)", () => {
  it("renders through AdminPanel's region + heading landmark, not a hand-rolled wrapper", () => {
    // A bare <div> with the title/description deleted outright passes every functional test in
    // this file — the region-and-heading pair is the only assertion that would catch it (the
    // this behavior was measured repeatedly across related surfaces).
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />);

    expect(screen.getByRole("region", { name: "Marplanner Kiosk" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Marplanner Kiosk", level: 1 })).toBeInTheDocument();
  });

  it("associates the bootstrap-key label with its input programmatically (Field), not by adjacency", () => {
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />);

    // getByLabelText only succeeds via a REAL <label htmlFor>/id (or aria-label/aria-labelledby)
    // association — an adjacent, unassociated <label> and <input> would fail this lookup even
    // though they render identically to a sighted user.
    const input = screen.getByLabelText("Bootstrap key");
    expect(input).toHaveAttribute("type", "password");
  });

  it("renders the error through ErrorNotice's own identity (token classes), not just a role='alert' replica", () => {
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={true} />);

    const alert = screen.getByRole("alert");
    // `border-destructive/40` and `bg-destructive/10` are ErrorNotice's OWN class string
    // (src/client/components/ErrorNotice.tsx) — a hand-rolled `<p role="alert">` with no import
    // from that component would carry neither, only `role="alert"` itself.
    expect(alert.className).toContain("text-destructive");
    expect(alert.className).toContain("border-destructive/40");
    expect(alert.className).toContain("bg-destructive/10");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});

describe("ProvisioningScreen — the error state is announced through ErrorNotice's live region (SC-011)", () => {
  it("announces a failed provision attempt", () => {
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={true} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Provisioning failed. Check the bootstrap key and try again.");
  });

  it("renders NO alert when there is no error", () => {
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ProvisioningScreen — kiosk density across every reachable state (SC-001, SC-002)", () => {
  it("meets kiosk density idle, with a key entered, in-flight, and in the error state — two controls throughout", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      // Phase 1 — idle: empty key, submit disabled. Two controls (input + submit) — this
      // surface's ENTIRE control set, in every phase below.
      const { rerender } = render(
        <ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />
      );
      expect(countInteractiveControls(document.body)).toBe(2);
      expect(screen.getByRole("button", { name: "Provision Device" })).toBeDisabled();
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — a key is entered: submit becomes enabled, control count is unchanged.
      fireEvent.change(screen.getByLabelText("Bootstrap key"), {
        target: { value: "mpk-test-key" },
      });
      expect(countInteractiveControls(document.body)).toBe(2);
      expect(screen.getByRole("button", { name: "Provision Device" })).not.toBeDisabled();
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — in-flight: `provisioning=true` disables submit again and swaps its label;
      // still two controls (submit stays MOUNTED, merely disabled — never removed).
      rerender(<ProvisioningScreen onProvision={() => {}} provisioning={true} error={false} />);
      expect(screen.getByRole("button", { name: "Provisioning…" })).toBeDisabled();
      expect(countInteractiveControls(document.body)).toBe(2);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 4 — the error state: ErrorNotice's live region is not itself an interactive
      // control, so the census stays at two.
      rerender(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={true} />);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(countInteractiveControls(document.body)).toBe(2);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("CENSUS PROOF — the control count drops when a control is actually removed, not just returning a constant", () => {
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />);

    expect(countInteractiveControls(document.body)).toBe(2);

    // Simulate removal the same way `density.ts`'s own `isRenderable` treats it: `hidden` takes
    // an element out of the rendered/interactive set without unmounting it.
    const submit = screen.getByRole("button", { name: "Provision Device" });
    submit.hidden = true;

    expect(countInteractiveControls(document.body)).toBe(1);

    // Revert — the census is symmetric, not a one-way ratchet.
    submit.hidden = false;
    expect(countInteractiveControls(document.body)).toBe(2);
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own submit button below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = render(
        <ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />
      );
      const submit = screen.getByRole("button", { name: "Provision Device" });

      // A real control from this surface, not a synthetic fixture. `Button`'s `wrap={false}`
      // default uses an EXPLICIT height (h-[var(--control-height)]), so overriding `height`
      // alone is sufficient — density.ts's resolver prefers an explicit height over min-height,
      // so there is no min-height fallback to also override here (unlike a `wrap` Button).
      submit.style.height = "10px";
      submit.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);

      // Revert — compliance returns.
      submit.style.height = "";
      submit.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("ProvisioningScreen — structural copy follows the BROWSER language, both household languages (FR-019, Traces: I18N-LOCALIZATION-INV-12)", () => {
  it("renders English structural copy when the browser language is English (the jsdom default)", () => {
    render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={true} />);

    expect(screen.getByRole("heading", { name: "Marplanner Kiosk" })).toBeInTheDocument();
    expect(
      screen.getByText("Enter the bootstrap key to provision this device.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Bootstrap key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
    expect(
      screen.getByText("Provisioning failed. Check the bootstrap key and try again.")
    ).toBeInTheDocument();
  });

  it("renders Spanish structural copy when the browser language is Spanish, with NO reliance on the English fallback", () => {
    const restore = stubBrowserLanguage("es-ES");
    try {
      render(<ProvisioningScreen onProvision={() => {}} provisioning={true} error={true} />);

      expect(screen.getByRole("heading", { name: "Marplanner Kiosk" })).toBeInTheDocument();
      expect(
        screen.getByText("Introduce la clave de arranque para aprovisionar este dispositivo.")
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Clave de arranque")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Aprovisionando…" })).toBeInTheDocument();
      expect(
        screen.getByText(
          "No se pudo aprovisionar. Comprueba la clave de arranque e inténtalo de nuevo."
        )
      ).toBeInTheDocument();
      // None of the ENGLISH strings leaked through as a missing-translation fallback.
      expect(screen.queryByText("Provision Device")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Enter the bootstrap key to provision this device.")
      ).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("localizes the server retry delay in Spanish without exposing diagnostics", () => {
    const restore = stubBrowserLanguage("es-ES");
    try {
      render(
        <ProvisioningScreen
          onProvision={() => {}}
          provisioning={false}
          error={true}
          retryAfter={8}
        />
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Demasiados intentos fallidos. Espera al menos 8 segundos antes de volver a intentarlo."
      );
    } finally {
      restore();
    }
  });

  it("resolves an unsupported browser language (e.g. French) to the English default, never an empty/undefined render", () => {
    const restore = stubBrowserLanguage("fr-FR");
    try {
      render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />);

      expect(screen.getByRole("heading", { name: "Marplanner Kiosk" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Provision Device" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});

describe("provisioning.gate i18n parity — every key exists in both catalogues with a non-empty value", () => {
  const isProvisioningGateKey = (key: string) => key.startsWith("provisioning.gate.");

  it("every provisioning.gate key in en exists in es, and vice versa", () => {
    const enKeys = Object.keys(messages.en).filter(isProvisioningGateKey);
    const esKeys = Object.keys(messages.es).filter(isProvisioningGateKey);

    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      expect(Object.hasOwn(messages.es, key)).toBe(true);
    }
    for (const key of esKeys) {
      expect(Object.hasOwn(messages.en, key)).toBe(true);
    }
  });

  it("every provisioning.gate key resolves to a non-empty string in both languages", () => {
    const keys = Object.keys(messages.en).filter(isProvisioningGateKey);

    for (const key of keys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];
      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });
});
