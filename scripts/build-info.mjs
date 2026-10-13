/** Resolves what a build should say about itself: the commit it was cut from and when.
 * A deploy pipeline without a git checkout passes MP_BUILD_SHA / MP_BUILD_SUBJECT; a local
 * build reads them from git. Anything unavailable is null — never a guess.
 */
import { execFileSync } from "node:child_process";

function git(args) {
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

export function resolveBuildInfo(env = process.env, now = new Date()) {
  return {
    sha: env.MP_BUILD_SHA?.trim() || git(["rev-parse", "--short", "HEAD"]),
    subject: env.MP_BUILD_SUBJECT?.trim() || git(["log", "-1", "--format=%s"]),
    builtAt: now.toISOString(),
  };
}
