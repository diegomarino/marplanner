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
opts out of the guarantee, and is the specific escape three primitives make today.

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

**Not in this contract**: member-identity colour. It belongs to audit row 4 and therefore to slice 021. A surface must not anticipate it.

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

| Guarantee      | Detail                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| Scope          | files not on the exception list                                                 |
| Exception list | strictly shrinking; empty at close                                              |
| Counting       | by committed command over `src/client/**/*.{ts,tsx}` (see research D1)          |
| Durability     | survives a configuration reload; the two-block shape is required, not stylistic |

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
