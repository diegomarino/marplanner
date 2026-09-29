/** `Button` primitive spec (`components/ui/button.tsx`).
 * The `wrap` variant had * no dedicated test* — the
 * entire net for the primitive was one pre-existing e2e exercising it through a single call site
 * (`ChoresBoard.tsx`). Two mutants survived as a result:
 * - * M3* flipping `wrap`'s `defaultVariants` entry from `false` to `true` changes 240 of 262
 * non-chore buttons repo-wide (comfortable height 36px -> 37/39px, `nowrap` -> `normal`,
 * `center` -> `start`) with the full e2e suite AND all pre-existing unit tests staying green.
 * - * M5* moving `text-left` out of the `wrap: true` branch and into the base class flips
 * text-align on the same 240/262 buttons, same silence.
 * The tests below pin both: `wrap`'s default is `false` (nowrap, centered) and stays that way
 * unless a call site opts in; `text-left`/`items-start` are present ONLY on the `wrap: true`
 * branch, never on the base/default. `StatusToggle`'s forwarding is covered separately in
 * `status-toggle.test.tsx` (kills M7's static blindness — today only one e2e, on one surface,
 * catches a dropped `wrap={wrap}` forward).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

afterEach(() => {
  cleanup();
});

describe("Button wrap variant", () => {
  it("defaults to non-wrapping, centered, single-line text when `wrap` is not passed (kills M3, M5)", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });

    // The FIXED-action shape: one line, horizontally/vertically centered, fixed height.
    expect(button.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(button.className).toMatch(/\bjustify-center\b/);
    expect(button.className).toMatch(/\bitems-center\b/);
    expect(button.className).not.toMatch(/\bitems-start\b/);

    // M5's exact mutation: `text-left` must NOT be present on the default/base render.
    expect(button.className).not.toMatch(/\btext-left\b/);

    // M3's exact mutation: none of the `wrap: true` classes leak into the default render.
    expect(button.className).not.toMatch(/\bwhitespace-normal\b/);
    expect(button.className).not.toMatch(/\bwrap-anywhere\b/);
    expect(button.className).not.toMatch(/\bh-auto\b/);
  });

  it("`wrap={false}` explicitly matches the default (no silent divergence)", () => {
    render(<Button wrap={false}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(button.className).not.toMatch(/\bwhitespace-normal\b/);
    expect(button.className).not.toMatch(/\btext-left\b/);
  });

  it("`wrap={true}` applies wrapping, growth, and left/top alignment", () => {
    render(<Button wrap>A user-authored label</Button>);
    const button = screen.getByRole("button", { name: "A user-authored label" });

    expect(button.className).toMatch(/\bwhitespace-normal\b/);
    expect(button.className).not.toMatch(/\bwhitespace-nowrap\b/);
    expect(button.className).toMatch(/\btext-left\b/);
    expect(button.className).toMatch(/\bitems-start\b/);
    expect(button.className).toMatch(/\bh-auto\b/);
    expect(button.className).toMatch(/\bmin-h-\[var\(--control-height\)\]/);

    // A label with no break opportunity (a URL, an
    // unspaced string, N repeated characters) never wraps under `whitespace-normal` alone —
    // only `overflow-wrap: anywhere` (`wrap-anywhere`) participates in an `inline-flex` child's
    // min-content sizing. `break-words` measured no differently
    // from doing nothing at all (231/308/418px overflow, unchanged) because `overflow-wrap:
    // break-word` never reduces a flex item's `min-width: auto` contribution.
    expect(button.className).toMatch(/\bwrap-anywhere\b/);
    expect(button.className).not.toMatch(/\bbreak-words\b/);
    expect(button.className).not.toMatch(/\bbreak-all\b/);

    // The base class's `shrink-0` pins a `wrap` Button to
    // its max-content width inside a flex row — it never shrinks, so it pushes the ROW instead
    // of overflowing itself, and the per-control containment assertion the style guide
    // recommends never fires (green theatre). `shrink` must win over the base's `shrink-0` for
    // the `wrap: true` branch specifically.
    expect(button.className).toMatch(/(?:^|\s)shrink(?!-)/);
  });
});
