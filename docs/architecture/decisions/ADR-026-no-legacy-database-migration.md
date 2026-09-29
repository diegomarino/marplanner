# ADR-026 No Legacy Database Migration

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

Marplanner v2 is a new product version with a fresh data store. v2 will not migrate any field or row from the current Marplanner production database.

Legacy database dumps, sanitized samples, current source behavior, and Wave 0-4 specs remain evidence for product decisions, risk discovery, terminology, and validation design. They are not a data-import contract.

## Rationale

The rewrite is not a compatibility migration of the current database. Treating every legacy row as something to preserve would force v2 architecture and product behavior around accidental historical data, drift, and implementation quirks.

Using legacy data as evidence still matters: it shows real use patterns, edge cases, broken constraints, and places where the old product accumulated ambiguity. But v2 should define the intended product model directly and start from clean seed/setup flows.

## Affected capabilities

Every persistent domain starts from new setup or seed data. The decision governs later feature imports as well as the foundation schema.

## Data / Setup Implications

There is no legacy database migration into v2.

Any existing "migration implications" in prior PV2 records should be read as "legacy evidence and v2 setup/data-retention implications" unless that record is updated more specifically. Future decision records should not promise preserve/transform/quarantine/import behavior for current database rows.

Migration-only PV2 questions should be closed as superseded when they have no remaining product-design question after this decision. If a row exposed a real v2 behavior question, keep the behavior question and remove the import obligation.

## Acceptance Criteria

- Given v2 implementation planning, when database initialization is discussed, then it starts from fresh schema/seed/setup flows rather than importing current production rows.
- Given a Wave 0-4 production-data quirk, when it is cited in a v2 decision, then it is cited as evidence only, not as a requirement to preserve that row.
- Given a future decision record, when it includes data implications, then it avoids legacy import language unless explicitly scoped to new v2 data, backup/restore within v2, or operator export/import features.

## Open Questions

- Whether v2 should support product-level import/export after launch is a separate future capability, not a legacy database migration.
- Backup/restore compatibility within v2 remains a separate Backups decision.

## Traceability

- Conflicts: affects all migration-only conflicts, especially `CR-003-parent-briefing-history`, `CR-004-orphan-routine-assignments`, `CR-016-client-telemetry`, `CR-017-backup-restore`, and `CR-025-external-calendar-migration`.
- Pre-v2: new cross-cutting architecture decision.
