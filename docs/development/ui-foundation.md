# UI foundation

Use shared tokens, primitives and recipes when building a client surface. The [component contract](../ui/component-contract.md) defines density, accessibility and token guarantees. The [style guide](style-guide.md) gives concrete recipe examples. Installed plugin screens appear only while their contributions are active.

## Canonical locations

| Path                            | Responsibility                                                    |
| ------------------------------- | ----------------------------------------------------------------- |
| `components.json`               | Shared UI configuration                                           |
| `src/client/styles/globals.css` | Tailwind entry and semantic token values                          |
| `src/client/components/ui/`     | Shared primitive components                                       |
| `src/client/lib/utils.ts`       | `cn()` class merge helper                                         |
| `src/client/lib/recipes.ts`     | Reusable class-string recipes without component state or behavior |

## The UI stack

The UI uses Tailwind CSS v4, shared primitives, semantic tokens and Lucide icons.

- **Tailwind CSS v4**, configured the v4 way: **CSS-based via `@theme`**, no `tailwind.config.*`, no
  `postcss.config.*`. Wired through the `@tailwindcss/vite` plugin. (Exact version per **ADR-055**.)
- **shadcn/ui**, `new-york` style, on **Radix** primitives. Components are copied into
  `src/client/components/ui/` — they are our source, not a dependency.
- **`cn()`** (clsx + tailwind-merge) for conditional classes.
- **lucide-react** for icons.

## The one theming rule (this is what makes "adapt later" cheap)

**Components reference semantic tokens only — never a literal colour, font, or hex.**

```tsx
// ✅ do
<button className="bg-primary text-primary-foreground rounded-md">
// ❌ never
<button className="bg-[#5A5A40] text-white">
```

Because every screen consumes `bg-primary` / `bg-background` / etc. (which resolve through the
`@theme inline` mapping to the CSS variables), adapting the palette from provisional defaults to the
real v2 look is a **single edit to the token _values_ in the `:root` block** (and `.dark`) of
`globals.css` — the `@theme inline` block below it just exposes those variables to Tailwind and does
not itself hold colour values. Zero changes to any component. That is the whole reason tokens can
start provisional without incurring debt.

## Design needs (inherited requirements — honour these)

The kiosk target imposes real constraints, independent of the final palette. These come from the
kiosk contract + v1's product design and are **not** provisional:

- **Light-only.** Always-on kitchen display; there is no dark theme and no theme toggle. (A `dark`
  variant may be registered for tooling compatibility, but the product ships light.)
- **Landscape-primary, orientation-adaptive.** Support both, but design for landscape first. v1 uses
  real `portrait` / `landscape` Tailwind variants driving layout — reuse that pattern when a screen
  is orientation-sensitive.
- **Large touch targets.** Controls are finger-sized: the document-wide `--control-height` is 48px in kiosk and 36px in comfortable mode.
  Every shared control variant consumes that token; intentionally larger layouts require review.
- **Distance-legible.** Readable from kitchen viewing distance — density-driven control type (18px kiosk, 14px comfortable) and high enough contrast.
  A separate display font and heading scale are not currently implemented.
- **Per-member colour coding.** Members carry a stored colour used across avatars/badges; the palette
  must provide a named per-member colour set (v1: 16 named OKLCH hues). Relevant once members render.
- **Fail-closed surfaces.** The shell renders nothing household-runtime until provisioned+connected
  (`KIOSK-SHELL-NAVIGATION-INV-01`); provisioning/access-gate come before the shell.

## What NOT to do (yet)

- **Shared compositions need a contract.** Admit state, wiring or accessibility responsibility
  under the style guide's D3 test; a consumer count alone does not justify a wrapper. Plain class
  combinations belong in recipes. Reuse `@/ui` and consult `COMPONENTS.md` first.
- **No parallel token source.** Token values live in `:root`/`.dark` and are exposed via `@theme
inline`; that is the single source. No component-local colour
  constants, no second CSS file of variables.
- **No private class-string constant.** A class combination that isn't a component (research D3 —
  no state, wiring, or accessibility of its own) is a **recipe**: export it from
  `src/client/lib/recipes.ts` and document it in [`style-guide.md`](style-guide.md), don't declare
  it locally in a surface file (#762).

---
