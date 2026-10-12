# UI parity with the reference app — design

**Date:** 2026-10-13
**Status:** approved for execution
**Target:** this repository (`marplanner-project`)
**Reference:** `<marplanner-v1>` (`apps/web`)

## Goal

On branch `feat/ui-parity`, every shadcn primitive and shared composite in `src/client/components`
that appears on a seeded, reachable screen looks visually consistent with its counterpart in
`<marplanner-v1>` (same family at a glance, at most three rounds each), with an audit table
recording each component as matched, skipped or deferred, all listed gates green on the merged
branch, and no changes to props or behaviour.

## Intent

The reference app has the look we want; this repository has the structure we want. The work
carries the look over as styling only. Reference code is read for its classes and tokens and is
never copied in wholesale. Components keep this repository's structure, props and conventions.

## Scope

In scope:

- Theme tokens in `src/client/styles/globals.css`.
- Primitives in `src/client/components/ui`: `button`, `card`, `dialog`, `input`, `label`,
  `select`, `textarea`.
- Shared composites in `src/client/components`: `AdminPanel`, `CheckboxField`, `ConfirmDialog`,
  `ErrorNotice`, `Field`, `RadioField`, `StatusToggle`, `WeekdayPicker`.
- `NotoEmoji` in `src/client/chores/noto-emoji.tsx`.

Out of scope:

- Any component or state that has no seed data or is hard to reach in the running app. It is
  recorded as skipped, with the reason.
- Pixel-level matching.
- Changes to props, behaviour, routes or data.
- New dependencies, Storybook, or a component gallery.

Ports of reference components that do not exist here (`ColorPicker`, `MemberAvatar`,
`MemberBadge`, `ModalOverlay`, `Sheet`, `FormActions`, `ErrorCard`) are out by default. The audit
lists any port that an existing screen here would naturally adopt. No port is built under this goal; each one needs explicit
approval and would include wiring it into that screen so it can be captured.

## Comparison method

Both apps run locally on seeded data, and components are captured on real screens.

| Side      | How it runs                                                | Data                                                |
| --------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Target    | `npm run dev:fresh`                                        | Disposable `.data-fresh`, public then private seeds |
| Reference | `pnpm dev:status`, then `pnpm dev:restart`, plus Storybook | Disposable database seeded with `pnpm db:seed:full` |

- The reference's own database (`apps/api/sqlite.db`) must not be modified. The reference runs
  against a disposable database selected through `DATABASE_PATH`. If that override turns out not
  to work, stop and ask before seeding; do not seed the real database without a backup and
  approval.
- The two seeds hold different data. A screen populated on one side and empty on the other is
  skipped.
- Reference Storybook stories are a secondary source for states that the reference app does not
  show on a seeded screen. The target is always captured on a real screen.
- "Matched" means same family at a glance: spacing, radius, colour, typography, and the hover,
  focus and disabled states.

## Execution model

One Herdr worktree, `feat/ui-parity`, hosts one Claude agent (Opus 5.5) that owns the goal. That
agent uses a fresh subagent for each component, so no component inherits another's context. The
orchestrating session stays outside the worktree, checks the agent every three minutes, and
reviews what it commits.

## Phases

### 0. Setup — orchestrator

- Create the worktree and branch through Herdr, from `main`.
- Start the agent in it and hand it the goal.

### 1. Audit — agent, read-only

- Start both apps on seeded data on ports that do not clash.
- Write `docs/superpowers/specs/2026-10-13-ui-parity-audit.md` and commit it. It contains:
  - One row per component: file here, reference file and story, the seeded screen where it
    appears and how to reach it, visible differences from source and paired screenshots, the
    files a fix would touch.
  - A token map from the reference's generated palette to the variables in `globals.css`.
  - The skipped list with reasons.
  - Port candidates, each naming the screen that would adopt it. These are listed only.

The agent does not wait for approval after the audit. The orchestrator reviews the audit on its
next check and redirects the agent if it is wrong.

### 2. Tokens — agent, alone

Only `globals.css`, in one commit. Every screen shifts after this, so baselines are captured
again before any component work.

### 3. Components — one fresh subagent per component

- Primitives first, then composites and `NotoEmoji`, because composites render primitives.
- All subagents share one working tree and one pair of dev servers. They run one at a time by
  default. Two may run together only when their file sets are disjoint, and the gates are then
  run once after both finish, before either is committed.
- One commit per component, after its gates pass.
- The agent, not the subagent, updates the audit row to matched, skipped or deferred.

### 4. Wrap-up — agent, then orchestrator

- The agent runs the gates on the final branch, does a last side-by-side capture pass, and
  writes a short report into the audit file.
- Nothing is pushed. The orchestrator reports to the user, and one pull request is opened at the
  end only when asked.

## Rules for the agent and its subagents

- Read `docs/ui/component-contract.md` and `docs/development/style-guide.md` first.
- Loop: read both sources, capture both, edit, capture again. Three rounds at most per component,
  then stop and report what still differs.
- Do not change props, behaviour or exports, and do not add dependencies.
- A subagent edits only its component's files. A need for a token change in `globals.css` is
  reported to the agent, which makes it in its own commit.
- Formatting follows this repository (Prettier). Reference formatting (Biome) is not copied.
- Before each commit, all of these pass: `npm run format:check`, `npm run lint`,
  `npm run typecheck`, `npm run test:unit`, `npm run check:ui-catalog`, `npm run check:ui-debt`,
  `npm run check:accessible-names`.
- Each subagent reports before and after screenshots, what still differs, and why it stopped.
- Do not push, open pull requests, or modify anything in `<marplanner-v1>` other than starting
  its servers against a disposable database.

## Done

- Every in-scope component has an audit row marked matched, skipped or deferred.
- All listed gates pass on `feat/ui-parity` after the last merge.
- The reference's real database is unchanged.
- Each restyled component has its own commit on `feat/ui-parity`.

## Open points to confirm during setup

- Whether `DATABASE_PATH` can be overridden per run for the reference API.
- Which ports each app uses when both run at once.
