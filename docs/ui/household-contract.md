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

Once unlocked, the top bar becomes the admin bar: a home icon back to the household screens and a
breadcrumb of the registered admin pages on the way to the current one. The household navigation
and the Options menu are not shown there. A sidebar holds the admin sections and Lock; a page
appears in it once it has been redesigned, and until then it is reached from the overview's list
of all sections.

`/admin` is the overview: the deployed commit and server status, the commit this device runs and
whether it matches, and the most recent warnings and errors from the client log.

Members are created, edited, archived and restored from `/admin/members` in one form. A card
opens it. Archiving and restoring ask for confirmation, an archived member opens read-only, and a
colour held by another active member cannot be picked while a free one remains. The API enforces
the same rule, and a restored member whose colour was taken meanwhile comes back with the first
free one.

The ordered capability table is:

1. `/admin` — overview
2. `/admin/members` — members
3. `/admin/routines` — routines and chores
4. `/admin/reminders` — reminders
5. `/admin/meals` — meals and recipes
6. `/admin/daily-messages` — daily messages
7. `/admin/daily-briefing` — briefing configuration/generation/preview
8. `/admin/telemetry` — client telemetry
9. `/admin/backups` — backups: snapshot with success feedback, drag-and-drop .db upload, colour-coded types, relative dates, typed-filename restore, download with progress
10. `/admin/time-announcements` — time announcements
11. `/admin/network-devices` — network devices
12. `/admin/printing` — pair/re-pair, test print, print history
13. `/admin/settings` — language, time zone and week start, plus the day periods and, while the
    weather plugin is active, the weather location

Every destination is reached from the admin sidebar, grouped as Household, Daily briefing and
System.

While locked, the existing long-press and PIN flow is the only route to content. The pathname is
retained through unlock and refresh. Explicit lock, established inactivity, refresh, and leaving
`/admin/**` relock. Unknown admin destinations remain protected and, after unlock, offer a route to
`/admin` without rendering another panel.

## Accessibility and localization

All introduced navigation, accordion, menu, dialog, colour-choice, and action controls are keyboard
operable and named. Focus order follows visual order. Colour is never the sole carrier. Structural
copy exists in every supported household locale and translation parity is build-gated.
