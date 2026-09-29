# ADR-029 Core / Plugin Architecture Intent

Status: accepted
Owner: product / architecture
Decision date: 2026-06-27

## Decision

v2 distinguishes between **core** and **plugin** features. Core features are always present in any household deployment. Plugins are optional features that a household activates; they may require specific hardware, external integrations, or generate content that not every household needs.

The technical implementation shape — feature flags vs. separately deployable modules — is deferred. The conceptual boundary is established here.

## Implications for App Settings

Settings objects owned by plugins are not part of the core settings registry. The discriminated union `PUT /settings` pattern (ADR-028) is well-suited to this: plugins register their own object names. The core registry only defines objects that are always meaningful regardless of which plugins are active.

## Core Domains

Accepted:

| Domain                   | Rationale                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| Members                  | Foundation for all household identity and assignment.            |
| Auth & Sessions          | Security boundary; required for any protected operation.         |
| App Settings Registry    | Locale (timezone, language, week start) needed at cold boot.     |
| Kiosk Shell & Navigation | The UI container for everything else.                            |
| Calendar (local events)  | Base agenda view is core kiosk functionality.                    |
| Day Periods              | Structures the day; consumed by Routines and other core domains. |
| Routines & Chores        | Core daily task management.                                      |
| i18n / Localization      | Infrastructure for the core; not a feature.                      |

## Plugin Domains

Accepted:

| Domain                   | Rationale                                                            |
| ------------------------ | -------------------------------------------------------------------- |
| Daily Briefing           | Content generation; loses half its value without Printing.           |
| Printing                 | Hardware-specific; meaningless without a physical printer.           |
| Weather                  | External API + configured coordinates; active setup required.        |
| Time Announcements       | Audio hardware or dedicated tab required.                            |
| Calendar sync (external) | Optional integration with Apple/Google/etc. Add-on to core Calendar. |
| Backups                  | Operational; not a user-facing product feature.                      |
| Network Devices          | UniFi/router integration; hardware-specific.                         |
| Meals & Recipes          | Optional content feature.                                            |
| Reminders                | Optional notification feature.                                       |
| Daily Messages           | Optional content feature.                                            |

## Background Jobs / Scheduler

Background jobs are owned by the feature that needs them. If the feature is core, its jobs are core infrastructure. If the feature is a plugin, its jobs activate only when the plugin is active. There is no global scheduler domain in the plugin sense.

## Settings Surface

Plugin settings go through the same `GET /settings` / `PUT /settings` endpoint as core settings (ADR-028). Plugins register their own object names in the settings registry. The `object` field in `PUT /settings` is the discriminator; the server validates `settings` against the schema registered by the owning plugin. `GET /settings` returns all active plugin objects alongside core objects in a single response.

## Plugin Settings Presence Contract

An inactive plugin's settings objects are **absent** from `GET /settings`. The presence of a settings object in the response is the signal that the plugin is active. Clients check `settings.printer !== undefined` to detect whether Printing is active — not `settings.printer?.enabled`.

## Open Questions

- What does "activate a plugin" look like for the household admin at first run?
- How does plugin activation interact with App Settings seed logic and cold-boot reads?

## Traceability

- Pre-v2: new decision, no prior PV2 ID
- Domain grill: `../domain-grills/app-settings-registry.md` (raised during App Settings grill; cross-cutting)
- Impacts: `ADR-028` (settings object registry extensibility), `ADR-008` (Daily Briefing owns its settings if it is a plugin)
