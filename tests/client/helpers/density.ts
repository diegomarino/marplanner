/** Frozen kiosk-density assertion helper (FR-018).
 * Public surface — this is the ONLY thing a per-surface test should import:
 * import { assertKioskDensityCompliant } from "../helpers/density";
 * assertKioskDensityCompliant(container);
 * `container` is whatever the surface's own test already has on hand — the
 * element returned by Testing Library's `render`, or `document.body` /
 * `document` when asserting across the whole document (e.g. a dialog
 * portalled outside the rendering surface, per SC-003).
 * WRITE-ONCE, READ-ONLY (the queued shared paths): a change that finds
 * this helper insufficient for its surface STOPS and escalates instead of
 * editing it. Weakening any of the three obligations below to make a change's
 * test pass converts this file from a gate into decoration — exactly the
 * failure mode this helper prevents.
 * The three obligations can each fail independently. Preserve a failing
 * regression case for each before changing these assertions:
 * 1. Prove kiosk density is ACTIVE before asserting anything. If the
 * document's density attribute is absent or set to "comfortable", throw
 * a distinct, loud `DensityMisconfiguredError` — a misconfigured test
 * must fail visibly, never pass vacuously.
 * 2. Fail on an EMPTY control set. Asserting over zero controls is not a
 * pass — throw `DensityEmptyControlSetError` naming the container.
 * 3. Actually DETECT a violation. A control whose rendered height or text
 * size is below the kiosk minimum makes the assertion throw
 * `DensityViolationError` naming every offending control.
 * Obligation 3 fail-closed hardening: jsdom does not substitute `var` inside
 * `getComputedStyle`. Kiosk sizing on migrated surfaces comes from custom
 * properties on a `[data-density]` root because SC-005 forbids inline styles.
 * jsdom reports the literal string `"var(--control-h)"` for `height`, which
 * `parseFloat` turns into `NaN`. Treating "could not measure" as "compliant"
 * is exactly backwards, so:
 * 3a. A raw value shaped like `var(--foo)` is resolved ONE level by
 * reading `--foo` off the same computed style (jsdom DOES resolve
 * custom-property inheritance/cascade, just not `var` substitution).
 * 3b. If a control's height or font-size is STILL unresolvable after that
 * (e.g. the custom property itself is undefined, or the value is
 * something the resolver below cannot parse at all), the assertion
 * throws `DensityUnresolvableStyleError` naming every such control —
 * it does NOT silently treat the control as compliant. This is what
 * turns a silent green on an 8px-tall, 4px-text token-styled surface
 * into a loud, actionable red.
 * Obligation 3 fail-closed hardening: the resolver is UNIT-AWARE,
 * not unit-blind: the first hardening pass
 * (3a/3b above) still resolved a length with a bare `Number.parseFloat`,
 * which takes a string's numeric PREFIX and silently discards the unit.
 * `"100%"` parsed as `100` (>= 48, so a control this helper cannot actually
 * measure was CERTIFIED compliant — fail-OPEN, the exact bug this file
 * exists to eliminate); `"48"` with no unit at all (invalid CSS) parsed as
 * `48` for the same reason; `"3rem"` (== 48px, compliant) parsed as `3`,
 * producing a false red with the wrong number in the message. The resolver
 * (`parsePx` / `parseRem` / `parseLength`, below `VAR_REFERENCE_PATTERN`)
 * now accepts ONLY a literal `px` value or a `rem` value converted against
 * the root element's own computed font-size (jsdom resolves that to a
 * literal px value, e.g. `16px`, by default) — every other shape, `%`
 * included, is `NaN` and therefore routes to `DensityUnresolvableStyleError`
 * rather than being silently certified or silently misreported.
 * The resolver's limits — a design token or literal style shaped like one of
 * these rows makes a control UNRESOLVABLE (safe: it throws loud, it is never
 * silently certified compliant) rather than measured. All of these fail
 * CLOSED, but a change hitting one of them against this frozen file cannot
 * fix the helper — it must change the token/style shape instead:
 * | shape | result |
 * |-------------------------------------------|---------------------------|
 * | `var(--control-h, 48px)` with the token defined | Resolves the token |
 * | `var(--missing, 8px)` with token undefined | Unresolvable, though a browser would render 8px (a real violation) |
 * | `var(--a, var(--b))` (nested var) | Unresolvable (one level of indirection by design) |
 * | `--a: var(--b)` (token aliasing) | Unresolvable |
 * | `--control-h: calc(2 * 4px)` | Unresolvable |
 * | `height: calc(2 * 4px)` written directly | jsdom pre-computes to `8px` and resolves |
 * | Token on an intermediate ancestor | Resolves through custom-property inheritance |
 * | `--control-h: 3em` / `--control-fs: 1.1em` | Unresolvable: `em` inside a token depends on the control's font-size cascade |
 * | Direct `font-size: 1.125em` | Resolves through jsdom's cascade to a literal pixel value |
 * * The density tokens must resolve to a literal `px` (or root-relative
 * `rem`) value within one level of `var` indirection.* Percentages, `calc`
 * inside a custom property, nested `var`, token aliasing, and `em` are not
 * resolved. Extend this helper to support another shape so the invariant stays centralized.
 * Kiosk minimums (`KIOSK_MIN_CONTROL_HEIGHT_PX` / `KIOSK_MIN_FONT_SIZE_PX`)
 * reflect measured token behavior: toggling `data-density` on `documentElement`
 * moved a real control's height from 32px to 48px and font size from 14px to 18px.
 * Keep these expectations aligned with the token values in `src/client/styles/globals.css`.
 */

export const DENSITY_ATTRIBUTE = "data-density";
export const KIOSK_DENSITY_VALUE = "kiosk";
export const COMFORTABLE_DENSITY_VALUE = "comfortable";

/** Kiosk minimums measured from the density token output. */
export const KIOSK_MIN_CONTROL_HEIGHT_PX = 48;
export const KIOSK_MIN_FONT_SIZE_PX = 18;

/** Interactive controls, per Key Entities > "Density": anything a
 * family member can operate. Deliberately broad — a selector that is too
 * narrow would let a real control silently escape obligation 3.
 */
const INTERACTIVE_CONTROL_SELECTOR = [
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

/** Base class for every failure this helper raises. Never caught silently. */
export abstract class DensityAssertionError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Obligation 1: kiosk density was not proven active before asserting. */
export class DensityMisconfiguredError extends DensityAssertionError {
  constructor(actual: string | null) {
    super(
      `assertKioskDensityCompliant: kiosk density is not active ` +
        `(document.documentElement[${DENSITY_ATTRIBUTE}] = ${JSON.stringify(actual)}). ` +
        `A density test MUST set document.documentElement.setAttribute(${JSON.stringify(
          DENSITY_ATTRIBUTE
        )}, ${JSON.stringify(KIOSK_DENSITY_VALUE)}) before rendering — this test would otherwise ` +
        `pass vacuously without ever checking kiosk density (research D2, obligation 1).`
    );
  }
}

/** Obligation 2: the collected control set was empty. */
export class DensityEmptyControlSetError extends DensityAssertionError {
  constructor() {
    super(
      "assertKioskDensityCompliant: the collected interactive-control set is empty — " +
        "asserting kiosk density over zero controls proves nothing (research D2, obligation 2). " +
        "Check that the container passed in actually contains the rendered surface."
    );
  }
}

export interface DensityViolation {
  readonly element: Element;
  readonly reason: string;
}

/** Obligation 3: at least one control violated the kiosk minimum. */
export class DensityViolationError extends DensityAssertionError {
  readonly violations: readonly DensityViolation[];

  constructor(violations: readonly DensityViolation[], totalControls: number) {
    const detail = violations
      .map((v) => `  - ${describeElement(v.element)}: ${v.reason}`)
      .join("\n");
    super(
      `assertKioskDensityCompliant: ${violations.length} of ${totalControls} control(s) ` +
        `violate kiosk density:\n${detail}`
    );
    this.violations = violations;
  }
}

/** Obligation 3 fail-closed hardening: at least one control's height or
 * font-size could not be resolved to a finite pixel value — even after
 * attempting one level of `var(--token)` resolution. An unmeasurable control
 * is never treated as compliant (see the file-level doc comment, "3a"/"3b").
 */
export class DensityUnresolvableStyleError extends DensityAssertionError {
  readonly controls: readonly DensityViolation[];

  constructor(controls: readonly DensityViolation[], totalControls: number) {
    const detail = controls.map((v) => `  - ${describeElement(v.element)}: ${v.reason}`).join("\n");
    super(
      `assertKioskDensityCompliant: ${controls.length} of ${totalControls} control(s) have a ` +
        `size that could not be resolved to a finite pixel value, even after one level of ` +
        `var(--token) resolution. An unmeasurable control is never treated as compliant ` +
        `(research D2, obligation 3 fail-closed hardening):\n${detail}`
    );
    this.controls = controls;
  }
}

function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const testId = element.getAttribute("data-testid");
  const testIdPart = testId ? `[data-testid="${testId}"]` : "";
  const label = element.getAttribute("aria-label");
  const labelPart = label ? ` "${label}"` : "";
  return `<${tag}${id}${testIdPart}>${labelPart}`;
}

/** Matches a computed value that jsdom left as a literal, unsubstituted
 * `var(--token)` reference — jsdom does not substitute `var` inside
 * `getComputedStyle`, so this is the ONLY case token-driven sizing hits. */
const VAR_REFERENCE_PATTERN = /^var\(\s*(--[\w-]+)/;

/** Matches a length shaped as a literal pixel value — the ONLY unit this
 * resolver accepts as directly measurable. `Number.parseFloat` alone is
 * unit-blind: it takes the numeric prefix of ANY string and silently
 * discards the unit, so `"100%"` parses as `100` and `"3rem"` parses as `3`
 * — both wrong, and the `%` case is fail-OPEN (100 >= 48 passes a control
 * this helper cannot actually measure). Requiring the unit routes every
 * non-px, non-rem shape to `Number.NaN`, which the caller MUST treat as
 * unresolvable (never as compliant).
 */
const PX_VALUE_PATTERN = /^(-?\d*\.?\d+)px$/;

/** Matches a length in root-em units. Resolved against the root element's
 * OWN computed font-size, which jsdom DOES compute to a literal px value
 * (verified: a fresh jsdom document reports `16px`) — unlike `var`
 * substitution, this needs no cascade jsdom is missing. `em` (relative to
 * the CONTROL's own font-size, not the root) is deliberately NOT resolved
 * here: that requires resolving the element's own `font-size` cascade first,
 * which is a different and harder problem — an unresolved `em` value falls
 * through to `DensityUnresolvableStyleError`, which is safe (fails closed),
 * just not as helpful as the `rem` case this fix adds.
 */
const REM_VALUE_PATTERN = /^(-?\d*\.?\d+)rem$/;

/** Parses a literal `Npx` string to `N`. Returns `NaN` for anything else,
 * INCLUDING a bare number with no unit (invalid CSS, but a real-world typo
 * this helper must not certify as compliant). */
function parsePx(value: string): number {
  const match = PX_VALUE_PATTERN.exec(value.trim());
  return match ? Number(match[1]) : Number.NaN;
}

/** Parses a literal `Nrem` string to its pixel equivalent using the given
 * root font-size. Returns `NaN` if the value isn't shaped like `Nrem`, or if
 * the root font-size itself could not be resolved to a finite pixel value. */
function parseRem(value: string, rootFontSizePx: number): number {
  if (!Number.isFinite(rootFontSizePx)) {
    return Number.NaN;
  }
  const match = REM_VALUE_PATTERN.exec(value.trim());
  return match ? Number(match[1]) * rootFontSizePx : Number.NaN;
}

/** Parses a raw CSS length to a finite pixel number, accepting ONLY `px` and
 * `rem` — see `PX_VALUE_PATTERN` and `REM_VALUE_PATTERN` above for why every
 * other unit (including no unit, and including `%`) must fail closed rather
 * than be silently truncated by a bare `parseFloat`. */
function parseLength(value: string, rootFontSizePx: number): number {
  const px = parsePx(value);
  if (Number.isFinite(px)) {
    return px;
  }
  return parseRem(value, rootFontSizePx);
}

/** Resolves a raw computed-style value to a finite pixel number. Tries a
 * direct `px`/`rem` parse first (see `parseLength`); if that fails and the
 * value is a `var(--token)` reference, resolves ONE level by reading
 * `--token` off the SAME computed style (jsdom resolves custom-property
 * cascade/inheritance even though it does not substitute `var`) and
 * parses THAT as `px`/`rem` too. Returns `NaN` if still unresolvable —
 * callers MUST treat `NaN` as "fails closed", never as "compliant".
 */
function resolvePxValue(
  rawValue: string,
  style: CSSStyleDeclaration,
  rootFontSizePx: number
): number {
  const direct = parseLength(rawValue, rootFontSizePx);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const match = VAR_REFERENCE_PATTERN.exec(rawValue.trim());
  if (match) {
    const customPropertyValue = style.getPropertyValue(match[1]).trim();
    const resolved = parseLength(customPropertyValue, rootFontSizePx);
    if (Number.isFinite(resolved)) {
      return resolved;
    }
  }
  return Number.NaN;
}

/** Resolves the effective control height: an explicit `height` wins; a
 * `min-height`-only control (the common pattern for touch targets) falls
 * back to that. Whichever resolves to a finite pixel number is used; `NaN`
 * (unresolvable, INCLUDING a `var` reference that could not be resolved)
 * propagates to the caller, which fails closed rather than skipping. */
function resolveControlHeightPx(style: CSSStyleDeclaration, rootFontSizePx: number): number {
  const explicit = resolvePxValue(style.height, style, rootFontSizePx);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const min = resolvePxValue(style.minHeight, style, rootFontSizePx);
  if (Number.isFinite(min) && min > 0) {
    return min;
  }
  return Number.NaN;
}

function resolveFontSizePx(style: CSSStyleDeclaration, rootFontSizePx: number): number {
  return resolvePxValue(style.fontSize, style, rootFontSizePx);
}

function isRenderable(element: Element): boolean {
  if (element instanceof HTMLElement && element.hidden) {
    return false;
  }
  return element.getAttribute("aria-hidden") !== "true";
}

function collectInteractiveControls(container: Document | Element): Element[] {
  return Array.from(container.querySelectorAll(INTERACTIVE_CONTROL_SELECTOR)).filter(isRenderable);
}

/** Asserts that `container` — a rendered surface, or `document.body` for
 * content mounted outside the page subtree (SC-003) — satisfies kiosk
 * density: state is active, its control set is non-empty, and every control
 * meets the kiosk minimum height and text size (SC-001, SC-002).
 * `doc` defaults to the ambient `document` (jsdom under vitest); pass an
 * explicit `Document` only when asserting against a document other than the
 * ambient one (e.g. a popup window in an e2e context).
 * Throws `DensityMisconfiguredError`, `DensityEmptyControlSetError`,
 * `DensityUnresolvableStyleError`, or `DensityViolationError` — never
 * returns a boolean. A per-surface test calls this and lets it throw; it
 * does not catch and re-assert.
 */
export function assertKioskDensityCompliant(
  container: Document | Element,
  doc: Document = document
): void {
  const densityAttribute = doc.documentElement.getAttribute(DENSITY_ATTRIBUTE);
  if (densityAttribute !== KIOSK_DENSITY_VALUE) {
    throw new DensityMisconfiguredError(densityAttribute);
  }

  const controls = collectInteractiveControls(container);
  if (controls.length === 0) {
    throw new DensityEmptyControlSetError();
  }

  const view = doc.defaultView;
  if (!view) {
    throw new Error(
      "assertKioskDensityCompliant: the given document has no associated window " +
        "(doc.defaultView is null) — cannot read computed style."
    );
  }

  // Computed once: the root element's OWN font-size, in px, used to resolve
  // any `rem` length below (see `REM_VALUE_PATTERN`). jsdom computes this to
  // a literal px value even though it does not substitute `var`.
  const rootFontSizePx = parsePx(view.getComputedStyle(doc.documentElement).fontSize);

  const unresolvableControls: DensityViolation[] = [];
  const violations: DensityViolation[] = [];
  for (const control of controls) {
    const style = view.getComputedStyle(control);
    const heightPx = resolveControlHeightPx(style, rootFontSizePx);
    const fontSizePx = resolveFontSizePx(style, rootFontSizePx);

    const unresolvedReasons: string[] = [];
    if (!Number.isFinite(heightPx)) {
      unresolvedReasons.push(
        `height could not be resolved to a finite pixel value ` +
          `(computed height=${JSON.stringify(style.height)}, min-height=${JSON.stringify(style.minHeight)})`
      );
    }
    if (!Number.isFinite(fontSizePx)) {
      unresolvedReasons.push(
        `font-size could not be resolved to a finite pixel value ` +
          `(computed font-size=${JSON.stringify(style.fontSize)})`
      );
    }
    if (unresolvedReasons.length > 0) {
      unresolvableControls.push({ element: control, reason: unresolvedReasons.join("; ") });
      // A control we cannot measure at all cannot also be scored against the
      // kiosk minimums below — it is reported once, as unresolvable.
      continue;
    }

    const violationReasons: string[] = [];
    if (heightPx < KIOSK_MIN_CONTROL_HEIGHT_PX) {
      violationReasons.push(
        `height ${heightPx}px is below the kiosk minimum ${KIOSK_MIN_CONTROL_HEIGHT_PX}px`
      );
    }
    if (fontSizePx < KIOSK_MIN_FONT_SIZE_PX) {
      violationReasons.push(
        `font-size ${fontSizePx}px is below the kiosk minimum ${KIOSK_MIN_FONT_SIZE_PX}px`
      );
    }
    if (violationReasons.length > 0) {
      violations.push({ element: control, reason: violationReasons.join("; ") });
    }
  }

  if (unresolvableControls.length > 0) {
    throw new DensityUnresolvableStyleError(unresolvableControls, controls.length);
  }
  if (violations.length > 0) {
    throw new DensityViolationError(violations, controls.length);
  }
}
