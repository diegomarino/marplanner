import { execFileSync } from "node:child_process";
import type { BuildInfo } from "../../shared";

// Injected by scripts/build-server.mjs. Absent when the server runs from source (dev, tests).
declare const __MP_BUILD__: BuildInfo | undefined;

function git(args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

let cached: BuildInfo | undefined;

/** The commit this server was built from. A bundled server carries the value stamped at build
 * time; a server run from source reports the working checkout and no build time.
 */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  cached =
    typeof __MP_BUILD__ !== "undefined" && __MP_BUILD__
      ? __MP_BUILD__
      : {
          sha: process.env.MP_BUILD_SHA?.trim() || git(["rev-parse", "--short", "HEAD"]),
          subject: process.env.MP_BUILD_SUBJECT?.trim() || git(["log", "-1", "--format=%s"]),
          builtAt: null,
        };
  return cached;
}
