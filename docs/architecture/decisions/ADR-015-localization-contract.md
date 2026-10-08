# ADR-015 Localization Contract (language model, fallback, scope, boundary)

Status: accepted
Owner: architecture + product
Decision date: 2026-06-29

## Decision

i18n is a **cross-cutting runtime contract**, not an owned data domain (no server
table). The model:

**Language model.**

- **Reference and fallback language = `en`**; `es` is the translation layer. The accepted initial household default is also `en`, but essential runtime defaults currently select `es` while the optional public seed selects `en`. Initial-default alignment or an explicit policy change remains required; existing household preferences must be preserved.
- Effective language = the household `language` setting (App Settings); it wins at
  cold boot and is readable on the API-key surface cold (ADR-031). Browser detection
  is a last resort only when settings are unreachable.
- **Strict validation** at the settings boundary (ADR-028): `language ∈ supported
locales`, enum not free string; unsupported is rejected.
- **Scope: household-wide only.** No per-device/per-member overrides (per-user
  language is incoherent with shared, session-less kiosk surfaces; ADR-013).

**Missing-key behavior (opposite by audience).** This concerns a missing translation
**key** (a build bug). It does **not** govern content/corpus absence: structural copy
always renders in the household language, and a block with no corpus simply uses the
household language (ADR-044) — there is no English degradation for "no corpus".

- **Prod (family-facing):** fall back to **English (legible)**, never the raw key;
  emit a **missing-key signal to Client Logging** so the operator learns via
  observability, not via a degraded screen. **This signal is best-effort observability,
  NOT a correctness guarantee** (peer-review Q2) — the build parity gate (+ dynamic-key
  registry) is the only hard guarantee.
- **Dev/CI:** raw key / noisy marker + **failing parity test**.
- Rule: noisy for whoever can fix it, silent for whoever can't.

**Resource parity (free correctness win → invariant).** A build/CI check verifies
every supported language has every key — core **and** per-plugin namespace. A missing
key is a **build failure, not a runtime state**. Static keys are fully covered.

**Dynamic keys are an enforced build gate, not a convention (peer-review Q3/Q6).**
Dynamic keys (`t(prefix + variable)`, e.g. weather condition codes) escape static
parity. To make "enumerate known dynamic sets" a real gate: a typed
**`dynamicKeyRegistry`** maps each dynamic prefix to its exhaustive value set; **both
the `t()` call site and the parity checker consume it**, and a `t()` call whose prefix
is **not** in the registry is a **build/lint error**. Plugins that use dynamic i18n
must **declare their finite key domains in the manifest** (absence = build failure).
The runtime missing-key signal is a secondary net, not the guarantee.

**Translatable-vs-content boundary (by authorship).**

1. **System copy (product) → translation keys** (translated): nav, status, briefing
   structural labels, day-period labels (ADR-010), weather condition names, weekday
   names.
2. **User-authored content → shown as authored, NEVER translated:** member names,
   meal/recipe text, daily messages, reminder text, local event titles/descriptions,
   device aliases. It's data, not copy.
3. **External source-language content → shown in source language;** locale-specific
   replacement corpora is a deferred _content_ decision (runtime MT out of scope).

**Plugin translations (ADR-039-aligned).** Plugins ship per-language resources merged
under the **plugin-ID namespace** (no flat-merge into core). Rule B for keys: no
override of core/other-plugin keys. Clean uninstall drops the namespace (no orphan
keys). Parity runs per namespace. Build-time merge for MVP (first-party bundled);
namespacing keeps dynamic loading ready (declare-now, enforce-later).

**Locale precision (BCP-47), two orthogonal axes.**

- **Translation strings:** BCP-47 codes with a resolution chain `region → language →
base` (`en-GB` → `en` → base); adding a region later defines only divergent keys.
- **Formatting (`Intl`):** uses the **full locale code** (e.g. `en-GB` → `DD/MM/YYYY`)
  independent of the string bundle. Language (which words) and formatting locale (how
  dates/numbers render) are orthogonal.
- MVP ships `en`/`es` base languages but stores/threads the full locale code (no
  hardcoded 2-letter assumptions) and routes formatting through `Intl`. Regional
  variants deferred; seam stays cheap.

**Generated output + speech.**

- Generated briefing copy is produced in the **household language at generation time**
  and frozen in the snapshot (ADR-022; no retranslation on later language change).
  Per-block language override is ADR-044.
- **Speech (Time Announcements) follows the household language** (not a separate
  setting). **The utterance `lang` is ALWAYS set to the household locale** regardless of
  voice availability (peer-review Q7); a matching voice is used when present, else the
  browser-default voice is used **with the correct `lang` still set** and the voice-miss
  is logged. (Resolves the contradiction between "follows household language" and a
  device lacking that voice — the `lang` is always correct even if pronunciation
  degrades.) Replaces v1 hardcoded `es-ES`.

**Developer-facing vs family-facing (boundary = who reads it).**

- **Developer/operator-facing → English ALWAYS:** logs, technical error messages,
  diagnostics, raw status. This is a **Developer Experience rule** (see
  [developer verification policy](../../quality/verification.md)), not localized.
- **Family-facing → localized:** all UI the family sees in normal use, **including
  friendly error banners/states on the kiosk**.

## Rationale

Classifying every string by its **consumer** (family / operator / build) and by its
**author** (product / user / third party) resolves the v1 chaos (es/en conflict,
free-string language, raw keys, mixed-language admin drift, name "translation"
hazards). Choosing `en` as base fuses default and reference, removing a conflict
rather than managing it. Namespacing (plugins) and resolution chains (locales) turn
the translation set into a dimensioned structure so extension is additive.

## Affected Specs

- `../../17-i18n-localization.md`, `../../03-app-settings-registry.md`,
  `../../11-daily-briefing.md`, `../../09-time-announcements.md`, `../../14-weather.md`,
  `../../02-day-periods.md`

## Data / Setup Implications

No owned table. `language` seeded `en`; validated to supported locales. Translation
resources are source artifacts. No legacy import (ADR-026) — v2 is a fresh store, so
there is **no in-place `es`→`en` flip** for existing households (there are none at the
v2 data level). **Setup note (peer-review Q1):** onboarding seeds `language=en`;
Spanish-speaking households set `language=es` during initial configuration. Unsupported
persisted language values are reported/normalized per explicit decision, not silently
mapped.

## Acceptance Criteria

- An unsupported `language` write is rejected at the settings boundary.
- A missing key shows English in prod (never raw key) and emits a missing-key signal;
  CI fails on any missing key (core or plugin namespace).
- A user-authored string is never machine-translated.
- A plugin's keys live under its namespace and are removed on uninstall.
- `en-GB` (hypothetical) resolves strings via `en-GB → en` and formats via `Intl`
  with the full code, without duplicating the `en` bundle.
- Speech utterance `lang` is the household locale; a matching voice is used when
  available, else the browser-default voice with the correct `lang` set and the miss
  logged.
- A `t(prefix+var)` call whose prefix is not in the dynamic-key registry fails the
  build; a plugin using dynamic i18n without declaring its key domains fails the build.
- A log/technical error message is in English regardless of household language; a
  kiosk error banner is localized.

## Open Questions

- Locale-specific replacement corpora for category-3 content — deferred content
  decision (intersects ADR-044 per-block language).

## Traceability

- Related prior: `ADR-015`
- Related: `ADR-005`, `ADR-010`, `ADR-020`, `ADR-022`, `ADR-027`, `ADR-028`,
  `ADR-029`, `ADR-031`, `ADR-039`, `ADR-044`
