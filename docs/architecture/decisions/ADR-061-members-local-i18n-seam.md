# ADR-061 Shared Client Localization Runtime

Status: accepted
Owner: architecture
Decision date: 2026-07-27

## Context

All family-facing UI must honor the household language and translation parity
required by Constitution Principle X. One shared runtime must serve core screens
and plugins so individual features do not invent incompatible translation seams.

## Decision

- Use the shared typed English/Spanish catalog in `src/client/i18n/messages.ts`.
  `MessageKey` constrains structural copy; English is the reference and fallback.
- Mount `LanguageProvider` at shell level and consume the household settings
  context. Standalone renders may fetch authenticated settings when that context
  is absent. Unresolved/unsupported language falls back to English.
- `useT()`/`t(key)` renders household-language copy, falls back to English for a
  missing key and emits a deduplicated best-effort diagnostic. User-authored
  content and operator diagnostics follow ADR-015's separate language policies.
- Keep one runtime as feature coverage grows. Core and plugin screens reuse it;
  localization is not restricted to member administration.
- `tests/client/member-i18n-parity.test.ts` compares the entire shared catalog in
  both directions. Its filename does not limit its coverage to Members.

## Consequences

The shared runtime realizes catalog parity and household-language rendering, but
does not yet implement ADR-015's dynamic-key registry/plugin declarations or the
specified region-to-language resolution. Those remain implementation requirements;
retain existing catalog parity tests when adding them. The resolver currently
accepts exact en/es only. Essential Spanish defaults also remain misaligned with
ADR-015's accepted English initial default; no policy change is implied here.

## Acceptance Criteria

- Core and plugin UI share a typed catalog and language provider.
- Loaded household settings take precedence over browser language detection.
- Missing translated keys use English rather than exposing raw keys to the family.
- Missing English/Spanish catalog keys fail parity checks.
- Operator/server diagnostics remain English.
- Dynamic-key declarations and locale-resolution behavior require their own
  boundary tests before the full localization contract is declared complete.

## Related Decisions

ADR-015 (language policy), ADR-028 (validated household settings), ADR-039 (plugin
namespaces), ADR-059 (provisioning and authenticated shell).
