import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

/** Exercise the public ESLint configuration: FR-014 debt, FR-015 exceptions,
 * recipe admission, layering, density, and preservation of INV-05/SC-011.
 * Fixtures are linted at governed paths, so configuration drift fails here.
 */
const repoRoot = join(__dirname, "../..");

async function lint(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(code, {
    filePath: join(repoRoot, relativeFilePath),
  });
  return results[0]?.messages ?? [];
}

// One violation per FR-014 debt category: a raw Tailwind scale class, an inline `style={{...}}`
// object literal, and a hardcoded hex colour literal.
const FR014_FIXTURE = [
  'export const debtClass = "bg-red-500";',
  // Keep literal and hoisted styles: object-literal-only enforcement misses the latter.
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

describe("UI debt enforcement ratchet (FR-014/FR-015/FR-017) — executable proof, not just eslint.config.mjs prose", () => {
  it("FR-014's three rules fire on a fixture at a NON-exception client path (src/client/home/WeatherPill.tsx)", async () => {
    const messages = await lint("src/client/home/WeatherPill.tsx", FR014_FIXTURE);
    const fr014 = messages.filter(
      (m) => m.ruleId === "ui-policy/debt" && /FR-014/.test(m.message ?? "")
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
        (m) => m.ruleId === "ui-policy/debt" && /FR-014/.test(m.message ?? "")
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
  // FR-014 (or stop matching any UI debt rule at all), so `fr014` above comes back
  // empty and this test goes RED. Demonstrated live in this 's evidence (not re-asserted here
  // as a no-op): temporarily widening the exception list to the wildcard turns this exact test
  // red; reverting turns it green again.
  it("terminal ratchet: UI_DEBT_EXCEPTION_FILES is EMPTY and must stay empty — re-adding an exception after is a deliberate red, not a quiet edit", async () => {
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

it("rejects adversarial debt forms while allowing semantic token composition and translation copy", async () => {
  const invalid = [
    'export const colour = "CRIMSON";',
    'export const css = "bg-white/50";',
    'export const mix = "color-mix(in oklch, var(--primary), White)";',
    'export const Widget = () => <div {...{ style: { padding: "1rem" } }} />;',
    'import { createElement } from "react"; export const x = createElement("div", { style: { padding: "1rem" } });',
  ];
  for (const code of invalid) {
    const messages = await lint("src/client/home/WeatherPill.tsx", code);
    expect(
      messages.some((m) => /FR-014/.test(m.message)),
      code
    ).toBe(true);
  }
  for (const code of [
    'export const css = "color-mix(in oklch, var(--primary) 20%, var(--background))";',
    'export const css = "var(--color-member-red-500)";',
  ]) {
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).filter((m) => /FR-014/.test(m.message))
    ).toHaveLength(0);
  }
  expect(
    (
      await lint(
        "src/client/i18n/messages.ts",
        'export const messages = { "weather.condition.snow": "Snow" };'
      )
    ).filter((m) => /FR-014/.test(m.message))
  ).toHaveLength(0);
});

it("protects layer boundaries, recipe expressions and imported primitive sizing without dropping existing rules", async () => {
  for (const code of [
    'import * as Dialog from "@radix-ui/react-dialog"; export { Dialog };',
    'export const styles = { LABEL_CLASSES: "border" };',
    'export const LABEL_CLASSES = ["border", "rounded"].join(" ");',
    'import * as UI from "@/ui"; export const X = () => <UI.Button className="size-9" />;',
    'import { Button as Action } from "@/components/ui/button"; export const X = () => <Action className="hover:size-9">Act</Action>;',
  ]) {
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).some((m) =>
        /G2|G3|#762/.test(m.message)
      ),
      code
    ).toBe(true);
  }
  expect(
    (
      await lint(
        "src/client/components/ui/input.tsx",
        'import { useT } from "@/i18n"; export { useT };'
      )
    ).some((m) => /G5/.test(m.message))
  ).toBe(true);
  const config = await new ESLint({ cwd: repoRoot }).calculateConfigForFile(
    join(repoRoot, "src/client/lib/recipes.ts")
  );
  expect(JSON.stringify(config.rules["no-restricted-syntax"])).toContain("SC-011");
});

it("keeps measurement and lint in agreement for colours and style props at the public seam", async () => {
  const { countSource } = await import(join(repoRoot, "tools/dev/count-ui-debt.mjs"));
  for (const code of [
    'export const x = "[background:Red]";',
    'export const x = "var(--primary, WHITE)";',
    'export const x = "color-mix(in oklch, var(--primary), rgb(1 2 3))";',
    "export const x = `color-mix(in oklch, ${token}, White)`;",
    'export const x = "var(--color-member-red-500)";',
    'export const x = "color-mix(in oklch, var(--primary), var(--background))";',
    'const props = { style: { "--progress": 50 } }; export const x = <div {...props} />;',
  ]) {
    const counts = countSource("src/client/home/WeatherPill.tsx", code);
    const messages = await lint("src/client/home/WeatherPill.tsx", code);
    expect(messages.filter((m) => m.ruleId === "ui-policy/debt")).toHaveLength(
      counts.scaleClasses + counts.inlineStyles + counts.colourLiterals
    );
  }
  expect(
    (await lint("src/client/i18n/messages.ts", 'export const colour = "CRIMSON";')).some((m) =>
      /FR-014/.test(m.message)
    )
  ).toBe(true);
});

it("rejects new raw controls and smaller minimums, permits native recipes and token forwarding", async () => {
  for (const code of [
    "export const X = () => <button>Act</button>;",
    'export const X = () => <textarea aria-label="Notes" />;',
    'export const X = () => <input type="text" aria-label="Name" />;',
    'export const X = () => <select aria-label="Choice" />;',
    'import { Textarea } from "@/ui"; export const X = () => <Textarea className="min-h-0" />;',
    'import { Textarea } from "@/ui"; export const X = () => <Textarea className="min-h-10" />;',
  ])
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).some((m) => /G1|G3/.test(m.message)),
      code
    ).toBe(true);
  for (const code of [
    'import { NATIVE_SELECT_CLASSES } from "@/lib/recipes"; export const X = () => <select aria-label="Choice" className={NATIVE_SELECT_CLASSES} />;',
    'import { Textarea } from "@/ui"; export const X = () => <Textarea className="min-h-24 w-full" />;',
    'import { Button } from "@/ui"; export const X = () => <Button className="text-[color:var(--primary)] [&_svg]:size-4" />;',
    '// eslint-disable-next-line ui-policy/debt -- Only the closed member token is forwarded.\nexport const X = () => <div style={{ "--member-color": "var(--color-member-blue-500)" }} />;',
  ])
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).filter((m) =>
        /FR-014|G1|G3/.test(m.message)
      ),
      code
    ).toHaveLength(0);
});

it("rejects reviewer probes for literal fallback, calculated shrinking, relative imports and fake recipes", async () => {
  for (const code of [
    'export const x = "var(--primary, rgb(255 0 0))";',
    'export const x = "var(--primary, oklch(60% 0.2 20))";',
    'import { Button } from "@/ui"; export const X = () => <Button className="h-[calc(var(--control-height)/2)]" />;',
    'import { Button } from "@/ui"; export const X = () => <Button className="[&]:h-4" />;',
    'import { Textarea } from "@/ui"; export const X = () => <Textarea rows={1} className="!min-h-0" />;',
    'import { Button } from "@/ui"; export const X = () => <Button className="max-h-4" />;',
    'import { Button } from "@/ui"; export const X = () => <Button className="text-[calc(var(--control-font-size)/2)]" />;',
    'import { Button } from "@/ui"; export const X = () => <Button className="!h-4" />;',

    'import { Button } from "../ui"; export const X = () => <Button className="h-4" />;',
    'export const X = () => <select className="NATIVE_SELECT_CLASSES h-4" />;',
    'import { NATIVE_SELECT_CLASSES } from "@/lib/recipes"; export const X = () => <select className={cn(NATIVE_SELECT_CLASSES, "h-4")} />;',
  ])
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).some((m) =>
        /FR-014|G1|G3/.test(m.message)
      ),
      code
    ).toBe(true);
  expect(
    (
      await lint(
        "src/client/home/WeatherPill.tsx",
        'import { NATIVE_SELECT_CLASSES as recipe } from "../lib/recipes"; export const X = () => <select className={recipe} />;'
      )
    ).filter((m) => /G1/.test(m.message))
  ).toHaveLength(0);
});

it("rejects arbitrary-property density overrides while preserving tokens, growth and descendants", async () => {
  for (const classes of [
    "[height:10px] [font-size:8px]",
    "[min-height:0]",
    "[max-height:10px]",
    "[font-size:8px]",
    "md:[height:10px]",
    "![min-height:0]",
    "[height:10px]!",
    "[&]:[height:10px]",
    "[height:calc(var(--control-height)/2)]",
    "[font-size:var(--control-font-size,8px)]",
  ]) {
    const code = `import { Button } from "@/ui"; export const X = () => <Button className="${classes}" />;`;
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).some((m) => /G3/.test(m.message)),
      classes
    ).toBe(true);
  }
  for (const classes of [
    "[height:var(--control-height)] [font-size:var(--control-font-size)]",
    "[min-height:var(--control-height)] [max-height:var(--control-height)]",
    "[min-height:48px]",
    "md:[min-height:96px] [width:10px]",
    "[&_svg]:[height:10px] [&>svg]:[font-size:8px]",
  ]) {
    const code = `import { Button } from "@/ui"; export const X = () => <Button className="${classes}" />;`;
    expect(
      (await lint("src/client/home/WeatherPill.tsx", code)).filter((m) => /G3/.test(m.message)),
      classes
    ).toHaveLength(0);
  }
  const reviewedGlyph = [
    'import { Button } from "@/ui";',
    "export const X = () => <Button",
    "// eslint-disable-next-line ui-policy/sizing -- Decorative glyph; token height retains the touch target.",
    'className="[font-size:1.5rem]" />;',
  ].join("\n");
  expect(await lint("src/client/home/WeatherPill.tsx", reviewedGlyph)).toHaveLength(0);
});
