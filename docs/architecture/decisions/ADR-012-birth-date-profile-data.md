# ADR-012 Birth Date as Profile Data

Status: accepted
Owner: product + architecture
Decision date: 2026-06-27

## Decision

Birth date is a first-class optional member profile field in this system.

The value supports month/day with an optional year. The product must not require an exact birth year, and the model must not invent a fake year when the user only provides month/day.

Member profile forms and member API endpoints must support birth-date operations: read, set during create, update during edit, and clear.

## Rationale

Daily Briefing birthday content depends on member birthday data. If that behavior exists in this system, the data should be explicit, editable profile data rather than hidden seed-only state.

Making the year optional avoids forcing collection of exact age while still supporting birthday reminders/countdowns. If a year exists, age-specific behavior can use it; otherwise birthday behavior should rely only on month/day.

## Affected Specs

- `../../01-members.md`
- `../../11-daily-briefing.md`
- `ADR-027-daily-briefing-per-user-opt-in.md`

## Data / Setup Implications

No legacy member birth-date rows are imported into this system under `ADR-026`.

Fresh deployment member setup should allow birth date to be omitted. If provided, the API must preserve whether the year was supplied rather than normalizing month/day-only input into a full date.

## Acceptance Criteria

- Given a member create form, when a user provides month/day without a year, then the profile saves a valid birthday without exact age.
- Given a member create or update request, when a full year/month/day birth date is provided, then the profile saves the full date.
- Given a member update request, when birth date is cleared, then future birthday briefing content treats the member as having no birthday data.
- Given birthday Daily Briefing generation, when a member has month/day only, then birthday matching works but age-specific output is omitted.
- Given invalid calendar values, when the form or API validates birth date, then the invalid value is rejected.

## Open Questions

- Exact wire/storage shape remains an implementation detail, but it must distinguish month/day-only from full year/month/day.
- Whether birthday content is enabled by default is owned by Daily Briefing configuration.

## Traceability

- Conflicts: `CR-012-birth-date-ownership`
- Related prior: `ADR-012`
- Domain grill: `../domain-grills/members.md`
