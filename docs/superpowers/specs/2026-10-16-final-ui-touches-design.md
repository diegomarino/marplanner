# Final admin touches (Worker A): shell, briefing, plugins — design

Date: 2026-10-16. Branch: `feat/final-ui`. Source: owner brief "Final admin touches", section
Worker A (items 1, 2, 3, 5). The owner asked for autonomous work, so every decision below is
the worker's call unless it quotes the brief.

## 1. Options tap gives feedback

**Why.** Since PR #42 the Options button on the household bar *is* the Admin long-press
affordance while Admin is its only entry. A plain tap does nothing and nothing says why.

**Reproduced** on the dev server (2026-10-16, `VITE_DEV_BYPASS_ADMIN_PIN=0` as in the owner's
`.env.local`): tapping Options leaves the URL at `/` and renders nothing. So the owner hit the
"hold required" case. The only "no hold required" case in the code is the dev PIN bypass
(`isAdminPinBypassEnabled()`), where `pointerdown` already opens admin at once; that path stays.

**Behaviour.**
- A press that ends before the 3 s hold completes (pointer released, or Enter/Space released)
  shows a short hint under the button: "Hold to open Admin" / "Mantén pulsado para abrir
  Admin". It is a `role="status"` live region and disappears after ~2.5 s, or as soon as a new
  hold starts.
- The hold progress bar and the 3 s hold keep working unchanged; a completed hold never shows
  the hint (the hint is only raised while the hold timer is still pending at release).
- Cancelled pointers (`pointercancel`, lost capture, blur) do not show the hint: they are not
  taps.
- Same behaviour for the Admin item inside the Options menu when extra entries exist (it shares
  `adminAffordanceProps`).
- With the bypass on, a tap still opens admin directly (no hint).

**Tests.** Unit (HouseholdChrome): tap → hint visible and URL unchanged; completed hold → admin
opens and no hint; keyboard short press → hint. E2E helpers `tests/e2e/admin-nav.ts` and
`admin-unlock.ts` keep working (they hold with `mouse.down` until the URL changes); one e2e
check that a tap shows the hint is added to an existing spec, not a new density test.

## 2. Briefing → Blocks: a block off for all days at once

**Why.** Turning a block off today needs seven cell clicks.

**Behaviour.** A trailing "Every day" column in the block × weekday matrix with one small
outline button per block row:
- If the block is on for at least one day → button "Off" (aria: "Turn {block} off every day");
  writes `{ enabled: false, weekdays: [] }` — the same shape a cell toggle writes when the last
  day goes off.
- If the block is off on every day → button "On" (aria: "Turn {block} on every day"); writes
  `{ enabled: true, weekdays: null }` (null = every day, as the cells write when all seven are on).
- Disabled while the row is saving. Paused-day semantics unchanged: the "Briefing runs" row is
  the member's pause schedule; paused-day cells stay greyed/disabled and keep their stored value,
  and the row button writes every weekday regardless of pause (the pause wins at run time, as it
  does for cells).
- A pure helper `rowToggleInput(settings)` next to `cellToggleInput` in `briefingBlocks.ts`;
  the page wires it through a new `onToggleRow` prop and the existing `saveBlock`.

## 3. Briefing → Schedule → members table: member-colour name

The member's name in the first column renders as `MemberChip` (filled member colour, white
semibold text — the selected-MemberPills look) instead of dot + plain text. `MemberChip`
currently lives in `src/client/routines/admin/`; it is imported from there rather than moved to
`@/ui`, to keep the change local (Worker B may touch member pills in Reminders; promoting the
chip is left as a follow-up). The row header text (accessible name) stays the display name.

## 5. Plugins: Active/Deactivated toggle and muted inactive card

**Behaviour.**
- The card's bottom "Activate X"/"Deactivate X" button becomes a `StatusToggle` (from `@/ui`)
  in the card header, where the state text was: `pressed` = active, visible label = the state
  text (`plugins.state.*`: Active / Inactive / Needs attention; the `plugin-state-{id}` test id
  moves onto that label), accessible name = the plugin's label (state-invariant, as
  StatusToggle requires). It calls the existing `transition(id, activate|deactivate)`; `busy`
  while an operation is in flight, with the existing "Starting/Stopping safely…" live text and
  focus return.
- There is no confirmation today (neither in the page nor the provider); none is added —
  activation is reversible and the server already drains safely. Errors keep the existing
  feedback/ErrorNotice paths.
- A card whose state is `inactive` gets `bg-muted` (grey) so it stands apart from active ones.
  An `errored` card keeps the normal ground (it already carries an error notice and should not
  look merely "off").

## Non-goals
- No server/API change. No new shared component. No new density tests (existing ones may get
  updated counts/selectors).

## Constraints
- i18n in one block per locale in `src/client/i18n/messages.ts`; `docs/ui/household-contract.md`
  and `docs/ui/plugin-management.md` kept in sync.
- Gates: `npm run check:standard` in a clean detached checkout, then `npm run check:aggregate-only`
  with ports PORT=43251, MP_E2E_WEATHER_FIXTURE_PORT=44481, MP_E2E_QUOTE_FIXTURE_PORT=44491;
  resync `tests/fixtures/assembly-cohort.json`.
