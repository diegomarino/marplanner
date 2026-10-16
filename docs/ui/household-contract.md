# UI Contract: Household UI Assembly

## Family shell

Every provisioned family route renders persistent chrome with visible Home, Calendar, Tasks, and
Meals controls. The active destination is semantic. Options holds Admin only; printer pairing is
not a menu item. While Admin is its only entry, the Options button is the Admin affordance itself
(same long-press hold, same `admin-affordance` testid) rather than a one-item menu; a second entry
turns it back into a disclosure menu with Admin first. A press released before the hold completes
(a tap, or Enter/Space let go early) shows a short "Hold to open Admin" status under the affordance
for a few seconds; a completed hold or a cancelled pointer shows nothing. `/daily-briefing` and unknown family paths
render a localized not-found outcome, never Home by substitution.

Activating Admin from Options uses the same-document navigation seam and closes the Options menu (when
there is one) as the route changes, preserving page-lifetime services without leaving an overlay
above admin content.

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

`/admin` is the overview: the deployed commit and server status and how long the server has been
running, the commit this device runs and whether it matches, and the most recent warnings and errors from the client log.

Members are created, edited, archived and restored from `/admin/members` in one form. A card
opens it. Archiving and restoring ask for confirmation, an archived member opens read-only, and a
colour held by another active member cannot be picked while a free one remains. The API enforces
the same rule, and a restored member whose colour was taken meanwhile comes back with the first
free one.

Reminders are listed at `/admin/reminders`, one row per rule naming who it applies to and on which
days with an Active/Off badge. "Add rule" and the row's edit icon open one dialog; editing can switch
a rule between all members and specific members. The dialog's choices are pills: kind and
applies-to as segmented choices, weekdays in the household's week-start order, and for specific
members a pill in each member's colour with a weekday-pill row beneath it while selected. Deleting
asks for confirmation. A failed load can
be retried; a calendar-gated rule's row opens its dry-run panel. Messages (`/admin/daily-messages`)
chooses the member with member pills, keeps its 14-day editor, alternates the rows' background per
week from the household week start (the first chunk is plain, then shaded, then plain) and offers
Retry when a load fails.

Routines and chores are managed from `/admin/routines`: a list of routines grouped by day period,
in start-time order, beside the selected routine's detail — a weekday grid of the children it is
assigned to, its chores (drag to reorder, also with the keyboard) and actions to edit, assign, add a
chore or delete. Routines, chores and assignments are edited in dialogs. The assignment dialog lists each child with their colour chip and a one-line weekday pill row in the household week-start order; an assignment that was deactivated is marked as such. Deleting a routine or a
chore, changing, reactivating or deactivating an existing assignment, and moving a routine to
another day period ask for confirmation, because each changes the live streak.

The ordered capability table is:

1. `/admin` — overview
2. `/admin/members` — members
3. `/admin/routines` — routines and chores
4. `/admin/reminders` — reminders
5. `/admin/meals` — Meals: editable week menu (the family meal grid; a cell adds a one-off or, via "Every <weekday>", a recurring entry in an active plan; a meal opens for content edit or delete, and recurring changes apply every week), meal plans each listing their recurring entries by weekday with an in-card add form and activate/deactivate, then recipes
6. `/admin/daily-messages` — daily messages
7. `/admin/daily-briefing` — Briefing: three tabs (local state, no sub-paths).
   - Schedule (default): automatic generation time and auto-print after morning chores (Save enabled when changed); Generate briefings for a chosen date (Generate for all members); a Members table naming each member as their member-colour chip, with the per-member opt-in (its only home), the briefing days summary, the result for the chosen date and Blocks/Briefings shortcuts.
   - Blocks and Briefings share one member pill bar: opted-out members are "off" pills that cannot be picked (opt-in lives only in the Schedule members table); opting the selected member out selects the first opted-in member, and with nobody opted in one line points to Schedule with a button that opens it.
   - Blocks: per-member blocks × weekdays matrix in household week-start order, with a "Briefing runs" pause row, an "Every day" column whose per-row button turns the block off on every day (or on every day when it is off on all of them) without touching the pause row, inline block parameters and drag/keyboard reorder of the household block order; "settings changed" notice links to Briefings.
   - Briefings: 30-day history, date, Generate/Regenerate, View PNG, Print to the queue, payload and image states; the paused notice links to Blocks.
8. `/admin/telemetry` — client telemetry
9. `/admin/backups` — backups: snapshot with success feedback, drag-and-drop .db upload, colour-coded types, relative dates, typed-filename restore, download with progress
10. `/admin/time-announcements` — time announcements (card list; create/edit dialog; delete confirmation)
11. `/admin/network-devices` — network devices (Registered devices and Add device tabs)
12. `/admin/printing` — Printer: Settings tab (plugin and auto-print state, paper width, Bluetooth
    printer with pair/re-pair, name, device id and UUIDs, saved to `printer`/`printerTransport`) and
    Diagnostics tab (test print, reset today's print, recent prints)
13. `/admin/settings` — language, week start and time zone in the left column and, while the
    weather plugin is active, the weather location in the right column (stacked on narrow
    content), with one Save below both columns that is enabled only while a value differs from the
    stored one; below, the four day periods in a row, each always editable with its own Save

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
