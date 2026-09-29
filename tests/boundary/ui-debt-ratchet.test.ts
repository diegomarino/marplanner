import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

/** FR-014 (the three enforced UI-debt lint
 * rules — raw Tailwind scale classes, inline `style={{...}}` attributes, hardcoded colour
 * literals) and FR-015 (the `UI_DEBT_EXCEPTION_FILES` narrowing) ship as `eslint.config.mjs`
 * prose plus `tools/dev/check-exception-list.mjs`'s size-only monotonicity check, but with NO
 * executable proof that the rules actually fire, or that the exception narrows FR-014 alone
 * without also disabling INV-05 (the logger `data`-shape invariant). Both facts can be
 * silently switched off:
 * - A wildcard swap: replacing `UI_DEBT_EXCEPTION_FILES` with
 * `["src/client/* \/*.{ts,tsx}"]` kills FR-014 across the entire client tree. It stays a
 * 20-entry array (`check-exception-list.mjs` PASSes — same size), `npx eslint --no-cache
 * src/client` stays clean, and `telemetry-negatives.test.ts` §5 (which asserts INV-05, not
 * FR-014) still passes. Nothing here would have caught it before this test existed.
 * - A duplicate glob block: appending a third `files: ["src/client/* \/*.{ts,tsx}"]` block with
 * its own `no-restricted-syntax` array to the SAME glob (see the "MANDATORY two-block shape"
 * comment directly above the real config's INV-05/FR-014 block) silently REPLACES the
 * existing array under ESLint flat config, killing INV-05 *and* every FR-014 selector at
 * once, with zero lint messages anywhere and only a code comment guarding against it.
 * This test drives the REAL, live `eslint.config.mjs` through the ESLint Node API (same
 * technique as tests/boundary/weather-rule-b.test.ts and telemetry-negatives.test.ts §5) against
 * in-memory fixtures at a real non-exception path and a real exception-listed path, so a change
 * to either block above shows up here as a red test rather than as silence.
 */
const repoRoot = join(__dirname, "../..");

async function lint(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(code, {
    filePath: join(repoRoot, relativeFilePath),
  });
  return results[0]?.messages ?? [];
}

// One violation per FR-014 selector class: a raw Tailwind scale class, an inline `style={{...}}`
// object literal, and a hardcoded hex colour literal.
const FR014_FIXTURE = [
  'export const debtClass = "bg-red-500";',
  // A HOISTED style object, deliberately. The literal form `style={{ … }}` is caught by BOTH the
  // narrow selector (`style > JSXExpressionContainer > ObjectExpression`) and the broad one, so a
  // fixture using only that form leaves this test green if someone narrows the selector back —
  // and the hoisted form is exactly the evasion (the hoisted form) the broadening closed. The
  // most recently fixed hole must be the one the guard can see.
  'const HOISTED_STYLE = { padding: "1rem" };',
  "export function Widget() {",
  "  return (",
  "    <>",
  '      <div style={{ padding: "1rem" }} />',
  "      <div style={HOISTED_STYLE} />",
  "    </>",
  "  );",
  "}",
  'export const debtColour = "#ff0000";',
  "",
].join("\n");

// An INV-05 violation (template-literal `data` argument to the logger) alongside the FR-014
// fixture above, so the exception-path test can assert INV-05 STILL fires while FR-014 does not
// — the exception narrows FR-014 only, per eslint.config.mjs's own "narrows the block above...
// deliberately keeps INV-05 fully enforced" comment.
const FR014_PLUS_INV05_FIXTURE = [
  FR014_FIXTURE,
  'import { log } from "../lib/logger";',
  'const userInput = "x";',
  'log("info", "test.component", "message", `interpolated ${userInput}`); // INV-05 violation',
  "",
].join("\n");

describe("UI debt enforcement ratchet (T007, FR-014/FR-015/FR-017) — executable proof, not just eslint.config.mjs prose", () => {
  it("FR-014's three rules fire on a fixture at a NON-exception client path (src/client/home/WeatherPill.tsx)", async () => {
    const messages = await lint("src/client/home/WeatherPill.tsx", FR014_FIXTURE);
    const fr014 = messages.filter(
      (m) => m.ruleId === "no-restricted-syntax" && /FR-014/.test(m.message ?? "")
    );

    expect(fr014.some((m) => /raw Tailwind scale class/.test(m.message))).toBe(true);
    expect(fr014.some((m) => /inline style attribute/.test(m.message))).toBe(true);
    // BOTH style forms must be flagged, not just one — narrowing the selector back to the
    // object-literal-only shape must turn this red.
    expect(fr014.filter((m) => /inline style attribute/.test(m.message))).toHaveLength(2);
    expect(fr014.some((m) => /colour literal/.test(m.message))).toBe(true);
  });

  // The exception-path test dynamically reads the list: this test used to name a specific exception-listed
  // file (`src/client/calendar/CalendarView.tsx`) literally. Every batch that migrates a surface
  // OFF the exception list retargets that literal to whatever file is still on it — a countdown
  // that becomes unsatisfiable the moment the list empties.
  // Reading `UI_DEBT_EXCEPTION_FILES[0]` dynamically instead means no future batch has to touch
  // this file at all;
  // by removing this ratchet's exception-path test alongside the list itself.
  // TERMINAL STATE: the exception list is empty; this test must retire the
  // exception-path variant "alongside the list itself" — the queue merge that landed the last two
  // removals is where the list factually emptied, so the retirement happens here). The exemption
  // property ("narrows FR-014 only") has no members left to hold FOR; what replaces it is the
  // stronger, terminal property: at a path that WAS exception-listed until this module
  // (DailyBriefingManagement.tsx), FR-014 now fires like everywhere else, and INV-05 still fires
  // alongside it — enforcement is tree-wide with no carve-outs.
  it(
    "FR-014 AND INV-05 both fire at a FORMERLY exception-listed path " +
      "(DailyBriefingManagement.tsx) — the exemption era is over, enforcement is tree-wide",
    async () => {
      const messages = await lint(
        "src/client/admin/DailyBriefingManagement.tsx",
        FR014_PLUS_INV05_FIXTURE
      );

      const fr014 = messages.filter(
        (m) => m.ruleId === "no-restricted-syntax" && /FR-014/.test(m.message ?? "")
      );
      expect(fr014.length).toBeGreaterThan(0);

      const inv05 = messages.filter(
        (m) => m.ruleId === "no-restricted-syntax" && /INV-05/.test(m.message ?? "")
      );
      expect(inv05.length).toBeGreaterThan(0);
    }
  );

  // Wildcard-swap / third-block tripwire: this is the SAME
  // assertion as the first test above, called out again explicitly as the tripwire it doubles as.
  // Widening UI_DEBT_EXCEPTION_FILES to `["src/client/* /*.{ts,tsx}"]` — or replacing the shared
  // INV-05/FR-014 block with a third glob-duplicate block — makes WeatherPill.tsx stop matching
  // FR-014 (or stop matching any no-restricted-syntax rule at all), so `fr014` above comes back
  // empty and this test goes RED. Demonstrated live in this 's evidence (not re-asserted here
  // as a no-op): temporarily widening the exception list to the wildcard turns this exact test
  // red; reverting turns it green again.
  it("terminal ratchet: UI_DEBT_EXCEPTION_FILES is EMPTY and must stay empty — re-adding an exception after slice 020 is a deliberate red, not a quiet edit", async () => {
    const { UI_DEBT_EXCEPTION_FILES } = await import(join(repoRoot, "eslint.config.mjs"));
    // Stronger than the earlier "non-empty" sanity in both directions: a wildcard-swap attack
    // now fails on length alone, and quietly grandfathering new debt through the list
    // fails the same way.
    expect(UI_DEBT_EXCEPTION_FILES).toHaveLength(0);
  });

  // SC-011 uses the same executable-proof technique as the FR-014 tests above. The
  // `eslint.config.mjs` rule must have executable proof that it fires. Two mutations that disable
  // the rule were demonstrated against
  // this exact suite (not re-asserted here as a no-op, per the file's own convention above):
  // breaking `SC011_ERROR_TEXT_TOKEN_SOURCE` into a never-matching regex, and deleting
  // `...SC011_SELECTOR,` from the client `no-restricted-syntax` block — both left every other
  // test in this file green (none of them touch SC-011 at all), and both turn every test below
  // red.
  const SC011_LITERAL_FIXTURE = [
    "export function Widget({ error }: { error: string | null }) {",
    '  return error ? <p className="text-destructive">{error}</p> : null;',
    "}",
    "",
  ].join("\n");

  // The TemplateElement twin: the config's own SCALE_CLASS
  // and COLOUR selectors above already pair a `Literal` form with a `TemplateElement` form; the
  // original SC011_SELECTOR shipped only the `Literal` half, leaving a template-literal className
  // silently unenforced. This fixture is the executable proof the twin selector exists and fires.
  const SC011_TEMPLATE_FIXTURE = [
    "export function Widget({ error, extra }: { error: string; extra: string }) {",
    "  return <p className={`text-destructive ${extra}`}>{error}</p>;",
    "}",
    "",
  ].join("\n");

  it("SC-011's selector fires on an unannounced error-coloured element (Literal className) at a governed path", async () => {
    const messages = await lint("src/client/home/WeatherPill.tsx", SC011_LITERAL_FIXTURE);
    const sc011 = messages.filter(
      (m) => m.ruleId === "no-restricted-syntax" && /SC-011/.test(m.message ?? "")
    );
    expect(sc011.length).toBeGreaterThan(0);
  });

  it("SC-011's selector also fires when the error class arrives via a template literal (P1-6)", async () => {
    const messages = await lint("src/client/home/WeatherPill.tsx", SC011_TEMPLATE_FIXTURE);
    const sc011 = messages.filter(
      (m) => m.ruleId === "no-restricted-syntax" && /SC-011/.test(m.message ?? "")
    );
    expect(sc011.length).toBeGreaterThan(0);
  });

  it('SC-011\'s selector does NOT fire when role="alert" is present on the same element', async () => {
    const code = [
      "export function Widget({ error }: { error: string | null }) {",
      '  return error ? <p role="alert" className="text-destructive">{error}</p> : null;',
      "}",
      "",
    ].join("\n");
    const messages = await lint("src/client/home/WeatherPill.tsx", code);
    const sc011 = messages.filter(
      (m) => m.ruleId === "no-restricted-syntax" && /SC-011/.test(m.message ?? "")
    );
    expect(sc011).toHaveLength(0);
  });

  // Verified here: SC-011 must fire on EVERY client file, not just non-exception
  // ones — a file's FR-014 migration-debt exemption (UI_DEBT_EXCEPTION_FILES) must not also
  // silently exempt SC-011. Using UI_DEBT_EXCEPTION_FILES[0] the same way the FR-014
  // exception-path test above does (see its MEDIUM-g comment for why this reads the list
  // dynamically instead of naming a file).
  // TERMINAL STATE: the exception list is empty, so "still fires at a listed path" has
  // no subject. The property this test protected — an FR-014 exemption must not also exempt
  // SC-011 — is preserved at a FORMERLY listed path, where SC-011 fired throughout the exemption
  // era and must keep firing now that the era is over.
  it("SC-011's selector fires at a FORMERLY exception-listed path (DailyBriefingManagement.tsx) — it never depended on the FR-014 exemption and still does not", async () => {
    const messages = await lint(
      "src/client/admin/DailyBriefingManagement.tsx",
      SC011_LITERAL_FIXTURE
    );
    const sc011 = messages.filter(
      (m) => m.ruleId === "no-restricted-syntax" && /SC-011/.test(m.message ?? "")
    );
    expect(sc011.length).toBeGreaterThan(0);
  });
});
