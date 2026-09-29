import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { test as base, expect } from "@playwright/test";
import type { TestInfo } from "@playwright/test";

/** Shared mutual-exclusion fixture for e2e specs that pair a REAL print executor
 * (`window.__mpPrintTransport`) against the shared `webServer`.
 * WHY THIS EXISTS: `claimJob` (src/server/modules/printing/
 * index.ts) claims the OLDEST `pending` job for household-today ACROSS ALL record keys — it is
 * NOT scoped by session, producer, or record key. Any two specs that each pair an executor
 * against the SAME server process can therefore steal each other's jobs: whichever executor's
 * poll tick fires first claims whatever is oldest, regardless of which spec enqueued it or which
 * transport fake is "supposed" to receive it. `tests/e2e/printing.spec.ts` and
 * `tests/e2e/daily-briefing.spec.ts`'s test both pair a printer — under `fullyParallel`
 * (playwright.config.ts) they can run concurrently in separate worker processes, and when they
 * do, one spec's bytes land in the OTHER's `recordedChunks`, failing with an empty-array
 * mystery rather than a clear diagnosis (reproduced: `printing.spec.ts:266` fails 4/4 when run
 * alongside `daily-briefing.spec.ts` without this fixture).
 * This fixture makes concurrent pairing IMPOSSIBLE instead of leaving "don't run these two
 * specs at once" as a doc-comment-only promise (which already rotted once — see both spec
 * files' own doc comments). MECHANISM: a filesystem mutex (`mkdirSync` is atomically exclusive —
 * it throws `EEXIST` when the directory already exists, which POSIX/Node guarantees is race-free
 * even across separate OS processes) under a fixed path in the OS temp dir — NOT an in-memory
 * lock, which would only serialize within one worker process, and Playwright's `fullyParallel`
 * may run these two specs in DIFFERENT worker processes.
 * Acquired/released via a FIXTURE (not a `try/finally` in the test body) specifically so release
 * still runs even if the test body times out and Playwright abandons it mid-`await` — a plain
 * `try/finally` inside an abandoned async function body never resumes past the hung `await`, but
 * Playwright's fixture teardown chain runs independently of the test function's own control flow
 * (the same class of bug this repo's review just found in that test's OWN settings-reset
 * `finally` block).
 * Usage: a spec that pairs a printer imports `test`/`expect` from HERE instead of
 * `@playwright/test` directly, and destructures `printerSession` in its test callback
 * (`async ({ page, printerSession }) => {...}`) — the fixture is intentionally NOT `auto`, so
 * Tests that never pair a printer (e.g. this file's sibling test) are never
 * serialized against this lock at all.
 * TIMEOUT ORDERING: Playwright resolves FIXTURE SETUP before the test
 * BODY ever starts running, and the overall per-test timeout is counted from the very start of
 * fixture setup, not from the first line of the test body. An in-body `test.setTimeout(...)`
 * call is therefore USELESS against a slow fixture: if `acquireLock` below blocks for a while
 * waiting on the other printer-pairing spec, the default 30s budget can expire and abort the
 * test before its body — and that `test.setTimeout` line — ever executes. Fixing this requires
 * two cooperating pieces: (1) each spec declares its OWN desired budget via
 * `test.describe.configure({ timeout })` at the top of the file (a static declaration Playwright
 * resolves at test-collection time, BEFORE any fixture runs — unlike an in-body call), and (2)
 * this fixture pads whatever that budget resolves to by `ACQUIRE_TIMEOUT_MS` (the lock's own
 * worst-case wait) via `testInfo.setTimeout` BEFORE calling `acquireLock` — so a spec that
 * forgets to size its own `describe.configure({ timeout })` generously enough for a lock wait
 * still gets a safe floor, in one shared place, rather than every future printer-pairing spec
 * having to remember this pitfall independently.
 */
const LOCK_DIR = path.join(os.tmpdir(), "marplanner-e2e-printer-session.lock");
const POLL_MS = 100;
const ACQUIRE_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR, { recursive: false });
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `printer-session lock (${LOCK_DIR}) held for over ${ACQUIRE_TIMEOUT_MS}ms — a previous ` +
            "printer-pairing e2e spec may have crashed without releasing it; remove that " +
            "directory manually if no such spec is currently running",
          { cause: err }
        );
      }
      await sleep(POLL_MS);
    }
  }
}

function releaseLock(): void {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort — a leftover empty lock dir only delays a future acquire, never corrupts data */
  }
}

export const test = base.extend<{ printerSession: void }>({
  // Playwright's fixture signature always takes a (possibly-empty) dependency-fixtures object as
  // its first param; this fixture needs none.
  // eslint-disable-next-line no-empty-pattern
  printerSession: async ({}, use, testInfo: TestInfo) => {
    // See "TIMEOUT ORDERING" in this module's own doc comment above — this MUST run before
    // `acquireLock` (which is exactly the step that can legitimately block for a while), not
    // after: padding the budget after already blocking would be too late. `timeout === 0` means
    // "no timeout" (disabled) — padding that would perversely introduce a finite bound where none
    // was wanted, so it is left alone.
    if (testInfo.timeout > 0) {
      testInfo.setTimeout(testInfo.timeout + ACQUIRE_TIMEOUT_MS);
    }
    await acquireLock();
    try {
      await use();
    } finally {
      releaseLock();
    }
  },
});

export { expect };
