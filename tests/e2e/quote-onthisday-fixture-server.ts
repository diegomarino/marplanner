import http from "node:http";
import type { Server } from "node:http";

/** — the e2e "fixture provider" for `quoteOfDay`/`onThisDay` (`WEATHER_ENDPOINT`/
 * `tests/e2e/weather-fixture-server.ts` precedent EXACTLY): a tiny local HTTP server standing in
 * for zenquotes.io + Wikipedia's `onthisday` API, so a Playwright-driven `npm start` process
 * performs zero real egress for either source (the "no test tier performs real
 * egress" applies here too — `isTestRuntime` only guards vitest, never this real built-server
 * process — see `src/server/modules/daily-briefing/external/ports.ts`'s module doc).
 * Same globalSetup/globalTeardown requirement as the weather fixture: Playwright starts
 * `webServer` BEFORE `globalSetup` runs, so the port this fixture binds must be a fixed constant
 * both `playwright.config.ts` and this module import — not one only discovered at runtime.
 * Bound ONLY to loopback (127.0.0.1) for the lifetime of the whole e2e run.
 */
export const QUOTE_ONTHISDAY_FIXTURE_PORT = 41839;
export const QUOTE_ONTHISDAY_FIXTURE_ORIGIN = `http://127.0.0.1:${QUOTE_ONTHISDAY_FIXTURE_PORT}`;

/** The exact quote text/author this fixture serves — `tests/e2e/daily-briefing.spec.ts` pins an
 * exact assertion against these (ground-truthed from `ports.ts`'s `zenQuotesSource` parsing: a
 * `ZenQuotesEntry[]`, `q`/`a` fields, `stripOuterQuotes` applied to `q`). Deliberately wrapped in
 * ASCII quotes here so the fixture also exercises `stripOuterQuotes`, same as v1's real payload
 * shape. */
export const FIXTURE_QUOTE_TEXT = "Fixtures make the future predictable.";
export const FIXTURE_QUOTE_AUTHOR = "E2E Fixture";

/** Ground-truthed from `ports.ts`'s `wikipediaOnThisDaySource` parsing: a
 * `WikipediaOnThisDayResponse` (`events`/`births`/`deaths`, each `{year, text}[]`). `onThisDay`
 * ships default-disabled (FR-013) and no e2e spec enables it today, so this payload is never
 * actually exercised by the current suite — it exists so the seam is genuinely wired end to end,
 * not just declared. */
function onThisDayFixturePayload(): unknown {
  return {
    events: [{ year: 1999, text: "A fixture event took place." }],
    births: [{ year: 1900, text: "A fixture birth was recorded." }],
    deaths: [{ year: 1950, text: "A fixture death was recorded." }],
  };
}

let server: Server | undefined;

/** Starts the fixture server on the fixed port above. Idempotent no-op if already running. */
export function startQuoteOnThisDayFixtureServer(): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", QUOTE_ONTHISDAY_FIXTURE_ORIGIN);

      if (url.pathname === "/api/today") {
        // Fixture hit log — the human-verifiable "no real egress happened" signal for this
        // task's manual e2e run (playwright's webServer.stdout is piped, see
        // playwright.config.ts): a real zenquotes.io/wikipedia.org call is categorically
        // impossible to see here, only a request that actually reached THIS process is.
        console.log(`[quote-onthisday-fixture] GET /api/today`);
        const body = JSON.stringify([{ q: `"${FIXTURE_QUOTE_TEXT}"`, a: FIXTURE_QUOTE_AUTHOR }]);
        res.writeHead(200, { "content-type": "application/json" }).end(body);
        return;
      }

      if (url.pathname.startsWith("/api/rest_v1/feed/onthisday/all/")) {
        console.log(`[quote-onthisday-fixture] GET ${url.pathname}`);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(onThisDayFixturePayload()));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" }).end("{}");
    });
    s.once("error", (err) => {
      reject(
        new Error(
          `quote/onThisDay e2e fixture could not bind 127.0.0.1:${QUOTE_ONTHISDAY_FIXTURE_PORT} — is another run active?`,
          { cause: err }
        )
      );
    });
    s.listen(QUOTE_ONTHISDAY_FIXTURE_PORT, "127.0.0.1", () => {
      server = s;
      resolve();
    });
  });
}

/** Stops the fixture server. Idempotent no-op if not running. */
export function stopQuoteOnThisDayFixtureServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = undefined;
    s.close(() => resolve());
  });
}
