/** Executable proof that jsdom needs the density style injector: without
 * `tests/client/helpers/densityStyles.ts`, a jsdom spec has no CSS at all, so a real
 * class-styled `<Button>` computes `height: "auto"` and `assertKioskDensityCompliant`
 * (`./helpers/density.ts`, frozen) throws `DensityUnresolvableStyleError` for EVERY surface —
 * compliant or not. This file proves the fix: with the helper's injected, layer-free CSS, the
 * assertion correctly PASSES a compliant, density-token-styled control and correctly THROWS for
 * an undersized one. Thirteen migration steps depend on this contract holding.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("densityStyles helper unblocks assertKioskDensityCompliant under jsdom", () => {
  it("passes a real, class-styled Button (no inline styles) at kiosk density", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(<Button>Kiosk button</Button>);
      // Sanity check this is genuinely class-driven, not an inline-style escape hatch (SC-005).
      expect(container.querySelector("button")).not.toHaveAttribute("style");
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("still throws DensityViolationError for a control that does not meet the kiosk minimum", async () => {
    // `h-[8px]` is compiled through the SAME real Tailwind pipeline as the density tokens
    // (see densityStyles.ts's `extraCandidates`) — not a hand-copied literal — deliberately
    // undersized to prove the helper does not just make everything pass.
    const uninject = await injectDensityStyles({ extraCandidates: ["h-[8px]"] });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(<button className="h-[8px]">Undersized</button>);
      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityViolationError);
    } finally {
      uninject();
    }
  });
});
