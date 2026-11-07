/** Server-side lookup of the vendored Noto Emoji SVGs (`src/shared/noto/`). The production bundle
 * carries them beside `dist/server/index.js` as `noto/` (scripts/build-server.mjs); running from
 * source (tsx, tests) reads the shared directory directly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notoEmojiFilename } from "../../shared/notoEmoji";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [path.join(moduleDir, "noto"), path.resolve(moduleDir, "../../shared/noto")];

let cachedFiles: ReadonlySet<string> | undefined;

function vendoredFiles(): ReadonlySet<string> {
  if (cachedFiles) return cachedFiles;
  const dir = CANDIDATE_DIRS.find((candidate) => fs.existsSync(candidate));
  if (!dir) {
    throw new Error(
      `Vendored Noto emoji directory not found (looked in ${CANDIDATE_DIRS.join(", ")})`
    );
  }
  cachedFiles = new Set(fs.readdirSync(dir).filter((file) => file.endsWith(".svg")));
  return cachedFiles;
}

/** Whether the app ships a Noto SVG for this emoji, i.e. it can be drawn on screen and on paper. */
export function hasNotoEmoji(emoji: string): boolean {
  return vendoredFiles().has(notoEmojiFilename(emoji));
}
