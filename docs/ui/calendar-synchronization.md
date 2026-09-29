# UI Contract: Admin Calendar

## Route and gate

- Route: `/admin/calendar`.
- It is reachable through the existing Admin navigation and protected by the existing client-side
  Admin PIN accidental-touch gate.
- Local Calendar create/edit/delete remains on `/calendar` and never consumes Admin PIN state.
- The page uses the approved v2 `HouseholdChrome` and Admin framing; the feature body adapts v1.

## Composition

At desktop width the page renders two peer columns:

1. **External Calendars** — creation form followed by source cards.
2. **Emoji Highlights** — creation form followed by ordered draggable rule cards.

At narrow width the columns stack without horizontal overflow. Loading, empty, error, active sync,
success, failure, disabled, and confirmation states remain distinguishable without relying on color
alone.

## External source creation

Visible fields:

- Name
- Feed URL
- Provider: Generic ICS, Google, Microsoft, Apple
- Add source

The UI submits the supported 15-minute polling interval and has no visible interval control. The API
may accept other bounded intervals for non-UI clients. A successful submit clears name/URL,
leaves the persisted card visible, and starts showing real phase text from server status. A failed
first sync keeps the card and shows a retry-capable safe failure.

## Source card

Every card displays:

- source name;
- masked URL;
- provider label;
- durable last success or localized safe failure;
- transient localized phase while available;
- an independent **Enabled** toggle;
- a separate **Sync now** action;
- a separate trash/**Delete** action.

The Enabled toggle is reversible and never invokes deletion. Turning it off hides imported events
from every Calendar consumer and prevents later runs; retained data/configuration remains. Turning it
on restores retained active events immediately and resumes polling.

Delete opens a confirmation naming the source. Confirmed deletion is permanent and removes the
source, imported events, and external assignments. Cancelling closes the dialog without mutation.

Sync now is disabled while the source is disabled or deleting. If a run is already active, the UI
continues observing that run rather than showing a duplicate operation.

## Synchronization progress

The page maps the server phase to localized text:

- `requesting` — Requesting feed…
- `downloading` — Downloading calendar…
- `parsing` — Parsing events…
- `reconciling` — Updating household calendar…
- `succeeded` — Calendar updated
- `failed` — Calendar update failed

No percentage, duration estimate, fake step, or wall-clock delivery claim is shown. The client polls
the source collection about once per second only while any source phase is active, stops after a
terminal state, and also refreshes Calendar event queries after success.

## Emoji highlight creation

Visible fields:

- Emoji
- Comma-separated keywords
- Add rule

Submission requires one non-empty emoji and at least one non-empty keyword after trimming. Duplicate
keywords collapse without changing the remaining display order.

## Highlight rule card

Each card displays a drag handle, emoji, keyword list, independent Enabled toggle, and confirmed
trash/Delete action. Rules can be reordered with pointer drag, touch drag, or keyboard sensor. The
drag handle has a localized accessible name.

After a drop, the client submits the complete intended order once. The optimistic order may render
immediately; on failure the client restores the authoritative previous/server order and announces
the error.

## Accessibility

- Page has one visible `h1` and named landmark sections.
- Inputs have visible labels; icon-only actions have localized accessible names.
- Toggle state is programmatically exposed.
- Confirmation dialog receives focus, traps it, closes on Escape, and restores focus to its trigger.
- Reordering is achievable without pointer input and announces item movement/status.
- Busy controls remain identifiable and avoid layout shifts.

## Localization

Every family-visible label, state, confirmation, progress message, and safe failure has complete `en`
and `es` parity. Server error codes and operator logs remain stable English diagnostics. Imported
event text is rendered as text, never HTML.

## Human acceptance

Before marking the visible journey accepted, present live v1 and v2 Admin Calendar surfaces at the
same representative state. Approved v2 shell differences are intentional; the feature body's
composition and interactions use v1 as the baseline unless this contract says otherwise.
