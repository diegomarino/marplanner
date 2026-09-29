/** Layer-free density style injector.
 * WHY THIS FILE EXISTS: the compiled production stylesheet wraps every Tailwind utility class
 * (including the three density-token utilities used by the density components —
 * `h-[var(--control-height)]`, `w-[var(--control-height)]`,
 * `text-[length:var(--control-font-size)]`) inside `@layer utilities {... }`. jsdom 30 (this
 * repo's vitest.config.ts environment for `tests/client`) drops `@layer`-wrapped rules entirely
 * when computing style — measured against a real `vite build` output: a class-styled `<Button>`
 * reports `getComputedStyle(button).height === "auto"`, and `assertKioskDensityCompliant`
 * (`./density.ts`) throws `DensityUnresolvableStyleError` because jsdom cannot measure the
 * dropped CSS rules. This helper injects shared density styles before component tests run.
 * `tests/client/helpers/density.ts` checks measured styles but does not provide them. This helper
 * injects the shared density rules into jsdom tests.
 * USAGE (every component that calls `assertKioskDensityCompliant` needs this):
 * import { injectDensityStyles } from "./helpers/densityStyles";
 * import { assertKioskDensityCompliant } from "./helpers/density";
 * it("meets kiosk density", async => {
 * const uninject = await injectDensityStyles;
 * document.documentElement.setAttribute("data-density", "kiosk");
 * try {
 * const { container } = render(<MySurface />);
 * assertKioskDensityCompliant(container);
 * } finally {
 * uninject;
 * document.documentElement.removeAttribute("data-density");
 * }
 * });
 * `injectDensityStyles` is ASYNC (Tailwind's compiler is a promise-returning API) — `await` it
 * before rendering. It appends one `<style>` element to `document.head` and returns a cleanup
 * function; call that cleanup (or let a fresh jsdom document per test file discard it) so one
 * test's injected styles never leak into the next.
 * HOW THE CSS IS DERIVED (not hand-copied): this file reads the real, shipped
 * `src/client/styles/globals.css` off disk and feeds it to `@tailwindcss/node`'s `compile` —
 * the same compiler `@tailwindcss/vite` calls during a real `vite build` — asking it to `build`
 * only the literal utility class names the density-token primitives actually use. That is
 * genuine Tailwind output, not a transcription: if a future edit changes what
 * `h-[var(--control-height)]` compiles to (a different property, a different escaping), this
 * helper's output changes with it automatically, because it re-derives from source every time
 * the process compiles it (cached per-process below, since `compile` costs ~10ms and every
 * implementation would otherwise pay it once per test file). The only hand-written step is
 * `stripLayeredAtRules` below, which un-wraps `@layer <name> {... }` blocks in place (keeping
 * their contents, dropping the wrapper) and drops bare `@layer a, b, c;` layer-order
 * declarations — this is what makes the output digestible by jsdom, and it is a mechanical,
 * content-independent transform (verified against the exact byte range Tailwind wraps in
 * `@layer utilities` in a real build: 7841–31807 in `dist/client/assets/index-*.css`, matching
 * matching the emitted stylesheet), not a copy of any specific token value.
 * `extraCandidates` lets a change compile its OWN literal utility classes through this same real
 * pipeline — e.g. an intentionally-undersized fixture control in a regression test — so a proof
 * of the failure path never needs a hand-copied CSS literal either.
 */

import { compile } from "@tailwindcss/node";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS_PATH = path.resolve(HERE, "../../../src/client/styles/globals.css");

/** The three density-token utilities every migrated primitive (Button, Input, SelectTrigger)
 * consumes — see globals.css's density-token comment block and the usages. Always compiled,
 * regardless of `extraCandidates`. */
const BASE_DENSITY_UTILITY_CANDIDATES: readonly string[] = [
  "h-[var(--control-height)]",
  "w-[var(--control-height)]",
  // `min-h-` is here even though no primitive uses it today: the FROZEN helper explicitly falls
  // back to `min-height` when `height` is unset, and min-height is the conventional way to size a
  // touch target that must grow with its content. A change reaching for it would otherwise get an
  // `DensityUnresolvableStyleError` and have to discover `extraCandidates` — against a frozen file
  // it cannot edit. Cheaper to include it than to have thirteen batches each rediscover this.
  "min-h-[var(--control-height)]",
  "text-[length:var(--control-font-size)]",
];

type TailwindBuilder = { build(candidates: string[]): string };

let compilerPromise: Promise<TailwindBuilder> | null = null;

/** Compiles `globals.css` through the real Tailwind pipeline exactly once per process; every
 * subsequent call (including from other test files sharing this module in the same worker)
 * reuses the same compiled design system and only re-runs the cheap `build(candidates)` step. */
function getCompiler(): Promise<TailwindBuilder> {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const source = readFileSync(GLOBALS_CSS_PATH, "utf8");
      const { build } = await compile(source, {
        base: path.dirname(GLOBALS_CSS_PATH),
        onDependency: () => {
          // Nothing to do — this helper doesn't watch for changes, it recompiles once per
          // process (a fresh `vitest` run always re-reads the file from disk).
        },
      });
      return { build };
    })();
  }
  return compilerPromise;
}

/** Un-wraps every `@layer <name(s)> {... }` block in `css`, keeping its contents and discarding
 * the wrapper — this is the one thing that makes Tailwind's real output usable in jsdom, which
 * drops `@layer`-wrapped rules wholesale. Also drops bare layer-order declarations
 * (`@layer theme, base, components, utilities;`), which carry no styles and are meaningless
 * without the layer blocks jsdom cannot see. A simple brace-depth scan, not a CSS parser — safe
 * here because the input is Tailwind-generated (no braces inside string values in this output).
 * TWO STATED LIMITS, both currently unreachable and both FAIL-CLOSED if they ever are not:
 * - NESTED layers (`@layer a { @layer b {... } }`) leave the inner wrapper intact. Tailwind
 * 4.3.3 emits flat layers (measured: zero residual `@layer` in the real output), and if that
 * ever changed the rules would stay wrapped, jsdom would drop them, and the assertion would
 * throw `DensityUnresolvableStyleError` — loud, never a false green.
 * - A literal `@layer` inside a string value would be mangled. Tailwind emits none.
 * Also worth knowing when writing a change spec: a RESPONSIVE variant (`md:h-[...]`) compiles to an
 * `@media` query, which jsdom does not apply — so it too fails closed rather than silently passing.
 */
function stripLayeredAtRules(css: string): string {
  let result = "";
  let i = 0;
  while (i < css.length) {
    const marker = css.indexOf("@layer", i);
    if (marker === -1) {
      result += css.slice(i);
      break;
    }
    result += css.slice(i, marker);
    const braceStart = css.indexOf("{", marker);
    const semi = css.indexOf(";", marker);
    if (braceStart === -1 || (semi !== -1 && semi < braceStart)) {
      // Bare `@layer a, b, c;` layer-order declaration — no body, drop it whole.
      i = semi === -1 ? css.length : semi + 1;
      continue;
    }
    let depth = 1;
    let j = braceStart + 1;
    while (depth > 0 && j < css.length) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    // Keep the block's inner content (between the braces), drop `@layer <name> {` and the
    // matching closing `}`.
    result += css.slice(braceStart + 1, j - 1);
    i = j;
  }
  return result;
}

/** Compiles the density-token utilities (plus any `extraCandidates`) through the real Tailwind
 * pipeline and returns layer-free CSS text, safe to drop into a jsdom `<style>` element. Exported
 * mainly so a test can assert on the CSS text itself; most callers want `injectDensityStyles`
 * below instead.
 */
export async function compileDensityStyleSheet(
  extraCandidates: readonly string[] = []
): Promise<string> {
  const { build } = await getCompiler();
  const raw = build([...BASE_DENSITY_UTILITY_CANDIDATES, ...extraCandidates]);
  return stripLayeredAtRules(raw);
}

export interface InjectDensityStylesOptions {
  /** Additional literal Tailwind utility class names to compile and inject alongside the three
   * density-token utilities every component needs — e.g. a change's own deliberately-undersized proof
   * fixture. Compiled through the same real pipeline as the density tokens, never hand-copied. */
  extraCandidates?: readonly string[];
  /** Defaults to the ambient jsdom `document`; pass an explicit one only when asserting against a
   * document other than the ambient one. */
  doc?: Document;
}

/** Injects the layer-free density-token CSS (see file header) into `doc.head` and returns a
 * cleanup function that removes it. Call this BEFORE rendering and setting `data-density` — see
 * the usage example in the file header.
 */
export async function injectDensityStyles(
  options: InjectDensityStylesOptions = {}
): Promise<() => void> {
  const { extraCandidates = [], doc = document } = options;
  const css = await compileDensityStyleSheet(extraCandidates);
  const styleEl = doc.createElement("style");
  styleEl.setAttribute("data-testid", "density-styles-helper");
  styleEl.textContent = css;
  doc.head.appendChild(styleEl);
  return () => {
    styleEl.remove();
  };
}
