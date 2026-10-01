# UI component contract

This contract defines the shared token, primitive, density and accessibility promises consumed by client surfaces. It contains no HTTP endpoint. Each consuming household screen must verify these promises through its rendered behavior.

## 1 · The density guarantee

> **Any interactive control rendered anywhere in the document inherits the active density, without
> opting in.**

| Guarantee       | Detail                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Reach           | the whole document, including subtrees mounted outside the page (dialogs, overlays, shell-mounted services) |
| Opt-in required | **none** — a surface that does nothing still complies                                                       |
| Height          | every interactive control meets the active density's minimum                                                |
| Text            | control text scales with the density; a large control never renders small text                              |
| Selection       | per device; one device's choice never affects another                                                       |

**What a consumer may rely on**: rendering a primitive is sufficient. No surface needs to know the
density exists.

**What a consumer must not do**: fix a control's height or text size independently. That silently
opts out of the guarantee. Shared Button, Input, Textarea, Select controls and the built-in Dialog close consume the density tokens.

---

## 2 · The token contract

> **Product code names a token; it never restates a value.**

| Group                | Guarantee to consumers                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Semantic colour      | a role (surface, foreground, muted, destructive…) whose value may change without any consumer edit |
| Density              | control height and control text, as above                                                          |
| Spacing / typography | a scale, not arbitrary values                                                                      |

**The consumer-visible promise**: replacing the values at the single definition site changes every
surface, with no other edit. That promise is what makes a theme a decision rather than a project —
and it is what SC-013 demonstrates.

**Member identity**: slice 021 supplies closed member keys and generated colour tokens. Dynamic CSS custom-property forwarding is permitted with an exact, justified `ui-policy/debt` directive; literal colours are not.

---

## 3 · The component contract

Each component's promise to its call sites — this is what "carries load" means concretely, and it is
what a call site is allowed to stop implementing:

| Component              | What the call site may stop doing                                    |
| ---------------------- | -------------------------------------------------------------------- |
| Admin panel frame      | laying out a panel's header/body/actions consistently                |
| Field                  | associating label, hint and error with the input                     |
| Error notice           | announcing errors to assistive technology                            |
| Confirmation dialog    | focus trapping, portalling, and the escape/confirm keyboard contract |
| Weekday picker         | five separate implementations of the same selection                  |
| Checkbox / radio field | label association and grouping semantics                             |
| Status toggle          | the pressed-state contract                                           |

**The confirmation dialog carries a scope rule, not just an interface**: it guards the destructive
direction of a chore toggle only. Completing is one tap; undoing asks. A call site that wraps the
constructive direction violates the contract even though the component would work.

**Admission**: a proposed addition must satisfy state, wiring, or accessibility (see the data model).
Satisfying none makes it a recipe — documented in the style guide
(`docs/development/style-guide.md`), not shipped in `components/`.

---

## 4 · The enforcement contract

> **Once a file is migrated, the build rejects hardcoded colour literals, inline style attributes,
> and raw scale classes in it.**

| Guarantee      | Detail                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Scope          | files not on the exception list                                                                                 |
| Exception list | strictly shrinking; empty at close                                                                              |
| Counting       | by committed command over `src/client/**/*.{ts,tsx}` (see research D1)                                          |
| Durability     | survives a configuration reload; shared AST oracle; syntax-rule arrays retain logging and live-region selectors |

**What a consumer may rely on**: a migrated surface cannot silently drift back. The ratchet catches
the _edit_, not merely the original migration.

---

## 5 · What this contract deliberately does NOT promise

Recorded so no consumer builds on an assumption the component foundation never made:

- **No visual identity.** The theme values stay provisional. _(Post-choice, 2026-09-10: the maintainer chose variant A from the screenshotted candidates and directed it be applied — the CHOSEN variant lands as its own reviewed PR, per FR-020 as amended; the three candidate branches themselves were indeed never merged.)_ The slice promises changeability, not a
  particular appearance.
- **No dark appearance.** Dark tokens exist for tooling compatibility; the product is light-only.
- **No navigation, no home composition, no member colour.** Those are 021 (issues #737, #738, #739).
  A batch that adds them has left the component foundation's scope.
- **No behaviour change.** Same requests, same optimistic-update discipline, same copy — a migration
  that alters behaviour is a defect, not a bonus.

## Shared UI enforcement

Import from `@/ui`; [COMPONENTS.md](../../COMPONENTS.md) inventories the actual exported API and links to its prop contracts. Its generator/drift check uses the installed TypeScript parser; no documentation dependency is required.

- G1 rejects new raw buttons, text inputs and textareas. Native selects retain the shared recipe and native platform interaction. Native checkbox/radio wrappers and the bare labelled matrix recipe are supported. Exact per-line exceptions cover meal-grid surfaces, calendar event chips and nested filter checkboxes; there is no file-wide migration list.
- G2 keeps scoped or unified Radix imports/re-exports/dynamic imports inside the primitive layer. G5 permits primitive imports only from sibling primitives, `lib/utils` and `lib/recipes`, resolving relative paths and `@/` aliases.
- G3 protects imported controls' literal height, maximum height, square size, minimum height and font classes, including arbitrary properties, conditional/cn expressions and responsive variants, important utilities and self selectors. Descendant icons remain independent. Width and minimum growth of at least 48px remain layout choices. The 64px/24px PIN keypad has explicit per-line exceptions. Runtime-built or forwarded class strings still require review.
- G6 discovers the primitive directory in the foundation test census. Interactive primitives have rendered density checks, including open portal controls; Card and Label are documented noninteractive exemptions.

The debt command counts AST violation nodes, including justified inline styles; lint suppression grants permission rather than erasing measurement. Token-only colour mixes and CSS member-token names are allowed, and named colours are case-insensitive. Translation values under the `messages` declaration in `src/client/i18n/messages.ts` are copy, not colours; arbitrary code in that file remains governed. Explicit style-bearing props objects (including spreads, hoists and createElement) are counted. Dynamic unknown spreads and arbitrary runtime colour/class construction are not exhaustively evaluated. Existing SC-011 announcement limitations remain separate from debt enforcement.
