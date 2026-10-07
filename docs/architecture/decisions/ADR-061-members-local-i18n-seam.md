# ADR-061 Members-local i18n seam (ahead of the i18n-localization domain)

Status: accepted
Owner: architecture
Decision date: 2026-07-27
Peer-reviewed: yes (codex + claude blind round, 2026-07-27 — 7 findings folded: authority reframed to
Principle X, post-auth/members-only scope made explicit, supported-locale normalization guard added,
parity test relocated to `tests/client/`, given a runnable command, the plan's Constitution-Check
self-cert corrected, and the divergent-seam residual risk named).

## Context

Slice `002-members-referential-root` ships admin-facing UI (member create/edit, archive/restore, an
archived tab, birth-date fields). Constitution **Principle X** (NON-NEGOTIABLE) requires family-facing
UI text to be localized and mandates a build-time translation-parity gate that MUST fail on a missing
key. Principle X is **repo-wide and in force today** — it is not scoped to the existence of any domain.

But the codebase has **no i18n runtime**: client strings are hardcoded English literals
(`<CardTitle>Create Member</CardTitle>`, `Parent`, `Child`, `placeholder="Member name"`). A persisted
`locale` setting carries `language` (server default `es`), yet **nothing consumes it** for rendering —
so an `es` household already sees an English kiosk. The canonical i18n runtime and the parity gate are
guarantees **owned by the `i18n-localization` domain** (`I18N-LOCALIZATION-INV-04/05`, `AC-04/05`,
`active` in `boundary-ledger.yaml`), a much later slice not yet built.

This surfaced mechanically: `tools/check-issues.mjs` rejected work item 2's task ("the i18n parity
gate must pass") because its DoD named a gate that does not exist — no runnable per-task criterion.

## Decision

Introduce a **minimal, client-only, members-domain-local i18n seam** that satisfies Principle X for
this slice's UI **now**, shaped so the `i18n-localization` domain **absorbs** (not discards) it later.

1. **Typed catalog** — `src/client/i18n/messages.ts`: two maps (`en`, `es`) keyed by dotted ids
   (`members.create.title`, `members.role.parent`, `members.archive.action`, …) with a `MessageKey`
   union type so **a missing key is a compile error**. This deliberately mirrors INV-05's typed-catalog
   shape at small scale.
2. **Seam + resolver** — `src/client/i18n/index.tsx`: a `LanguageProvider` that resolves the active
   language **once** via `authFetch('/api/settings')` → `locale.language`, normalized through a
   `resolveLang(raw): 'en' | 'es'` guard (any unsupported/garbage value → `en`); a `useT()`/`t(key)`
   that indexes `catalog[lang][key]` with a **fallback to the `en` base** on a missing key (honors the
   domain's FR-004: never render the raw key). `en` is the base/reference locale and the universal
   safety net for both an unresolved language and a missing key.
3. **Retrofit + new strings** — the existing members-domain literals (`MemberCreateForm.tsx`, the admin
   `MembersManagement.tsx`) **and** work item 2's new strings all route through `t()`, so the Members
   screen is coherently localized rather than half-and-half.
4. **Local parity test** — `tests/client/member-i18n-parity.test.ts` (Vitest, run by `test:unit`)
   asserts `keys(en) === keys(es)` both directions, so a missing translation fails CI now. It is an
   explicitly **local, slice-scoped stand-in** for the canonical parity gate; it does not claim to be
   INV-05.

### Authority

The seam's authority is **Constitution Principle X**, not any `I18N-LOCALIZATION-*` guarantee. Every
slice that ships family-facing UI must comply with X today; absent the shared i18n infrastructure, it
complies with a minimal local seam. The seam **realizes no `I18N-*` guarantee** — work item 2 continues
to _trace_ only its own `MEMBERS` FRs (Option B). `boundary-ledger.yaml` is **not modified** (no
guarantee is re-homed or deferred; the i18n guarantees stay `active` under their domain, and the
slice's own out-of-scope forbids touching the ledger).

### Scope (deliberately narrow)

- **Post-auth, members/admin only.** `GET /api/settings` sits behind the API-key boundary and the shell
  performs no boot-time `/api` probe, so the `LanguageProvider` mounts **inside** the admin-unlock
  Members subtree and can only ever localize already-authenticated UI. Pre-provision / credential-loss /
  ordinary-kiosk surfaces are **out of scope** and remain the `i18n-localization` domain's job. Every
  work item 2 string is admin-gated, so this scoping costs no functionality.
- **Client/family-facing only.** Server/dev/diagnostic text stays English always (Principle X / INV-12);
  the seam never touches `src/server` or `src/shared`.

## Consequences

- work item 2's tasks gain one foundational task (the seam) and reword the two UI tasks (/) to
  route strings through `t()` and to run the local parity test — closing the `check-issues` block.
- `plan.md`'s Constitution-Check row X, which self-certified PASS on the false premise "localized via
  i18n" at merge time, is corrected to "PASS via the local seam introduced here."
- The Members admin UI becomes the first localized surface in the app, honoring the `language: "es"`
  default that was previously dead metadata.

## Residual risk (accepted)

`check-coverage.mjs` reasons only over ledger entries and `Realizes:` back-references; it has **no
mechanism to flag a pre-emptive partial implementation of an unowned guarantee**. Nothing mechanically
stops a _third_ domain from inventing yet another divergent local i18n seam before `i18n-localization`
lands. This is accepted, bounded by (a) the narrow post-auth/members-only scope above and (b) the
reconciliation note below; it is **not** silently absorbed by prose. If a second slice needs a local
seam before the domain lands, prefer extending this one over forking a new shape.

## Reconciliation

When `i18n-localization` is built it MUST absorb/replace this seam: fold `src/client/i18n/messages.ts`
into the shared typed catalog + `dynamicKeyRegistry`, replace the local `LanguageProvider`/`resolveLang`
with the domain runtime, and retire `tests/client/member-i18n-parity.test.ts` in favor of the canonical
build/CI parity gate (INV-05). A reconciliation note is recorded in `docs/features/i18n-localization.md`.

## Related

- Constitution Principle X (translation parity, NON-NEGOTIABLE).
- `docs/features/i18n-localization.md` FR-004 (missing key → English base), FR-005 (parity gate),
  FR-013 (out-of-range persisted `language` normalized on read).
- ADR-028 (App Settings owns the `language` value + write-validation).
- work item 2 tasks (seam), / (localized UI), (local parity verification).
