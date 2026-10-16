# External event participants — design

Date: 2026-10-17. Branch: `feat/external-event-participants`. Brainstormed autonomously (owner
asked for no questions); every decision below is recorded as the worker's call unless marked as the
owner's.

## Intent

On `/calendar`, an event from a subscribed feed (`source === "external"`) shows only "External event
— read only" and offers no way to say who it is for. Title parsing assigns some members, but a
family often needs to add someone the title does not name. The server already accepts manual
assignments on external events; the screen just never offers them.

## Goals (owner)

- An **Edit participants** action on external events that opens only the shared `MemberPills`
  (multi) picker with Save / Cancel.
- Title, time, location and description stay read-only.
- Keep the read-only note, reworded so only the feed fields read as read-only.
- Saving must not duplicate title-derived members, and a later sync must keep the manual ones.

## Non-goals

- No per-event opt-out from title-derived assignment (removing a member the title names holds only
  until the next re-derivation, as `docs/features/calendar.md` already documents).
- No delete or field editing for external events.
- No new API field telling title-derived and manual members apart. The owner allowed showing that
  distinction only if the API already exposes it; `FeedItem.assignedTo` is a flat `string[]`, so the
  UI does not show it.

## Finding that drives the one server change

`replaceAssignments` (`src/server/modules/calendar/index.ts`) deletes **every** row of the event,
including title-derived `ext:` rows, and re-inserts each requested member as a UUID (manual) row.
The client must send the full set it shows, title-derived members included, so a plain save of an
external event would convert every title-derived member into a manual one. Two consequences:

1. A member is then represented as manual although the household never chose them by hand —
   effectively a manual duplicate of the title-derived assignment.
2. When the feed later renames the event so the title no longer names that member, the sync cannot
   drop them: `replaceTitleAssignments` only touches `ext:` rows.

This breaks the owner's "saving does not duplicate title-derived members" requirement, so a server
change is strictly required (worker's call). It stays minimal:

- In the replace transaction, keep an existing `ext:` row when its member is still in the requested
  set; delete every other row of the event; insert a UUID row only for requested members that have
  no remaining row.
- Local events never carry `ext:` rows, so their behaviour is unchanged.
- Response shape, validation, status codes and the route are unchanged.

Resulting semantics on an external event:

| Member state before save | In saved set | After save | After a later sync |
| --- | --- | --- | --- |
| title-derived (`ext:`) | yes | stays `ext:` | follows the title |
| title-derived (`ext:`) | no | removed | re-derived if the title still names them (documented limit) |
| manual | yes | manual | kept |
| manual | no | removed | stays removed |
| unassigned | yes | new manual row | kept |

## UI (worker's calls)

- External events: under the summary, the reworded note, then an outline small **Edit
  participants** button (`data-testid="calendar-edit-participants-btn"`, `Users` icon) when the
  panel is closed.
- Clicking it opens the same muted rounded panel the local edit form uses, containing only a
  `fieldset` with the "Who is it for" legend, the `MemberPills` picker (test id prefix
  `calendar-assign-member`, the same as the local edit form), a hint, the error notice and
  Save / Cancel (`calendar-participants-save-btn`). Members loading or failing to load reuse the
  local form's states.
- Save sends `PUT /api/calendar/events/:id/assignments` only when the set changed; an unchanged set
  just closes. On success: close the panel and the dialog, reload the feed (same as local edit). On
  failure: keep the panel open with `calendar.assignmentError`.
- The participant chips in the summary hide while the panel is open, as for local editing.
- Copy (en / es, one i18n block):
  - `calendar.externalReadOnly`: "From an external calendar — its title, time, location and
    description are read only." / "De un calendario externo: su título, hora, lugar y descripción
    son de solo lectura."
  - `calendar.editParticipants`: "Edit participants" / "Editar participantes"
  - `calendar.externalParticipantsHint`: "People named in the title are added again at the next
    sync." / "Las personas nombradas en el título se vuelven a añadir en la próxima sincronización."
- State is reused from the local edit form (`showEdit` key, `editMemberIds`, `updatingEvent`,
  `eventError`, `closeEdit`) so dismissing the dialog resets it the same way.

## Docs

- `docs/features/calendar.md`: the manual-assignment edge case now says the screen offers
  participant editing on external events and that saving keeps title-derived rows title-derived.
- `docs/api/calendar/openapi.yaml`: the PUT description states the `ext:` preservation.
- `docs/ui/household-contract.md`: the Calendar paragraph mentions participant editing on external
  events.

## Tests

- Boundary (`tests/boundary/calendar-sync.test.ts`, black-box over the route plus the reconcile
  entry point the suite already uses): PUT on an external event keeps the `ext:` row, adds one
  manual row, no duplicates; a re-sync with the same title keeps both with one row each; a re-sync
  whose title drops the named member removes that member and keeps the manual one.
- Boundary (`tests/boundary/calendar-assign.test.ts` area): local-event replace unchanged (existing
  cases cover it).
- Client (`tests/client/calendar-view.test.tsx`): the external event shows the reworded note and the
  Edit participants action, no field inputs, no delete; saving sends only the PUT with the chosen
  set; an unchanged set sends nothing; a failed PUT keeps the panel open with the error.
- E2E: one Playwright case in `tests/e2e/calendar-feed-sync.spec.ts` if the existing tracer source
  setup makes it cheap; otherwise client + boundary coverage suffices (builder's call, recorded in
  the report).

## Left to the builder

Exact JSX placement, icon choice, and whether the e2e case is added.
