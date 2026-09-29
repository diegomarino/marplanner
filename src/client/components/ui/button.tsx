import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // FR-001/FR-003: height and text size are BOTH density tokens, referenced via
  // Tailwind arbitrary-value utilities (never an inline `style` attribute — SC-005) so a
  // button can never render large (density-driven height) with small text (a literal `text-*`
  // scale class), or the reverse. See src/client/styles/globals.css's density-token comment.
  // `transition-all` animated `data-density` toggles
  // (measured: t=50ms mid-transition reported 43.6px/16.9px, a fractional value neither density
  // token) — invisible under jsdom, but a Playwright density assertion sampling mid-transition
  // would see a bogus in-between size. Narrowed to match Input and SelectTrigger, which already
  // use `transition-[color,box-shadow]` and snap instantly on a density change.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md h-[var(--control-height)] text-[length:var(--control-font-size)] font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Every size variant shares the SAME height/text tokens from the base class above — a
      // "sm" button must still meet the kiosk minimum when kiosk density is active (SC-001,
      // SC-002 apply to 100% of controls, not just the default variant). Variants differ only
      // in padding/gap/radius, never in height or text size.
      size: {
        default: "px-4 py-2 has-[>svg]:px-3",
        sm: "rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "rounded-md px-6 has-[>svg]:px-4",
        icon: "w-[var(--control-height)] px-0",
      },
      // The base class's `whitespace-nowrap` + fixed `h-[var(--control-height)]` are
      // correct for a FIXED action label ("Save", "Cancel") but wrong for a control whose label
      // is USER-AUTHORED DATA (a chore/recipe/plan/event name) — that text cannot be predicted
      // to fit, so forcing one line and a fixed box makes it bleed into the neighbouring
      // control instead of wrapping. `wrap` permits both: `whitespace-normal` lets the label
      // wrap, and `h-auto` + `min-h-[var(--control-height)]` lets the box grow with it while
      // the kiosk/comfortable density minimum stays a FLOOR (SC-001/SC-002 set a minimum, not a
      // fixed size, so growing past it is compatible with them). `text-left items-start` keep a
      // wrapped multi-line label top-aligned instead of vertically centered against a taller
      // box.
      //
      // `whitespace-normal` alone only permits breaking
      // AT AN EXISTING BREAK OPPORTUNITY (a space). A label with none — a URL, an unspaced
      // CamelCase string, 50 repeated characters — never wraps and reproduces the original
      // overflow even with `wrap` on (measured in a real browser at kiosk in a 200px container:
      // 231px/308px/418px horizontal overflow for those three shapes respectively).
      // `overflow-wrap: break-word` (`break-words`) makes NO difference (same
      // 231/308/418px) because `Button` is `inline-flex`, so its text renders as an anonymous
      // flex item with `min-width: auto`, and `break-word` only breaks a line that ALREADY
      // overflows its container — it does not reduce the box's own min-content contribution, so
      // an `inline-flex` parent never shrinks it. Only `overflow-wrap: anywhere`
      // (`wrap-anywhere`) or `word-break: break-all` (`break-all`) participate in min-content
      // sizing and measured 0px overflow on all three shapes. `wrap-anywhere` is preferred over
      // `break-all`: `anywhere` only breaks mid-word when there is no other option, `break-all`
      // breaks mid-word even when a normal space-break would have worked, producing needlessly
      // ragged wraps on the common (spaced) label. `wrap-anywhere` is APPLIED ONLY under `wrap`
      // — a fixed action label never needs it and this keeps normal short-label wrapping
      // untouched.
      //
      // The style guide's recommended verification
      // shape ("per-control containment in BOTH axes") goes GREEN even when a `wrap` Button
      // pushes its flex ROW past its own container, because the base class's `shrink-0` means a
      // `wrap` Button never shrinks to fit its flex parent — it grows to its (now unbounded,
      // post `wrap-anywhere`, still non-trivial) max-content width and pushes the row instead,
      // and because it never overflows ITSELF the per-control assertion never fires. Measured in
      // a real browser (`wrap` Button + an `OK` button in a 400px flex row, kiosk): base
      // (`shrink-0` kept) renders a 436px button with a 103px ROW overflow while its OWN
      // wOver/hOver read 0/0 (green theatre); adding `shrink` here (undoing `shrink-0` for this
      // variant only) renders a 333px, 2-line button with 0px row overflow. `min-w-0` alone
      // (keeping `shrink-0`) was also measured and is NOT sufficient (still 436px / 103px row
      // overflow) — `shrink` is the one that matters, because `shrink-0` is what pins the flex
      // item to its max-content basis in the first place. `w-full` at a call site (e.g.
      // `ChoresBoard.tsx`) is an ADDITIONAL, separate escape from the same failure — a block
      // context has no flex-row max-content pressure to begin with — and stays a call-site
      // layout concern, not part of this mechanism.
      //
      // cva emits these classes AFTER `variant`/`size` and BEFORE a call site's own `className`,
      // and `cn` (tailwind-merge) resolves the `whitespace-*`/`h-*`/`items-*`/`shrink-*`
      // conflicts by last-one-wins-per-group, so `wrap` reliably overrides the base without
      // `!important` and a call site's `className` can still layer unrelated classes on top.
      wrap: {
        true: "h-auto min-h-[var(--control-height)] whitespace-normal wrap-anywhere text-left items-start shrink",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      wrap: false,
    },
  }
);

function Button({
  className,
  variant,
  size,
  wrap,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, wrap, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
