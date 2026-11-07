// Vendored Noto emoji artwork as pressedslip image sources, for `images` reminders on the printed
// briefing. The SVGs live in src/shared/noto/ (npm run generate:noto-emojis); the server and
// standalone render bundles carry a copy beside their entry as `noto/` (scripts/build-server.mjs),
// mirroring how theme.ts loads its fonts from disk.
//
// Each SVG is rasterized to a PNG at its printed size instead of being passed through as vector:
// the whole slip is thresholded to 1 bit at the end, and Noto's flat colours collapse to almost
// nothing at a plain threshold (light fills such as the pink ballet shoes vanish entirely). As a
// PNG, pressedslip's image block Floyd–Steinberg-dithers it, which keeps every shape legible.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { imageFromBuffer } from "pressedslip";
import { notoEmojiFilename } from "../../../../shared/notoEmoji";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [
  path.join(moduleDir, "noto"),
  path.resolve(moduleDir, "../../../../shared/noto"),
];

const cache = new Map<string, string | null>();

/** A PNG data URI of the emoji's Noto artwork, `sizePx` wide on a white background, or null when
 * the app ships no SVG for it. Memoized per emoji and size. */
export function notoEmojiPngDataUri(emoji: string, sizePx: number): string | null {
  const key = `${sizePx}:${emoji}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const dir = CANDIDATE_DIRS.find((candidate) => fs.existsSync(candidate));
  const file = dir ? path.join(dir, notoEmojiFilename(emoji)) : undefined;
  const uri =
    file && fs.existsSync(file)
      ? imageFromBuffer(
          new Uint8Array(
            new Resvg(fs.readFileSync(file), {
              fitTo: { mode: "width", value: sizePx },
              background: "#ffffff",
            })
              .render()
              .asPng()
          ),
          "image/png"
        )
      : null;
  cache.set(key, uri);
  return uri;
}
