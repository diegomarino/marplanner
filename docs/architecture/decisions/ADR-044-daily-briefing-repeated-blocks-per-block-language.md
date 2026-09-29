# ADR-044 Daily Briefing Repeated Blocks and Per-Block Language

Status: accepted
Owner: product + architecture
Decision date: 2026-06-29

## Decision

The Daily Briefing block model becomes an **ordered list of block instances** rather
than one block per type:

- A block **type may repeat** (e.g. two "word of the day" blocks, two quotes). Order
  and repetition are owned by Daily Briefing (extends ADR-008).
- A block renders two kinds of text, handled differently:
  - **Structural copy** (labels/templates — category-1 product copy, ADR-015) →
    **always the household language** via translation keys (parity-gated; present).
  - **Corpus content** (category-3 curated multi-language content — quote/word of the
    day) → only some blocks have it.
- **The per-block `language` override exists ONLY for corpus-backed blocks** (the block
  catalogue declares a block as corpus-backed with language variants). For such a block
  the selector **only offers languages for which a corpus exists**; the override selects
  which corpus variant to use (default household).
- **Blocks without a corpus have no language override** and render in the household
  language. There is **no English degradation for "no corpus"** — the generic English
  fallback (ADR-015) applies only to a genuinely missing translation _key_ (a build
  bug), never to corpus absence.
- The chosen corpus content is **generated at generation time** and frozen in the
  immutable snapshot (ADR-022); a later household-language change does not retouch
  already-generated per-block content.

## Rationale

Language for some blocks is not a global presentation preference but **intentional
content**: a "word of the day" in English inside an otherwise-Spanish briefing is a
bilingual-household / language-teaching use case. That intent is only expressible if
language is an attribute **per block instance**, not only per household. Once a block
can repeat with distinct config, the briefing is a _composition_, not a fixed set —
the same "attribute rises from implicit-global to explicit-per-element" pattern as
ADR-010 (Day Periods).

## Affected Specs

- `../../11-daily-briefing.md`, `../../17-i18n-localization.md`

## Data / Setup Implications

Daily Briefing's block configuration stores an ordered list of block instances (type

- per-instance config incl. optional `language`). The generated payload's blocks are
  emitted in their instance language. No legacy import (ADR-026). Extends the Daily
  Briefing contract (status `review`).

## Acceptance Criteria

- Given two instances of the same block type with different `language`, when a
  briefing generates, then each renders in its own language.
- Given a block instance with no `language`, when it generates, then it uses the
  household language.
- Given a household-language change after generation, the per-block languages of the
  existing snapshot are unchanged (ADR-022).
- Given block ordering/repetition, Daily Briefing owns it (ADR-008), never an App
  Setting.
- Given a block with no corpus (e.g. "days until birthday"), when configured, then **no
  language selector is offered** and it renders in the household language; it never
  degrades to English for lack of a corpus.
- Given a corpus-backed block, when the language selector is shown, then it offers
  **only languages for which a corpus exists** (so a "language set but no corpus" state
  is unreachable).
- Given a corpus-backed block with a chosen language, when generated, then that corpus
  variant is frozen in the snapshot (ADR-022); a later household-language change does
  not retouch it.

## Open Questions

- Block catalogue + which block types support a language override meaningfully —
  refine when the block catalogue is specced. Per block type, **encode which content
  category (ADR-015: product/user/external) it carries** and whether `language` affects
  its content or only its structural copy (peer-review Q5: the authorship rule still
  wins — `language` never translates user-authored content).

## Traceability

- Pre-v2: extends `ADR-008`; driven by `ADR-015`
- Domain grill: `../domain-grills/i18n-localization.md` (Q4)
- Related: `ADR-022`, `ADR-027`, `ADR-028`
