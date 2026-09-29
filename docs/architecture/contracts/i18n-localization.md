# i18n / Localization Domain Contract

Status: maintained contract
Depends on decisions: `ADR-015`, `ADR-005`, `ADR-010`, `ADR-020`, `ADR-022`, `ADR-027`, `ADR-028`, `ADR-029`, `ADR-031`, `ADR-039`, `ADR-044`

## Purpose

A cross-cutting **runtime contract** for displaying the kiosk, admin screens,
generated copy, and formatted dates/times in the household language — degrading
predictably when localization is incomplete. **No owned table** (App Settings owns
`language`).

## Vocabulary

- **Base language** — `en`: resource-shape reference + key-fallback (ADR-015).
- **Household language** — the effective `language` setting (household-wide).
- **Translation key** — stable product-meaning identifier; resolved per active locale.
- **Namespace** — key partition: `core` plus one per plugin ID (ADR-039).
- **Translation locale vs formatting locale** — orthogonal axes (strings vs `Intl`).

## Invariants

1. **I18N-LOCALIZATION-INV-01** **Base/default = `en`** (= reference = fallback); `es` is a translation layer.
   Supported `language` is a validated enum at the settings boundary (ADR-028); free
   strings rejected.
2. **I18N-LOCALIZATION-INV-02** **Household-wide only** — no per-device/per-member language (ADR-013).
3. **I18N-LOCALIZATION-INV-03** **Effective language = household setting**, readable cold via the API-key surface
   (ADR-031); browser detection is last resort; household always wins once loaded.
4. **I18N-LOCALIZATION-INV-04** **Missing key** (a missing translation _key_ = build bug, NOT content/corpus
   absence): family-facing → English (never raw key) + a **missing-key signal to Client
   Logging** (**best-effort observability, NOT a correctness guarantee**); dev/CI → raw
   key + failing parity test. Structural copy always uses the household language; a
   block with no corpus uses the household language (ADR-044) — no English degradation
   for corpus absence.
5. **I18N-LOCALIZATION-INV-05** **Resource parity is a build/CI gate** — every supported language has every key,
   core and per plugin namespace; a missing key is a build failure. **Dynamic keys
   (`t(prefix+var)`) go through a typed `dynamicKeyRegistry`** consumed by both the
   call site and the parity checker; an unregistered prefix is a **build/lint error**,
   and plugins using dynamic i18n **declare their key domains in the manifest** (absence
   = build failure). The build gate (+ registry) is the only hard guarantee.
6. **I18N-LOCALIZATION-INV-06** **Translatable-vs-content by authorship:** product copy → keys; user content →
   as-authored (never translated); external content → source language (locale corpora
   deferred).
7. **I18N-LOCALIZATION-INV-07** **Plugin translations are namespaced** (plugin-ID), Rule B (no core/peer override),
   dropped on uninstall (ADR-039); build-merged for MVP.
8. **I18N-LOCALIZATION-INV-08** **BCP-47 with resolution chain** `region → language → base` for strings; **`Intl`
   uses the full locale code** for formatting. Full locale code stored/threaded; no
   2-letter assumptions.
9. **I18N-LOCALIZATION-INV-09** **Dates/times use household tz** (ADR-005) and the active locale; weekday labels
   localize the canonical `mon..sun` order (ADR-020).
10. **I18N-LOCALIZATION-INV-10** **Generated copy** is produced in the household language (or per-block language,
    ADR-044) **at generation time** and frozen in the snapshot (ADR-022).
11. **I18N-LOCALIZATION-INV-11** **Speech (Time Announcements) follows the household language** (ADR-015): utterance
    `lang` is **always** the household locale; matching voice when available, else
    browser-default voice with the correct `lang` still set + logged miss.
12. **I18N-LOCALIZATION-INV-12** **Developer-facing text is English ALWAYS** (logs, technical errors, diagnostics —
    a DX rule, see [developer verification policy](../../quality/verification.md)); **family-facing text is localized**,
    including friendly kiosk error banners.

## Behaviors

- **Initialize/resolve:** load bundled resources; resolve a key in the active locale
  via the BCP-47 chain, else base English, else (dev) raise/mark.
- **Apply household language:** on settings load/change, switch active language without
  reload; existing generated output is not retranslated (ADR-022).
- **Format** dates/weekdays/times/numbers via `Intl` with the full locale + household
  tz for business time.
- **Parity check** at build/CI across all locales and namespaces.

## Interfaces

- Inbound: translation function (key → localized string), locale-aware formatters.
  Language _write_ is an App Settings operation (ADR-028), not owned here.

## Events

(ADR-040.) Emits a **missing-key signal** consumed by Client Logging (telemetry, not a
domain state event). Subscribes to none. Reacts to App Settings `language` changes via
the settings mechanism, not the bus.

## Data / Setup Contract

No owned table. `language` seeded `en`, validated to supported locales. Translation
resources are source artifacts (core + per-plugin namespaces). No legacy import
(ADR-026); unsupported persisted language reported/normalized per explicit decision.

## Acceptance Criteria

- **I18N-LOCALIZATION-AC-01** A persisted `language` outside the supported set is resolved to a supported locale on read; rejecting an unsupported `language` _write_ is App Settings' boundary validation (ADR-028), not owned here.
- **I18N-LOCALIZATION-AC-02** Missing key → English in prod (never raw key) + logged signal; CI fails on any
  missing key (core or plugin namespace).
- **I18N-LOCALIZATION-AC-03** User-authored strings never machine-translated.
- **I18N-LOCALIZATION-AC-04** Plugin keys namespaced; removed on uninstall.
- **I18N-LOCALIZATION-AC-05** Hypothetical `en-GB` resolves strings `en-GB → en` and formats via `Intl` full code,
  no `en` bundle duplication.
- **I18N-LOCALIZATION-AC-06** Speech matches household language; logs/technical errors English; kiosk banners
  localized.

## Open Decisions

- Locale-specific replacement corpora for external content (intersects ADR-044) —
  deferred content decision.
- Per-feature Storybook/test language-switch coverage scope — DX/testing call.

## Peer Review

codex-peer-review blind-debate (2026-06-29). No critical. 3 Important + 2 Minor, all
incorporated: dynamic-key enumeration made an enforced build gate via typed
`dynamicKeyRegistry` (core + plugin-manifest-declared); speech utterance `lang` always
set to household locale (resolves the voice-availability contradiction); missing-key
signal documented as best-effort observability (build gate is the guarantee); per-block
English-fallback-freeze documented as expected (ADR-044); base-language change is no
hazard (fresh store, ADR-026) with a setup note to set `es` at onboarding.
