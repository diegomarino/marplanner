import { afterEach, describe, expect, it } from "vitest";
import {
  assertKioskDensityCompliant,
  COMFORTABLE_DENSITY_VALUE,
  DENSITY_ATTRIBUTE,
  DensityEmptyControlSetError,
  DensityMisconfiguredError,
  DensityUnresolvableStyleError,
  DensityViolationError,
  KIOSK_DENSITY_VALUE,
  KIOSK_MIN_CONTROL_HEIGHT_PX,
  KIOSK_MIN_FONT_SIZE_PX,
} from "./helpers/density";

/** The frozen helper's own tests prove that each of its three obligations fails when
 * violated. An assertion never seen to fail is decoration. Each `it` below is the failing half
 * of one obligation; companion happy-path tests prove the helper does NOT fail when
 * nothing is wrong, so the failures above are not merely a helper that
 * always throws.
 */

function setDensity(value: string | null): void {
  if (value === null) {
    document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(DENSITY_ATTRIBUTE, value);
  }
}

function mountContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** A control sized to comfortably clear both kiosk minimums. */
function appendCompliantButton(container: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Compliant control";
  button.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 8}px`;
  button.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
  container.appendChild(button);
  return button;
}

afterEach(() => {
  setDensity(null);
  document.body.replaceChildren();
  // The rem tests below scale the ROOT font-size. Without this, a 10px root leaks into every
  // subsequent test and silently changes what they measure.
  document.documentElement.style.removeProperty("font-size");
  document.body.style.removeProperty("font-size");
});

describe("assertKioskDensityCompliant — obligation 1: kiosk state must be proven active", () => {
  it("throws DensityMisconfiguredError when the density attribute is absent", () => {
    setDensity(null);
    const container = mountContainer();
    appendCompliantButton(container);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityMisconfiguredError);
  });

  it("throws DensityMisconfiguredError when density is comfortable, not kiosk", () => {
    setDensity(COMFORTABLE_DENSITY_VALUE);
    const container = mountContainer();
    appendCompliantButton(container);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityMisconfiguredError);
  });
});

describe("assertKioskDensityCompliant — obligation 2: the control set must be non-empty", () => {
  it("throws DensityEmptyControlSetError when kiosk is active but no control was collected", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    // Deliberately empty: no interactive controls appended.

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
  });

  it("throws DensityEmptyControlSetError for a container holding only non-interactive content", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Not a control.";
    container.appendChild(paragraph);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
  });
});

describe("assertKioskDensityCompliant — obligation 3: a control below the minimum must fail", () => {
  it("throws DensityViolationError when a control's height is below the kiosk minimum", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const undersized = document.createElement("button");
    undersized.textContent = "Too short";
    undersized.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 16}px`;
    undersized.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(undersized);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityViolationError);
  });

  it("throws DensityViolationError when a control's text is below the kiosk minimum", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const tinyText = document.createElement("button");
    tinyText.textContent = "Too small";
    tinyText.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 8}px`;
    tinyText.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX - 4}px`;
    container.appendChild(tinyText);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityViolationError);
  });

  it("names the offending control and the violated dimension in the error message", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const undersized = document.createElement("button");
    undersized.setAttribute("aria-label", "Undersized offender");
    undersized.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 1}px`;
    undersized.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(undersized);

    expect(() => assertKioskDensityCompliant(container)).toThrow(/Undersized offender/);
  });

  it("does NOT fail a control sized at exactly the kiosk minimum (boundary, not off-by-one)", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const exact = document.createElement("button");
    exact.textContent = "Exactly at minimum";
    exact.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX}px`;
    exact.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX}px`;
    container.appendChild(exact);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });
});

describe("assertKioskDensityCompliant — happy path", () => {
  it("does not throw when kiosk density is active and every control meets the minimum", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    appendCompliantButton(container);
    appendCompliantButton(container);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });

  it("checks controls mounted outside the given container when asserting against document.body (SC-003)", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    // Simulate a dialog portalled directly onto document.body, outside any
    // surface-local container — the case a container-scoped mechanism would
    // miss (SC-003, and the /e2e case this unit-level helper backstops).
    const portalled = document.createElement("button");
    portalled.textContent = "Portalled dialog control";
    portalled.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 10}px`;
    portalled.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    document.body.appendChild(portalled);

    expect(() => assertKioskDensityCompliant(document.body)).toThrow(DensityViolationError);
  });
});

/** Regression coverage for the helper's fail-closed behavior:
 * used `Number.isFinite(x) && x < min` for both height and font-size, which
 * means an UNRESOLVABLE measurement (jsdom returning `NaN` from
 * `parseFloat`) was silently treated as compliant. jsdom does not
 * substitute `var(...)` inside `getComputedStyle`, so a class-styled surface
 * consuming kiosk sizing through CSS custom properties hit `NaN` on every control. This test
 * exercises that behavior.
 */
describe("assertKioskDensityCompliant — resolves one level of var() token indirection (regression: PR #744 review)", () => {
  it("throws on a class-styled, zero-inline-style surface whose kiosk tokens grossly violate the minimums", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();

    const style = document.createElement("style");
    style.textContent = `
      :root[data-density="kiosk"] {
        --control-h: 8px;
        --control-font: 4px;
      }
      .kiosk-control {
        height: var(--control-h);
        font-size: var(--control-font);
      }
    `;
    document.head.appendChild(style);

    try {
      for (let i = 0; i < 6; i += 1) {
        const control = document.createElement("button");
        control.className = "kiosk-control";
        control.textContent = `Control ${i}`;
        container.appendChild(control);
      }

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (error) {
        thrown = error;
      }

      // Before the fix this assertion PASSED (thrown === undefined): both
      // `Number.isFinite(NaN)` checks were false, so every control's height
      // and font-size check was skipped. After the fix the var tokens are
      // resolved (8px / 4px) and the gross violation is caught.
      expect(thrown).toBeInstanceOf(DensityViolationError);
      const violationError = thrown as DensityViolationError;
      expect(violationError.violations).toHaveLength(6);
      expect(violationError.message).toMatch(/height 8px is below the kiosk minimum 48px/);
      expect(violationError.message).toMatch(/font-size 4px is below the kiosk minimum 18px/);
    } finally {
      document.head.removeChild(style);
    }
  });
});

describe("assertKioskDensityCompliant — an unresolvable measurement fails closed, not open", () => {
  it("throws DensityUnresolvableStyleError when height and min-height are both unset (jsdom reports 'auto')", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const control = document.createElement("button");
    // No height, no min-height set at all: jsdom (no layout engine) reports
    // style.height as the literal string "auto", which parseFloat turns
    // into NaN. This MUST fail loud, not be silently skipped.
    control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityUnresolvableStyleError);
  });

  it("throws DensityUnresolvableStyleError when a var() token references an undefined custom property", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const control = document.createElement("button");
    control.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 8}px`;
    // No stylesheet defines --never-defined-token anywhere: getPropertyValue
    // resolves to "" and parseFloat("") is NaN — still unresolvable even
    // after the one-level var resolution attempt.
    control.style.fontSize = "var(--never-defined-token)";
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityUnresolvableStyleError);
  });

  it("names the unresolvable control and dimension in the error message", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const control = document.createElement("button");
    control.setAttribute("aria-label", "Unmeasurable offender");
    control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).toThrow(/Unmeasurable offender/);
  });
});

/** Every fixture derives its values from these constants, so those tests cannot catch
 * incorrect thresholds. This test pins the expected values directly.
 * Pin the measured values (32px -> 48px control height, 14px -> 18px text) so a
 * token change forces a deliberate update here alongside the stylesheet.
 */
describe("assertKioskDensityCompliant — kiosk minimum constants are pinned", () => {
 it("matches the trap-sweep browser probe (32->48px height, 14->18px text)", () => {
    expect(KIOSK_MIN_CONTROL_HEIGHT_PX).toBe(48);
    expect(KIOSK_MIN_FONT_SIZE_PX).toBe(18);
  });
});

/** Mutation-survivor coverage: every violation fixture above has exactly one
 * control, so a mutant that only reports violations when
 * `controls.length === 1` survived green — while SC-001/SC-002 both require
 * checking 100% of interactive controls.
 */
describe("assertKioskDensityCompliant — checks EVERY control, not just the first or only one", () => {
  it("flags exactly the one undersized control among eleven compliant ones", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    for (let i = 0; i < 11; i += 1) {
      appendCompliantButton(container);
    }
    const undersized = document.createElement("button");
    undersized.setAttribute("aria-label", "The one undersized control");
    undersized.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 10}px`;
    undersized.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(undersized);

    let thrown: unknown;
    try {
      assertKioskDensityCompliant(container);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DensityViolationError);
    const violationError = thrown as DensityViolationError;
    expect(violationError.violations).toHaveLength(1);
    expect(violationError.message).toMatch(/The one undersized control/);
  });
});

/** Mutation-survivor coverage: every fixture above is a <button>, so a
 * mutant narrowing INTERACTIVE_CONTROL_SELECTOR down to just "button" would
 * survive green. Render one control per selector branch (14 total) and
 * confirm all 14 are collected and checked.
 */
describe("assertKioskDensityCompliant — the interactive-control selector covers all 14 branches", () => {
  const SELECTOR_FIXTURES: readonly (() => HTMLElement)[] = [
    () => document.createElement("button"),
    () => document.createElement("input"),
    () => document.createElement("select"),
    () => document.createElement("textarea"),
    () => {
      const el = document.createElement("a");
      el.href = "#";
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "button");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "checkbox");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "radio");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "switch");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "menuitem");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "menuitemcheckbox");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "option");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.setAttribute("role", "tab");
      return el;
    },
    () => {
      const el = document.createElement("div");
      el.tabIndex = 0;
      return el;
    },
  ];

  it("has exactly 14 fixtures — one per selector branch (keep this in sync with density.ts)", () => {
    expect(SELECTOR_FIXTURES.length).toBe(14);
  });

  it("collects and flags a control for every branch of the selector", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    for (const create of SELECTOR_FIXTURES) {
      const el = create();
      el.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 4}px`;
      el.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
      container.appendChild(el);
    }

    let thrown: unknown;
    try {
      assertKioskDensityCompliant(container);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DensityViolationError);
    expect((thrown as DensityViolationError).violations).toHaveLength(SELECTOR_FIXTURES.length);
  });
});

/** Mutation-survivor coverage: `isRenderable` is an untested exclusion path.
 * A mutant that disables it entirely, or one that makes it exclude anything
 * with a `class` attribute (every real-world control has one), both
 * survived green.
 */
describe("assertKioskDensityCompliant — isRenderable exclusions", () => {
  it("excludes a control with the hidden attribute from the collected control set", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const hiddenButton = document.createElement("button");
    hiddenButton.hidden = true;
    // Deliberately a gross violation: if `hidden` were NOT excluded, this
    // would throw. If it IS excluded, only the compliant button remains and
    // nothing throws.
    hiddenButton.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 30}px`;
    hiddenButton.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(hiddenButton);
    appendCompliantButton(container);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });

  it('excludes a control with aria-hidden="true" from the collected control set', () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const hiddenButton = document.createElement("button");
    hiddenButton.setAttribute("aria-hidden", "true");
    hiddenButton.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 30}px`;
    hiddenButton.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(hiddenButton);
    appendCompliantButton(container);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });

  it("does NOT exclude a control merely for having a class attribute", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const classedButton = document.createElement("button");
    classedButton.className = "some-real-world-class another-one";
    classedButton.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 30}px`;
    classedButton.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(classedButton);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityViolationError);
  });
});

/** Regression coverage for unit-aware length parsing: the resolver
 * used a bare `Number.parseFloat`, which is unit-blind — it takes a length
 * string's numeric PREFIX and silently discards the unit. `"100%"` parsed as
 * `100` (>= 48, so a control this helper cannot actually measure was
 * CERTIFIED compliant — fail-OPEN); `"3rem"` (== 48px, compliant) parsed as
 * `3`, producing a false red with the wrong number. The fix requires the
 * unit (`px` literal, or `rem` converted against the root font-size).
 */
describe("assertKioskDensityCompliant — the resolver requires a unit, it is not unit-blind (HIGH-7)", () => {
  it("throws DensityUnresolvableStyleError for a percentage token, rather than certifying it compliant", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();

    const style = document.createElement("style");
    style.textContent = `
      :root[data-density="kiosk"] {
        --control-h: 100%;
      }
      .pct-control {
        height: var(--control-h);
      }
    `;
    document.head.appendChild(style);

    try {
      const control = document.createElement("button");
      control.className = "pct-control";
      control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
      container.appendChild(control);

      // Before the fix: Number.parseFloat("100%") === 100, and 100 >= 48,
      // so this control was silently CERTIFIED compliant — the exact
      // fail-open bug this helper exists to eliminate, on a control it
      // cannot actually measure.
      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityUnresolvableStyleError);
    } finally {
      document.head.removeChild(style);
    }
  });

  it("throws DensityUnresolvableStyleError for a unitless (invalid CSS) token value", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();

    const style = document.createElement("style");
    style.textContent = `
      :root[data-density="kiosk"] {
        --control-h: 48;
      }
      .unitless-control {
        height: var(--control-h);
      }
    `;
    document.head.appendChild(style);

    try {
      const control = document.createElement("button");
      control.className = "unitless-control";
      control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
      container.appendChild(control);

      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityUnresolvableStyleError);
    } finally {
      document.head.removeChild(style);
    }
  });

  it("resolves a compliant `rem` token to the correct pixel value and does not throw (3rem == 48px)", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();

    const style = document.createElement("style");
    style.textContent = `
      :root[data-density="kiosk"] {
        --control-h: 3rem;
        --control-font: 1.125rem;
      }
      .rem-control {
        height: var(--control-h);
        font-size: var(--control-font);
      }
    `;
    document.head.appendChild(style);

    try {
      const control = document.createElement("button");
      control.className = "rem-control";
      container.appendChild(control);

      // Before the fix: Number.parseFloat("3rem") === 3, so height resolved
      // to 3 (not 48) and this threw a DensityViolationError saying "height
      // 3px is below the kiosk minimum 48px" — a false red with the wrong
      // number, even though 3rem (at the default 16px root) IS 48px.
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      document.head.removeChild(style);
    }
  });

  it("resolves a `rem` value set directly (no var() indirection) to the correct pixel value", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const control = document.createElement("button");
    control.style.height = "3rem";
    control.style.fontSize = "1.125rem";
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });
});

/** Regression coverage for multiple unresolvable controls: every
 * unresolvable fixture above has 100% unresolvable controls, so two mutants
 * survived green — throwing only when EVERY control is unresolvable
 * (`unresolvableControls.length === controls.length`), and reporting only
 * the first unresolvable control instead of every one. This mirrors the
 * existing "checks EVERY control" test, but for the unresolvable path.
 */
describe("assertKioskDensityCompliant — the unresolvable path checks EVERY control, not just when ALL are unresolvable", () => {
  it("flags exactly the one mistyped-token control among five resolvable, compliant ones", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    for (let i = 0; i < 5; i += 1) {
      appendCompliantButton(container);
    }
    const mistyped = document.createElement("button");
    mistyped.setAttribute("aria-label", "The one mistyped-token control");
    mistyped.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 8}px`;
    // A typo'd/undefined custom property: unresolvable even after one level
    // of var resolution, while the other five controls above are fully
    // resolvable and compliant.
    mistyped.style.fontSize = "var(--typo)";
    container.appendChild(mistyped);

    let thrown: unknown;
    try {
      assertKioskDensityCompliant(container);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DensityUnresolvableStyleError);
    const unresolvableError = thrown as DensityUnresolvableStyleError;
    expect(unresolvableError.controls).toHaveLength(1);
    expect(unresolvableError.message).toMatch(/1 of 6 control\(s\)/);
    expect(unresolvableError.message).toMatch(/The one mistyped-token control/);
  });

  it("names BOTH unresolvable controls, not just the first, among otherwise-resolvable compliant ones", () => {
    // A single-unresolvable fixture cannot distinguish "report every
    // unresolvable control" from "report only the first" — both behave
    // identically when there is only one. This fixture has TWO, which is
    // what actually kills that mutant.
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    for (let i = 0; i < 4; i += 1) {
      appendCompliantButton(container);
    }
    const firstMistyped = document.createElement("button");
    firstMistyped.setAttribute("aria-label", "First mistyped control");
    firstMistyped.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 8}px`;
    firstMistyped.style.fontSize = "var(--typo-one)";
    container.appendChild(firstMistyped);

    const secondMistyped = document.createElement("button");
    secondMistyped.setAttribute("aria-label", "Second mistyped control");
    secondMistyped.style.height = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 8}px`;
    secondMistyped.style.fontSize = "var(--typo-two)";
    container.appendChild(secondMistyped);

    let thrown: unknown;
    try {
      assertKioskDensityCompliant(container);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DensityUnresolvableStyleError);
    const unresolvableError = thrown as DensityUnresolvableStyleError;
    expect(unresolvableError.controls).toHaveLength(2);
    expect(unresolvableError.message).toMatch(/2 of 6 control\(s\)/);
    expect(unresolvableError.message).toMatch(/First mistyped control/);
    expect(unresolvableError.message).toMatch(/Second mistyped control/);
  });
});

/** Mutation-survivor coverage: the documented min-height fallback (used when
 * no explicit `height` is set — the common touch-target pattern) had no
 * dedicated test; deleting the fallback entirely survived green.
 */
describe("assertKioskDensityCompliant — min-height fallback", () => {
  it("uses min-height when no explicit height is set, and flags it below the kiosk minimum", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const control = document.createElement("button");
    control.style.minHeight = `${KIOSK_MIN_CONTROL_HEIGHT_PX - 5}px`;
    control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityViolationError);
  });

  it("does not throw when min-height alone meets the kiosk minimum", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    const control = document.createElement("button");
    control.style.minHeight = `${KIOSK_MIN_CONTROL_HEIGHT_PX + 4}px`;
    control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });
});

/** The root font-size seam. `rem` is resolved against the ROOT element's own computed
 * font-size, and nothing pinned that: with every fixture running at jsdom's default 16px,
 * a helper that hardcoded 16 — or read the wrong element — behaved identically and passed.
 * That is a live fail-open: on a product that scales its root font down to 10px, a `3rem`
 * control is 30px and a hardcoded 16 would compute 48 and certify it.
 */
describe("assertKioskDensityCompliant — rem resolves against the real root font-size", () => {
  // These MUST go through var indirection. jsdom resolves a directly-written `3rem` to px
  // itself (measured: `height: 3rem` under a 10px root computes to "30px"), so the direct path
  // never reaches parseRem — a version of these tests without var passed even with the root
  // font-size hardcoded to 16, i.e. proved nothing. The token path is also the only shape a real
  // surface will produce, since SC-005 forbids inline styles.
  it("certifies a rem token that is genuinely large enough at a NON-default root size", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    document.documentElement.style.fontSize = "20px";
    const container = mountContainer();
    container.style.setProperty("--probe-h", "2.4rem"); // x 20px = 48px, exactly the minimum
    container.style.setProperty("--probe-fs", "0.9rem"); // x 20px = 18px
    const control = document.createElement("button");
    control.style.height = "var(--probe-h)";
    control.style.fontSize = "var(--probe-fs)";
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).not.toThrow();
  });

  it("rejects a rem token that is too small because the root font-size is small", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    document.documentElement.style.fontSize = "10px";
    // `rem` is ROOT-relative by definition, so body must differ from root here — otherwise a
    // helper reading the font-size off `body` (which merely inherits it) measures identically
    // and the test proves nothing.
    document.body.style.fontSize = "30px";
    const container = mountContainer();
    container.style.setProperty("--probe-h", "3rem"); // x 10px = 30px, below the minimum
    const control = document.createElement("button");
    control.style.height = "var(--probe-h)";
    control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(control);

    // A hardcoded 16 would compute 3 x 16 = 48 and certify a 30px control.
    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityViolationError);
    // The reported number must be the real one, not the assumed-16px one.
    expect(() => assertKioskDensityCompliant(container)).toThrow(/30px/);
  });
});

/** `em` inside a token is a DELIBERATE fail-closed gap, not an oversight: resolving it needs
 * the control's own font-size cascade, and a wrong implementation would resolve it against
 * the root — i.e. silently treat `em` as `rem`. Pinned so nobody widens the rem pattern into
 * `/r?em$/` and turns a documented gap into a silent miscalculation.
 */
describe("assertKioskDensityCompliant — em inside a token stays unresolvable", () => {
  it("throws rather than resolving an em-valued custom property against the root", () => {
    setDensity(KIOSK_DENSITY_VALUE);
    const container = mountContainer();
    container.style.setProperty("--probe-control-h", "3em");
    const control = document.createElement("button");
    control.style.height = "var(--probe-control-h)";
    control.style.fontSize = `${KIOSK_MIN_FONT_SIZE_PX + 2}px`;
    container.appendChild(control);

    expect(() => assertKioskDensityCompliant(container)).toThrow(DensityUnresolvableStyleError);
  });
});
