// ─────────────────────────────────────────────────────────────────────
// Marplanner receipt theme. PORTED from v1
// `packages/marplanner-theme/src/{prepare,template}.ts` — the JetBrains Mono
// receipt theme only (v1's Courier Prime "ascii" variant is not used by
// Daily Briefing and is not ported). Fonts ship as REAL FILES under
//./fonts/jetbrains-mono, loaded from disk via readFileSync (no network
// fetch at render time —); `roleUrls` stays empty (required by
// pressedslip's ThemeTemplate shape but unused since loadThemeFonts'
// URL-fetch path is bypassed entirely). Module-level memoized singleton —
// `prepareDailyBriefingTheme` builds once and caches.
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHeaderDefaults,
  applyShellDefaults,
  defineTheme,
  validateTheme,
  type LoadedFont,
  type PreparedTheme,
} from "pressedslip";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Pure-data theme template (v1 `template.ts`, ported verbatim including the
 * `answer` text style's `rotate: 180` — the printed riddle-answer upside-down
 * convention (riddle block) relies on).
 */
const marplannerThemeTemplate = defineTheme({
  id: "marplanner",
  label: "Marplanner Receipt",
  roleUrls: { body: [] },
  shell: {
    titleStyle: "block",
    titleFontWeight: 700,
    titleFontSize: 20,
    titleAlignment: "right",
    titleFillChar: "═",
    titleBg: "#1a1a1a",
    titleFg: "#f5f1e8",
    contentPadding: "normal",
    separatorThickness: "thin",
    separatorColor: "#b8b0a0",
    textStyles: {
      body: { fontSize: 22, fontRole: "body" },
      emphasis: { fontSize: 22, fontStyle: "italic", fontRole: "body" },
      display: { fontSize: 48, fontWeight: 700, fontRole: "display" },
      label: { fontSize: 18, fontRole: "body" },
      question: { fontSize: 22, fontRole: "body" },
      answer: { fontSize: 18, fontRole: "body", rotate: 180 },
      extras: {
        pronunciation: { fontSize: 18, fontStyle: "italic", fontRole: "body" },
      },
    },
  },
  header: {
    nameFontWeight: 700,
    nameFontSize: 32,
    dateFontSize: 16,
    dateFontWeight: 400,
    padding: 24,
    bottomRuleHeight: 4,
    bottomRuleColor: "#000",
  },
});

/** Exported (unlike v1's private `prepare.ts#loadFont`) purely for the throw-path test
 * (tests/boundary/daily-briefing-render-probe.test.ts) — a missing/unreadable font file must
 * throw a diagnostic error naming the file/path, never let `fs.readFileSync`'s raw ENOENT escape
 * unadorned.
 */
export function loadFont(
  dir: string,
  file: string,
  name: string,
  weight: number,
  style: "normal" | "italic"
): LoadedFont {
  const absPath = path.join(dir, file);
  try {
    const data = fs.readFileSync(absPath);
    return { name, data: new Uint8Array(data), weight, style };
  } catch (err) {
    throw new Error(
      `daily-briefing render theme: failed to load font ${file} from ${absPath}. ` +
        `Did the plugin's fonts/ directory ship correctly? Cause: ${String(err)}`,
      { cause: err }
    );
  }
}

let cached: PreparedTheme | undefined;

/** Build (and memoize) the Marplanner receipt theme — module-level singleton. */
export function prepareDailyBriefingTheme(): PreparedTheme {
  if (cached) return cached;

  const fontsDir = path.join(moduleDir, "fonts/jetbrains-mono");

  const fontRegular = loadFont(
    fontsDir,
    "JetBrainsMono-Regular.ttf",
    "JetBrainsMono",
    400,
    "normal"
  );
  const fontMedium = loadFont(fontsDir, "JetBrainsMono-Medium.ttf", "JetBrainsMono", 500, "normal");
  const fontBold = loadFont(fontsDir, "JetBrainsMono-Bold.ttf", "JetBrainsMono", 700, "normal");
  const fontItalic = loadFont(fontsDir, "JetBrainsMono-Italic.ttf", "JetBrainsMono", 400, "italic");

  const fonts: LoadedFont[] = [fontRegular, fontMedium, fontBold, fontItalic];

  const prepared: PreparedTheme = {
    _kind: "prepared",
    id: marplannerThemeTemplate.id,
    label: marplannerThemeTemplate.label,
    fonts,
    // Display shares body's byte source but is registered as its own lookup —
    // silent fallback would mask a future theme intending display != body
    // that forgot to register it (v1 workstream-sp8d comment, ported).
    fontRoles: { body: fonts, display: [fontBold] },
    shell: applyShellDefaults(marplannerThemeTemplate.shell),
    header: applyHeaderDefaults(marplannerThemeTemplate.header),
  };
  validateTheme(prepared);
  cached = prepared;
  return prepared;
}

/** Test-only reset of the module-level memo (mirrors other host-api singleton test seams). */
export function __resetDailyBriefingThemeForTests(): void {
  cached = undefined;
}
