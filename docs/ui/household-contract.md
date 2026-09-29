# UI Contract: Household UI Assembly

## Family shell

Every provisioned family route renders persistent chrome with visible Home, Calendar, Tasks, and
Meals controls. The active destination is semantic. Options contains exactly Large controls and
Admin; printer pairing is not a menu item. `/daily-briefing` and unknown family paths render a
localized not-found outcome, never Home by substitution.

Activating Admin from Options uses the same-document navigation seam and closes the Options menu as
the route changes, preserving page-lifetime services without leaving an overlay above admin content.

Weather retains its absence policy and forecast dialog. The adjacent device clock exists only when
weather exists and the browser reports fullscreen-like presentation. Its accessible name identifies
device time.

Calendar remains one family-facing surface at `/calendar`. On a provisioned device its inline
create, assign, edit, and delete actions are available without the administration PIN. The PIN only
guards `/admin/**` against accidental settings or destructive administration changes; it is not a
security boundary.

The printer attention pill is visible by default when existing printing capability is active. It
opens a focus-managed dialog containing generic attention copy, genuine session state if available,
pair/re-pair, and a link to `/admin/printing`. Closing returns focus to the trigger.

## Dashboard

At a representative 800px-high tablet viewport the first screen makes agenda, per-child chores, and
meal strip simultaneously identifiable. Each region has its own loading, empty, retry, and failure
boundary.

Chore columns contain all configured periods. Only one period per child is expanded; changing it
does not mutate another column. Complete is one action. Uncomplete opens the established confirmation
dialog. Meals are read-only and link to `/meals`.

Agenda all-day items precede timed items. Text/icon/weight identify temporal states without colour.
Multi-member items render every active assigned identity plus text.

## Administration

The ordered capability table is:

1. `/admin` — create member
2. `/admin/members` — members
3. `/admin/day-periods` — day periods
4. `/admin/routines` — routines and chores
5. `/admin/reminders` — reminders
6. `/admin/meals` — meals and recipes
7. `/admin/daily-messages` — daily messages
8. `/admin/daily-briefing` — briefing configuration/generation/preview
9. `/admin/telemetry` — client telemetry
10. `/admin/backups` — backup/restore
11. `/admin/time-announcements` — time announcements
12. `/admin/weather` — weather
13. `/admin/network-devices` — network devices
14. `/admin/printing` — pair/re-pair, test print, print history

While locked, the existing long-press and PIN flow is the only route to content. The pathname is
retained through unlock and refresh. Explicit lock, established inactivity, refresh, and leaving
`/admin/**` relock. Unknown admin destinations remain protected and, after unlock, offer a route to
`/admin` without rendering another panel.

## Accessibility and localization

All introduced navigation, accordion, menu, dialog, colour-choice, and action controls are keyboard
operable and named. Focus order follows visual order. Colour is never the sole carrier. Structural
copy exists in every supported household locale and translation parity is build-gated.
