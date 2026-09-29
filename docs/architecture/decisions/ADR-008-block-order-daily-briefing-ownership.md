# ADR-008 Daily Briefing Block Order Belongs to Daily Briefing, Not App Settings

Status: accepted
Owner: product / architecture
Decision date: 2026-06-27

## Decision

`daily_briefing_block_order` is not a canonical App Setting. It must not appear in the App Settings object registry, in `GET /settings`, or be writable via `PUT /settings`.

Block order is a Daily Briefing configuration concern. Daily Briefing domain owns its storage, validation, and write contract.

## Rationale

The current situation — a `daily_briefing_block_order` row living in `app_settings` table but absent from the 17-key canonical schema — is a storage-convenience quirk, not intentional design. The key is invisible to the settings contract and creates a ghost field that may or may not survive response serialization.

Block order is a presentation preference for Daily Briefing, not a household-wide runtime parameter. Unlike timezone, language, or weather coordinates, it has no effect on any other domain. Furthermore, if multiple members have active Daily Briefing opt-in, each could reasonably want different block ordering — confirming that this is not a single global setting.

## Affected Specs

- `docs/rewrite-spec/03-app-settings-registry.md` — §11 quirk, §12 open question
- `docs/rewrite-spec/11-daily-briefing.md` — block order storage and configuration

## Data / Setup Implications

v2 does not migrate any legacy `app_settings` rows, including any `daily_briefing_block_order` row that may exist in the current database. Legacy data is evidence only under `ADR-026`. Daily Briefing defines its own fresh v2 storage for block configuration.

## Acceptance Criteria

- Given `PUT /settings` with `{ "object": "dailyBriefingBlockOrder", ... }`, the server rejects with an unknown object error.
- Given `GET /settings`, the response does not include any block-order field.
- Given a Daily Briefing block order change, no `app_settings` row is written.

## Open Questions

- None. Daily Briefing grill will define the exact block order storage model.

## Traceability

- Conflicts: `CR-008`
- Pre-v2: `ADR-008`
- Domain grill: `../domain-grills/app-settings-registry.md`
