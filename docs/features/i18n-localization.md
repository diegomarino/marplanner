# Feature: i18n / Localization (the household-language runtime)

Behavior reference. The [owning contract](../architecture/contracts/i18n-localization.md) defines invariants and extension limits.

i18n / Localization is a cross-cutting **runtime contract** for displaying the kiosk, admin screens,
generated copy, and formatted dates/times in the household language, degrading predictably when
localization is incomplete. It owns **no table** — App Settings owns the `language` value and its
write-validation; i18n resolves and normalizes locales on read, formats via `Intl`, and enforces
resource parity at build/CI. Its one hard guarantee is the build/CI parity gate; the runtime
missing-key signal is best-effort observability, not a correctness guarantee.

## Behavior

### User Story 1 — The household switches language

An admin sets `language` to `es`; on settings load the active language switches without reload, all
keyed product copy renders in Spanish, dates/times format via `Intl` with the full locale + household
tz, and already-generated briefings are not retranslated (frozen at generation time).

### User Story 2 — A missing translation key degrades safely

A build introduces a key with no `es` translation. In production the family sees the English base
(never the raw key) and a best-effort missing-key signal goes to Client Logging; in CI the parity gate
fails the build outright — the gate, not the runtime signal, is the guarantee.

### User Story 3 — A plugin ships its own translations

A plugin declares a namespaced key domain in its manifest; its keys resolve under the plugin-ID
namespace (no core/peer override), participate in the parity gate, and are dropped on uninstall.

### Edge Cases

- A persisted `language` outside the supported set is resolved to a supported locale on read.
- `en-GB` resolves strings `en-GB → en` but formats via the `Intl` full code, with no `en` bundle copy.
- A briefing block with no corpus uses the household language — corpus absence is not English degradation.
- A dynamic key `t(prefix+var)` whose prefix is unregistered is a build/lint error.
- User-authored content is shown exactly as authored, never machine-translated.

## Requirements

### Behavior requirements

- **FR-001**: Given the localization runtime, when a language is in play, then `en` MUST be the base/default (reference and fallback) with `es` as a translation layer, and the supported `language` MUST be a validated enum at the App Settings boundary with free strings rejected. _(Realizes: I18N-LOCALIZATION-INV-01)_

- **FR-002**: Given the language setting, when it is applied, then it MUST be household-wide only, and there MUST be no per-device or per-member language. _(Realizes: I18N-LOCALIZATION-INV-02)_

- **FR-003**: Given the effective language, when it is resolved, then it MUST equal the household setting (readable cold via the API-key surface, ADR-031), browser detection MUST be a last resort only, and the household setting MUST win once loaded. _(Realizes: I18N-LOCALIZATION-INV-03)_

- **FR-004**: Given a missing translation key (a build bug, not corpus absence), when it is encountered, then family-facing UI MUST render the English base (never the raw key) and SHOULD emit a best-effort missing-key signal to Client Logging (observability, not a correctness guarantee — its delivery is not guaranteed), while dev/CI MUST surface the raw key with a failing parity test; structural copy and a block with no corpus MUST use the household language with no English degradation for corpus absence. _(Realizes: I18N-LOCALIZATION-INV-04)_

- **FR-005**: Given resource parity, when the build/CI runs, then every supported language MUST have every key across core and each plugin namespace (a missing key MUST fail the build), dynamic keys MUST go through the typed `dynamicKeyRegistry` consumed by both call site and parity checker (an unregistered prefix MUST be a build/lint error), and plugins using dynamic i18n MUST declare their key domains in the manifest (absence MUST fail the build) — the build gate plus registry is the only hard guarantee. _(Realizes: I18N-LOCALIZATION-INV-05)_

- **FR-006**: Given content, when it is rendered, then product copy MUST be keyed, user-authored content MUST be shown as authored and MUST never be translated, and external content MUST use its source language. _(Realizes: I18N-LOCALIZATION-INV-06)_

- **FR-007**: Given plugin translations, when they are registered, then they MUST be namespaced by plugin-ID, MUST follow Rule B (no core or peer override), and MUST be dropped on uninstall (build-merged for MVP). _(Realizes: I18N-LOCALIZATION-INV-07)_

- **FR-008**: Given a locale, when strings resolve and values format, then string resolution MUST follow the BCP-47 chain `region → language → base` while `Intl` formatting MUST use the full locale code, and the full locale code MUST be stored and threaded with no 2-letter assumptions. _(Realizes: I18N-LOCALIZATION-INV-08)_

- **FR-009**: Given dates and times, when they are displayed, then they MUST use the household tz and the active locale, and weekday labels MUST localize the canonical `mon..sun` order. _(Realizes: I18N-LOCALIZATION-INV-09)_

- **FR-010**: Given generated copy, when it is produced, then it MUST be produced in the household language (or per-block language) at generation time and frozen in the snapshot. _(Realizes: I18N-LOCALIZATION-INV-10)_

- **FR-011**: Given speech (Time Announcements), when an utterance is spoken, then its `lang` MUST always be the household locale, using a matching voice when available and otherwise the browser-default voice with the correct `lang` still set and the miss logged. _(Realizes: I18N-LOCALIZATION-INV-11)_

- **FR-012**: Given text output, when it is emitted, then developer-facing text (logs, technical errors, diagnostics) MUST always be English, and family-facing text MUST be localized, including friendly kiosk error banners. _(Realizes: I18N-LOCALIZATION-INV-12)_

- **FR-013**: Given a persisted `language` outside the supported set, when it is read, then it MUST be resolved to a supported locale on read, while rejecting an unsupported `language` write MUST remain App Settings' boundary validation, not owned here. _(Realizes: I18N-LOCALIZATION-AC-01)_

- **FR-014**: Given a missing key, when production renders, then it MUST show English (never the raw key) and SHOULD emit a best-effort logged signal (delivery not guaranteed), and CI MUST fail on any missing key in core or a plugin namespace (the acceptance surface for FR-004/FR-005). _(Realizes: I18N-LOCALIZATION-AC-02)_

- **FR-015**: Given user-authored strings, when they are displayed, then they MUST never be machine-translated (the acceptance surface for the authorship rule in FR-006/INV-06). _(Realizes: I18N-LOCALIZATION-AC-03)_

- **FR-016**: Given plugin keys, when a plugin is installed and later uninstalled, then they MUST be namespaced and MUST be removed on uninstall (the acceptance surface for FR-007/INV-07). _(Realizes: I18N-LOCALIZATION-AC-04)_

- **FR-017**: Given a region locale such as `en-GB`, when strings resolve and values format, then strings MUST resolve `en-GB → en` and formatting MUST use the `Intl` full code, with no `en` bundle duplication (the acceptance surface for FR-008/INV-08). _(Realizes: I18N-LOCALIZATION-AC-05)_

- **FR-018**: Given speech, logs, and kiosk banners, when they are emitted, then speech MUST match the household language, logs and technical errors MUST be English, and kiosk banners MUST be localized (the acceptance surface for FR-011/FR-012). _(Realizes: I18N-LOCALIZATION-AC-06)_

### Key Entities

- **Translation key**: a stable product-meaning identifier resolved per active locale through the
  BCP-47 chain; partitioned into namespaces (`core` + one per plugin-ID).
- **dynamicKeyRegistry**: the typed registry of dynamic-key prefixes (`t(prefix+var)`), consumed by
  both the call site and the parity checker; an unregistered prefix is a build/lint error.
- **Resource bundle**: the per-language, per-namespace set of keys; the build/CI parity gate requires
  every supported language to carry every key. Base `en` is the reference shape and fallback.
- **Locale (translation vs formatting)**: two orthogonal axes — string resolution via the BCP-47 chain,
  `Intl` formatting via the full locale code threaded everywhere (no 2-letter assumptions).

## Success Criteria

- **SC-001**: CI fails 100% of builds with any missing key in any supported language × namespace, and
  100% of unregistered dynamic-key prefixes are build/lint errors.
- **SC-002**: In production, 0 raw translation keys reach family-facing UI; every missing key renders
  English and emits a best-effort signal.
- **SC-003**: 0 user-authored strings are machine-translated, and switching `language` retranslates 0
  already-generated snapshots.

## Assumptions

- App Settings owns the `language` value and its write-validation (ADR-028); this spec consumes the
  effective setting and resolves/normalizes on read (AC-01 reframe). i18n owns no table.
- Household tz/date/weekday primitives are provided per ADR-005/ADR-020; snapshot freezing per ADR-022;
  per-block language per ADR-044.
- The missing-key signal is delivered as a telemetry write consumed by Client Logging (not a bus
  event); the build/CI parity gate is the sole hard guarantee.
- Fresh v2 store; no legacy translation state imported (ADR-026); `es` is set at onboarding if desired.
- **A members-local i18n seam exists ahead of this domain (ADR-061).** Slice-002 shipped a minimal
  client-only seam — a typed `en`/`es` catalog + a `t()` resolver + a local parity test, scoped
  post-auth to the admin Members subtree — to satisfy Constitution X before this domain was built.
  When this domain lands it MUST **absorb/replace** that seam: fold `src/client/i18n/messages.ts` into
  the shared typed catalog + `dynamicKeyRegistry`, replace the local `LanguageProvider`/`resolveLang`
  with this domain's runtime (AC-01 read-normalization / FR-013), and retire
  `tests/client/member-i18n-parity.test.ts` in favor of the canonical build/CI parity gate (FR-005).
  The seam realizes none of this domain's guarantees; it is scaffolding to reconcile, not prior art to
  preserve.
