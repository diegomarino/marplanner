import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("private seed overlay repository boundary", () => {
  it("ignores only the documented private seed filename contract", () => {
    const root = mkdtempSync(join(tmpdir(), "mp-seed-ignore-"));
    // An exported source tree has no Git history. Exercise its ignore policy in
    // isolation from the enclosing checkout and the developer's global excludes.
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    try {
      execFileSync("git", ["init", "--quiet", "--template=", root], { env });
      writeFileSync(join(root, ".gitignore"), readFileSync(".gitignore"));
      for (const [path, ignored] of [
        ["seeds/seed-900-printer-PRIVATE.ts", true],
        ["seeds/seed-910-calendar-PRIVATE.mjs", true],
        ["seeds/seed-010-settings.ts", false],
      ] as const) {
        const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
          cwd: root,
          env,
          input: `${path}\n`,
          encoding: "utf8",
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(ignored ? 0 : 1);
        expect(result.stdout.trim()).toBe(ignored ? path : "");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
