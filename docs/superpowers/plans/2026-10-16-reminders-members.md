# Reminders member pills + multi-member calendar-gated rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reminder rows name their members as member-colour pills, and calendar-gated rules are proven to work with several members end to end (write, edit, emit, dry-run).

**Architecture:** No server change (the data model and validation already accept N membership-only assignments). Client: `RemindersManagement.tsx` replaces the text `summarize()` with a `ReminderWho` line using `MemberChip`; `DryRunPanel` gets the rule's targetable members. Tests lock the multi-member behaviour at boundary, client and e2e level.

**Tech Stack:** React 19 + Tailwind, Fastify + better-sqlite3, Vitest + Testing Library, Playwright. Node 24.21.0 via `fnm exec --using=24.21.0`.

**Spec:** `docs/superpowers/specs/2026-10-16-reminders-members-design.md`

## Global Constraints

- Member pill look = variant D selected: filled `--member-color`, `text-member-avatar-foreground`, semibold (`MemberChip`, imported from `@/routines/admin/MemberChip`, not moved).
- "All members" stays a neutral label (`bg-muted rounded-full`), never a member pill.
- i18n: reuse existing keys; any new key goes in one block per locale in `src/client/i18n/messages.ts`.
- `docs/ui/household-contract.md` stays in sync. No migration, no OpenAPI change.
- Density tests: update counts/selectors only, add none.
- Gate ports: `PORT=43252 MP_E2E_WEATHER_FIXTURE_PORT=44482 MP_E2E_QUOTE_FIXTURE_PORT=44492`.

## Review Focus

- A specific rule assigned to an archived member: no pill for that member (client test in Task 2).
- An assignment whose member id is unknown to `/api/members`: skipped, no crash (Task 2 test).
- Dry-run panel of a specific rule with two members offers exactly those two, not other active members (Task 3 test).
- Editing a two-member calendar-gated rule preselects both pills and saving untouched sends both (Task 3 test).
- Long member names wrap the who-line rather than overflowing the row (`flex-wrap`, `MemberChip` truncates) — visual, checked in e2e screenshot-free assertion that both pills are visible.

---

### Task 1: Boundary proof — calendar-gated rule with several members

**Files:**
- Test: `tests/boundary/reminders-calendar-gated.test.ts` (append one `it`)

**Interfaces:** Consumes the existing helpers in that file (`insertDevice`, `insertMember`, `insertEvent`, `assign`).

- [ ] **Step 1: Write test `"a specific rule with two members emits for each member on their own assigned events, survives a two-member PATCH, and dry-runs per member"`**
  - Members Alice, Bruno, Carla. Event `shin-a` "Football training" 2026-08-17 assigned to Alice only.
  - POST `{kind:"calendar_gated", targetingMode:"specific", text:"shin pads", query:"football", assignments:[{memberId:A},{memberId:B}]}` → 201, `assignments.map(a=>a.memberId).sort()` equals `[A,B].sort()`.
  - Emissions 2026-08-17: Alice → `[{id, text:"shin pads"}]`; Bruno → `[]` (no assigned event).
  - Assign `shin-a` to Bruno too → Bruno emissions contain the rule.
  - PATCH `{assignments:[{memberId:B},{memberId:C}]}` → 200 with members `[B,C]`; Alice emissions now `[]`.
  - Dry-run `{memberId:B,date:"2026-08-17"}` → `{wouldEmit:true}`; `{memberId:C,...}` → `{wouldEmit:false, reason:"no_assigned_events"}`.
- [ ] **Step 2: Run** `fnm exec --using=24.21.0 npx vitest run tests/boundary/reminders-calendar-gated.test.ts` — expected PASS (characterisation of existing behaviour; if it fails, stop and fix the server per spec).
- [ ] **Step 3: Commit** `test(reminders): prove calendar-gated rules with several members`

### Task 2: Row who-line with member pills

**Files:**
- Modify: `src/client/admin/RemindersManagement.tsx` (`summarize`, `ReminderRow`)
- Test: `tests/client/reminders.test.tsx` (rewrite "summarises all-members, specific and calendar-gated rules"; add archived/unknown test)
- Docs: `docs/ui/household-contract.md` reminders paragraph

**Interfaces:**
- Produces: `function ReminderWho({ reminder, t, members }: { reminder: Reminder; t: Translate; members: Map<string, Member> }): JSX.Element` rendering `<p data-testid={`reminder-who-${reminder.id}`} className="text-muted-foreground text-control flex flex-wrap items-center gap-x-3 gap-y-1">`. `RemindersManagement` passes `memberById = new Map(allMembers.map(m => [m.id, m]))` instead of `memberNames`.
- Pill helper: `targetedMembers(reminder, members): Member[]` — assignments in order, mapped to known members with `lifecycle === "active"`; reused by Task 3.

- [ ] **Step 1: Write failing tests**
  - r1 who-line: contains text "All members" in an element with class `bg-muted`, and "Mon".
  - r3 who-line: `getByText("Ari")` and `getByText("Bea")` each have class `bg-[var(--member-color)]`; text "Mon, Wed" and "Fri" present.
  - r2 (calendar-gated, assignments m1+m2): "Match text: vet", Ari and Bea pills.
  - calendar-gated apply_to_all: neutral "All members", no element with `bg-[var(--member-color)]`.
  - Archived member (MEMBER_B `lifecycle:"archived"`) and an assignment to unknown id "zz": only Ari's pill renders.
- [ ] **Step 2: Run** `fnm exec --using=24.21.0 npx vitest run tests/client/reminders.test.tsx` — expected FAIL (old string summary).
- [ ] **Step 3: Implement** `ReminderWho` + `targetedMembers`; delete `summarize`; scheduled specific renders each member as `<span class="inline-flex items-center gap-1.5"><MemberChip/> {weekdayList}</span>`.
- [ ] **Step 4: Run** the client file — PASS; also `npx vitest run tests/client` density count tests (update counts only if they changed — they should not: pills are non-interactive).
- [ ] **Step 5: Update** `docs/ui/household-contract.md`: "one row per rule naming who it applies to (member-colour pills, or a neutral All members label) and on which days…".
- [ ] **Step 6: Commit** `feat(reminders): show who a rule reaches as member-colour pills`

### Task 3: Multi-member calendar-gated dialog + dry-run targeting

**Files:**
- Modify: `src/client/admin/RemindersManagement.tsx` (`DryRunPanel` props: `members: Member[]` replaces `activeMembers`)
- Test: `tests/client/reminders.test.tsx`; `tests/e2e/reminders-calendar-gated.spec.ts` (extend existing test, title unchanged)
- Docs: `docs/features/reminders.md` User Story 2 ("…emits only on days one of its members — all active members, or one or several chosen ones — has…")

**Interfaces:** Consumes `targetedMembers` from Task 2. `ReminderRow` passes `members={reminder.targetingMode === "specific" ? targetedMembers(reminder, memberById) : activeMembers}`.

- [ ] **Step 1: Write failing/locking client tests**
  - "creates a calendar-gated rule for two members": pick Ari + Bea pills → POST body `assignments` equals `[{memberId:"m1",weekdays:[]},{memberId:"m2",weekdays:[]}]`.
  - "editing a two-member calendar-gated rule preselects both and saves both": PATCH body `assignments` has both.
  - "the dry-run member picker offers only the rule's members": with members Ari, Bea, Cy (m3) and r2 assigned m1+m2, the combobox options (excluding placeholder) are `["Ari","Bea"]`; for an apply_to_all calendar-gated rule all three.
- [ ] **Step 2: Run** — dry-run test FAILS (lists Cy).
- [ ] **Step 3: Implement** the `members` prop.
- [ ] **Step 4: Run** client file — PASS.
- [ ] **Step 5: Extend e2e**: seed second member; check both `reminders-cg-member-*`; assert `reminder.assignments` has 2 members; row who-line shows both names; dry-run second member → `wouldNotEmit` + reason `no_assigned_events` text; first member still `wouldEmit`.
- [ ] **Step 6: Update** `docs/features/reminders.md` US2.
- [ ] **Step 7: Commit** `feat(reminders): dry-run offers a rule's own members; lock multi-member calendar-gated authoring`

### Task 4: Gates and inventory

- [ ] Run lint/typecheck/unit locally: `fnm exec --using=24.21.0 npm run lint`, `npm run typecheck` (or the scripts `check:standard` uses).
- [ ] Clean detached checkout gate: `git worktree add --detach <scratch>/gate HEAD`, symlink `node_modules`, `MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)`, `npm run check:standard`, then `PORT=43252 MP_E2E_WEATHER_FIXTURE_PORT=44482 MP_E2E_QUOTE_FIXTURE_PORT=44492 npm run check:aggregate-only`.
- [ ] Resync `tests/fixtures/assembly-cohort.json` (vitest cases, Playwright ids, coverage entries; lower `minimumTotals` only where code shrank, never `minimumRates`); commit `test: resync assembly cohort`; re-run gate.
