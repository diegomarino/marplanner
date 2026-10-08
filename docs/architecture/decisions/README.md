# Architecture decisions

These records define the first-release architecture, rationale and consequences.
Each decision states its current policy directly; unmet implementation requirements
remain explicit. The [contracts](../contracts/README.md) define stable interfaces
and acceptance IDs, while executed checks establish delivery. Decision IDs are
not renumbered when redundant migration-only records are removed.

## Current decision map

Keep each policy consistent across the decision, contract and feature requirements.
Related decisions explain ownership and scope without requiring readers to apply
errata to obsolete instructions. Contract invariant and acceptance IDs stay stable.

| Topic                                     | Governing decisions and disposition                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member lifecycle and briefing eligibility | ADR-054 governs archive-only references; ADR-027 allows briefing opt-in for any active member; ADR-026 excludes legacy import.                                                                                                  |
| Authorization and serving                 | ADR-013 defines the client-only PIN; ADR-030/032 define future key lifecycle; ADR-058 calibrates household trust; ADR-059/060 define serving and transport. Key management remains deferred in the installed release.           |
| Plugin lifecycle                          | ADR-039 narrows ADR-029/038: first-party, activate/deactivate, canonical registry; dynamic install/uninstall stays dormant.                                                                                                     |
| Printing                                  | ADR-035 means one claimant per live lease, not exactly-once physical delivery. ADR-022 permits already-fetched content to finish after regeneration. ADR-066 settles server-side conversion while preserving ADR-041 ownership. |
| Announcements                             | ADR-051/065 govern browser-local scheduling; the kiosk contract states this exception directly.                                                                                                                                 |
| Restore and retention                     | ADR-017/042 follow the supported-lineage launch scope in ADR-056; pre-restore snapshots have a separate bounded lane.                                                                                                           |

### Outstanding implementation and policy gaps

These are open obligations or choices, not silently accepted exceptions. Updating
documentation does not satisfy a missing check or establish runtime acceptance.

| Decision | Remaining work                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-040  | Subscriber failures are persisted and searchable in admin; counters and automatic health degradation remain follow-up work.                                                            |
| ADR-043  | Generation gathers local reads around asynchronous external work; reproduce the inferred mixed-state risk and realize the required common read snapshot.                               |
| ADR-045  | Briefing snapshots flatten the required structured meal lists; preserve the list or explicitly approve a contract amendment.                                                           |
| ADR-050  | Plugin manifest event declarations and owner-namespace build checks remain absent; core event typing exists.                                                                           |
| ADR-056  | Production onboarding examples and their DB protections are not implemented; their launch disposition needs an explicit decision. Current synthetic seeds require a disposable target. |
| ADR-061  | The shared client runtime has catalog-wide parity; canonical dynamic-key declarations and locale resolution remain incomplete.                                                         |
| ADR-003  | Plugin lifecycle/lineage ISO TEXT timestamps diverge from the integer convention; choose a bounded exception or a safe migration.                                                      |

ADR-021 is absent from the maintained corpus. Printer configuration is governed by
ADR-028 and the [Printing contract](../contracts/printing.md); no replacement
historical record is fabricated to fill the numbering gap.

- [ADR-001 Member Role Model](ADR-001-member-role-model.md)
- [ADR-002 Active Member Targets](ADR-002-active-member-targets.md)
- [ADR-003 Audit Timestamp Encoding](ADR-003-audit-timestamp-integer-epoch-storage.md)
- [ADR-004 Reminder Assignments and Product Surface](ADR-004-reminder-per-member-assignment-and-surface.md)
- [ADR-005 Household Timezone Contract](ADR-005-household-timezone-contract.md)
- [ADR-006 Strict Calendar-Valid Date Validation](ADR-006-strict-date-validation.md)
- [ADR-007 API Key as the Backend Authorization Boundary; PIN is UI-Only](ADR-007-api-key-backend-boundary.md)
- [ADR-008 Daily Briefing Block Order Belongs to Daily Briefing, Not App Settings](ADR-008-block-order-daily-briefing-ownership.md)
- [ADR-009 Member Create Has No Daily Briefing Side Effect](ADR-009-member-create-no-briefing-side-effect.md)
- [ADR-010 Day Period Configurability and Day Model](ADR-010-day-period-configurability.md)
- [ADR-011 Day Period Default Start Times](ADR-011-day-period-default-start-times.md)
- [ADR-012 Birth Date as Profile Data](ADR-012-birth-date-profile-data.md)
- [ADR-013 PIN is a Client-Side UI Gate; No Server-Side Admin Sessions](ADR-013-pin-client-side-ui-gate.md)
- [ADR-014 Background Job Scheduler: Single-Instance Concurrency & Status](ADR-014-background-job-singleton-status.md)
- [ADR-015 Localization Contract (language model, fallback, scope, boundary)](ADR-015-localization-contract.md)
- [ADR-016 Client Telemetry: Privacy, Retention, Sinks, Best-Effort Contract](ADR-016-client-telemetry-privacy-retention-sinks.md)
- [ADR-017 Backup Restore Safety and Compatibility](ADR-017-backup-restore-safety-and-compatibility.md)
- [ADR-018 Calendar Read Interface and Merged Feed](ADR-018-calendar-read-interface-merged-feed.md)
- [ADR-019 Print Success Acknowledgement & Idempotency](ADR-019-print-success-acknowledgement.md)
- [ADR-020 Canonical Weekday Model](ADR-020-weekday-model.md)
- [ADR-022 Generated Output Snapshot & Regeneration Contract](ADR-022-generated-output-snapshot-and-regeneration.md)
- [ADR-023 Members Admin Route Placement](ADR-023-members-admin-route-placement.md)
- [ADR-024 External Calendar Provider Vocabulary](ADR-024-external-provider-vocabulary.md)
- [ADR-025 Member Lifecycle Archive](ADR-025-member-lifecycle-archive.md)
- [ADR-026 No Legacy Database Migration](ADR-026-no-legacy-database-migration.md)
- [ADR-027 Daily Briefing Per-User Opt-In](ADR-027-daily-briefing-per-user-opt-in.md)
- [ADR-028 Settings Write API Contract: Discriminated Union per Object](ADR-028-settings-write-api-contract.md)
- [ADR-029 Core / Plugin Architecture Intent](ADR-029-core-plugin-architecture-intent.md)
- [ADR-030 Multi-Key Scoped API Keys with Lifecycle and Device Provisioning](ADR-030-multi-key-scoped-api-keys.md)
- [ADR-031 Frontend Access Gate Stays Separate; Unauthenticated API Surface is Health-Only](ADR-031-frontend-access-gate-and-unauthenticated-surface.md)
- [ADR-032 Bootstrap `*` Key Establishment (Deployment-Agnostic)](ADR-032-bootstrap-key-establishment.md)
- [ADR-033 Fail-Closed Always; No Environment-Conditional Auth Bypass](ADR-033-fail-closed-no-environment-auth-bypass.md)
- [ADR-034 Admin Entry Affordance: Visible Link, Long-Press to Activate](ADR-034-admin-entry-long-press-affordance.md)
- [ADR-035 Runtime Service Placement: Capability-Based, Decision/Execution Split](ADR-035-runtime-service-placement.md)
- [ADR-036 Connection-Setup / Device Provisioning Placement](ADR-036-connection-setup-provisioning-placement.md)
- [ADR-037 Credential Format, Generation, and Failure-Based Rate Limiting](ADR-037-credential-format-and-generation.md)
- [ADR-038 Plugin Management Surface](ADR-038-plugin-management-surface.md)
- [ADR-039 Plugin System Trust / Permission / Installation / Sandbox Model](ADR-039-plugin-system-trust-and-extension-model.md)
- [ADR-040 Domain Event System (Cross-Module Decoupling)](ADR-040-domain-event-system.md)
- [ADR-041 Render Artefact Ownership & Device Render Context](ADR-041-render-ownership-and-device-context.md)
- [ADR-042 Backup Storage, Format, and Retention Model](ADR-042-backup-storage-format-and-retention.md)
- [ADR-043 Multi-Step Atomicity and Derived-State-on-Read](ADR-043-multistep-atomicity-and-derived-on-read.md)
- [ADR-044 Daily Briefing Repeated Blocks and Per-Block Language](ADR-044-daily-briefing-repeated-blocks-per-block-language.md)
- [ADR-045 Meals Additive Recurring Model (recurring entries + one-off entries, derived on-read)](ADR-045-meals-additive-recurring-model.md)
- [ADR-046 Recipe Deletion = Informed Cascade](ADR-046-recipe-deletion-informed-cascade.md)
- [ADR-047 Recipe Catalogue Shape (slot suitability + shell recipes)](ADR-047-recipe-catalogue-shape.md)
- [ADR-048 Daily Messages Targeting and Authoring Rules](ADR-048-daily-messages-targeting-and-authoring.md)
- [ADR-049 Reminder Kind Split (scheduled vs calendar_gated)](ADR-049-reminder-kind-split.md)
- [ADR-050 Typed Event Catalog (event-name registry for the domain event bus)](ADR-050-typed-event-catalog.md)
- [ADR-051 Time Announcements: Firing Model and Product Surface](ADR-051-time-announcements-firing-and-surface.md)
- [ADR-052 Weather Service Contract (tz, single-source location, correctness fixes)](ADR-052-weather-service-contract.md)
- [ADR-053 Network Devices Service Contract (ownership separation, external-mirror state, data minimization)](ADR-053-network-devices-service-contract.md)
- [ADR-054 Member Referential Integrity — Archive-Only, No Hard Delete](ADR-054-member-referential-integrity-and-discard.md)
- [ADR-055 — Technology Stack Baseline](ADR-055-stack-baseline.md)
- [ADR-056 — Engineering Process / DX Baseline](ADR-056-process-dx-baseline.md)
- [ADR-057 Admin Telemetry Read View](ADR-057-admin-telemetry-read-view.md)
- [ADR-058 Kiosk / Operator Trust Calibration (single household tier)](ADR-058-kiosk-operator-trust-calibration.md)
- [ADR-059 Same-Origin Serving and API Boundaries](ADR-059-serving-and-boundary-reconciliation.md)
- [ADR-060 Deployment Transport Posture & Cookie Security](ADR-060-deployment-transport-posture-and-cookie-security.md)
- [ADR-061 Shared Client Localization Runtime](ADR-061-members-local-i18n-seam.md)
- [ADR-062 Calendar Timed-Event Storage — UTC Instant Plus Originating TZID](ADR-062-calendar-timed-event-utc-plus-tzid.md)
- [ADR-065 Browser-Local Announcement Placement](ADR-065-announcement-firing-placement-reconciliation.md)
- [ADR-066 — ESC/POS conversion placement: server-side (candidate B full)](ADR-066-escpos-conversion-placement.md)
