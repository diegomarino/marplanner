/** SelectItem density spec.
 * `src/client/components/ui/select.tsx`'s trigger uses density tokens, but its POPOVER
 * OPTIONS need their own coverage because a closed select renders no items. This test opens a real
 * `Select` popover with kiosk density active and calls the frozen density assertion
 * (`tests/client/helpers/density.ts`, do not edit) over the rendered options, proves BOTH
 * densities are actually tracked (not a value hardcoded to kiosk), and records a deliberate
 * negative showing the assertion can fail on this exact surface.
 * jsdom notes (Radix Select, `position="popper"` default):
 * - The trigger's `onClick` handler opens the popover whenever the internal pointer-type ref is
 * not "mouse" (it defaults to "touch"), so a plain `fireEvent.click(trigger)` — no synthetic
 * PointerEvent — opens it without ever touching `hasPointerCapture`/`releasePointerCapture`,
 * which jsdom 30 does not implement.
 * - `SelectContent`'s popper positioning goes through `@floating-ui/dom`'s `autoUpdate`, which
 * gates its `ResizeObserver` usage behind `typeof ResizeObserver === "function"` — false under
 * jsdom 30 — so it degrades gracefully with no polyfill needed. `useSize` (the OTHER
 * ResizeObserver consumer in `@radix-ui/react-popper`) is only invoked for an `Arrow` primitive
 * this component never renders.
 * - Focusing the first/selected item on open calls `Element.prototype.scrollIntoView`, which
 * jsdom 30 does not implement at all (not even a no-op) — stubbed below for this file only.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

const DAYS = Array.from({ length: 12 }, (_, i) => i + 1);

function DayPicker() {
  return (
    <Select defaultValue="1">
      <SelectTrigger data-testid="day-picker-trigger">
        <SelectValue placeholder="Day" />
      </SelectTrigger>
      <SelectContent>
        {DAYS.map((day) => (
          <SelectItem key={day} value={String(day)}>{`Day ${day}`}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

async function openPicker() {
  render(<DayPicker />);
  fireEvent.click(screen.getByTestId("day-picker-trigger"));
  const options = await screen.findAllByRole("option");
  expect(options.length).toBe(DAYS.length);
  return options;
}

let originalScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;

beforeAll(() => {
  // jsdom 30 implements neither a real nor a no-op `scrollIntoView` — Radix's own
  // open-popover focus-management effect calls it unconditionally. See file header.
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  // jsdom 30 ships no `scrollIntoView` at all, so `originalScrollIntoView` is always undefined here
  // and a restore-if-truthy would never run — a teardown that only looks like one. Delete the stub
  // in that case so the prototype really is left as we found it.
  if (originalScrollIntoView) {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  } else {
    delete (Element.prototype as Partial<typeof Element.prototype>).scrollIntoView;
  }
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("SelectItem — kiosk density on the rendered popover options (#790)", () => {
  it("meets kiosk density once the popover is OPEN, over the rendered options — the state no prior batch measured", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      await openPicker();
      // Asserted against document.body: SelectContent portals outside the render container,
      // exactly like ConfirmDialog/CalendarView's own density specs.
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("tracks data-density rather than being hardcoded to the kiosk value — comfortable renders the comfortable token, kiosk renders the kiosk one, both via the SAME var() reference", async () => {
    // `assertKioskDensityCompliant` refuses to run at all unless kiosk density is active
    // (obligation 1), so a hardcoded-vs-tracked distinction can't be made by calling the frozen
    // helper under comfortable — this test reads the computed style directly instead, the same
    // way the frozen helper's own resolver does (see density.ts's header comment: jsdom does not
    // substitute var(...) inside getComputedStyle, so a token-driven property reads back as the
    // literal, unresolved `var(--token)` reference string; only a HARDCODED literal reads back
    // as a plain px number).
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "comfortable");
    try {
      const options = await openPicker();
      const option = options[0];
      const style = getComputedStyle(option);

      // The option's OWN declared min-height/font-size are the var reference itself, not a
      // literal pixel value picked per density — this is what a "hardcoded to 48px/18px, works
      // to look right under kiosk, silently wrong under comfortable" mutation would fail: it
      // would report a literal "48px"/"18px" here, in EITHER density.
      expect(style.minHeight).toBe("var(--control-height)");
      expect(style.fontSize).toBe("var(--control-font-size)");

      // The referenced custom property itself resolves to the COMFORTABLE value here...
      expect(style.getPropertyValue("--control-height").trim()).toBe("36px");
      expect(style.getPropertyValue("--control-font-size").trim()).toBe("14px");

      //...and to the KIOSK value once the SAME already-rendered option is re-measured after
      // only the root attribute flips — no re-render — proving the option's effective size is
      // driven by the live `data-density` cascade, not frozen at render time.
      document.documentElement.setAttribute("data-density", "kiosk");
      const kioskStyle = getComputedStyle(option);
      expect(kioskStyle.getPropertyValue("--control-height").trim()).toBe("48px");
      expect(kioskStyle.getPropertyValue("--control-font-size").trim()).toBe("18px");
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing a rendered option below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const options = await openPicker();
      const target = options[0];

      // Sanity: compliant before the mutation.
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // `minHeight` MUST be overridden alongside `height`, and that is not belt-and-braces.
      // The production class is `min-h-[var(--control-height)]`, and the frozen helper resolves an
      // explicit `height` BEFORE falling back to `min-height` (see `resolveControlHeightPx`). So
      // setting `height` alone makes the helper report 10px while a real browser would still lay
      // the option out at 48px — the min-height wins there. That version of this negative proved
      // the helper reacts to an explicit height, NOT that a genuinely undersized option is caught,
      // which is the whole claim a deliberate negative exists to make.
      target.style.minHeight = "10px";
      target.style.height = "10px";
      target.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(document.body);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 10px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 8px is below the kiosk minimum 18px/);

      // Revert — compliance returns (proves the failure above was caused by the mutation,
      // not by some other broken state this test left behind). `minHeight` is restored with the
      // rest; leaving it set would silently disable the density floor for every later phase.
      target.style.minHeight = "";
      target.style.height = "";
      target.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
