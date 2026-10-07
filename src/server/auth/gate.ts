import { stripBasePath } from "../../shared/base-path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_COOKIE, serializeAuthCookie } from "./cookies";

const ACCESS_ENV = "MP_ACCESS_TOKEN";

export { GATE_COOKIE };

/** Load shared semantic tokens (same file `globals.css` imports).
 * Candidates cover tsx/vitest (`src/…`), module-relative auth path, and the
 * prod copy beside `dist/server/index.js` (`ui-tokens.css` via build-server).
 */
function loadUiTokensCss(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "src/client/styles/tokens.css"),
    resolve(here, "../../client/styles/tokens.css"),
    resolve(here, "ui-tokens.css"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(
    `UI tokens CSS not found (tried ${candidates.join(", ")}). Access gate cannot render.`
  );
}

const UI_TOKENS_CSS = loadUiTokensCss();

/** Gate layout only — colours/density come from `UI_TOKENS_CSS`. */
const GATE_LAYOUT_CSS = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    min-height: 100%;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--foreground);
    background: var(--background);
  }
  .shell {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .panel {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
  }
  .header { display: flex; flex-direction: column; gap: 0.25rem; }
  h1 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.75rem;
    font-weight: 700;
  }
  .description {
    margin: 0;
    font-size: var(--control-font-size);
    line-height: 1.4;
    color: var(--muted-foreground);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .field { display: flex; flex-direction: column; gap: 0.375rem; }
  label {
    font-size: var(--control-font-size);
    font-weight: 500;
    line-height: 1.25;
  }
  input[type="password"] {
    width: 100%;
    height: var(--control-height);
    margin: 0;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--input);
    border-radius: 0.375rem;
    background: transparent;
    color: var(--foreground);
    font: inherit;
    font-size: var(--control-font-size);
    outline: none;
  }
  input[type="password"]:focus {
    border-color: var(--ring);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent);
  }
  button[type="submit"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: var(--control-height);
    margin: 0;
    padding: 0.5rem 1rem;
    border: 0;
    border-radius: 0.375rem;
    background: var(--primary);
    color: var(--primary-foreground);
    font: inherit;
    font-size: var(--control-font-size);
    font-weight: 500;
    cursor: pointer;
  }
  button[type="submit"]:hover {
    background: color-mix(in srgb, var(--primary) 90%, #000);
  }
  button[type="submit"]:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent);
  }
`;

const FORM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Access</title>
  <style>
${UI_TOKENS_CSS}
${GATE_LAYOUT_CSS}
  </style>
</head>
<body>
  <div class="shell">
    <main class="panel" data-testid="access-gate-form" role="region" aria-labelledby="access-gate-title">
      <div class="header">
        <h1 id="access-gate-title">Marplanner Kiosk</h1>
        <p class="description">Enter the access token to open this device.</p>
      </div>
      <form method="POST" action="/gate">
        <div class="field">
          <label for="access-token">Access token</label>
          <input
            id="access-token"
            type="password"
            name="token"
            autocomplete="off"
            autofocus
            placeholder="Access token"
          >
        </div>
        <button type="submit">Enter</button>
      </form>
    </main>
  </div>
</body>
</html>`;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest()
  );
}

// A configured access token is honored ONLY when it carries the ADR-037 `mpg-`
// prefix. A non-prefixed value (typo, weak placeholder) is treated as UNSET → the
// gate is unpassable (fail closed).
function configuredToken(): string | null {
  const token = process.env[ACCESS_ENV];
  if (!token || !token.startsWith("mpg-")) return null;
  return token;
}

function expectedCookieValue(): string | null {
  const token = configuredToken();
  if (!token) return null;
  return sha256Hex(token);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function hasValidGateCookie(cookieHeader: string | undefined): boolean {
  const expected = expectedCookieValue();
  if (!expected) return false;
  const got = readCookie(cookieHeader, GATE_COOKIE);
  if (!got) return false;
  return safeEqual(got, expected);
}

export function sendGateForm(reply: FastifyReply, basePath = ""): FastifyReply {
  return reply
    .code(200)
    .header("content-type", "text/html; charset=utf-8")
    .send(FORM_HTML.replace('action="/gate"', `action="${basePath}/gate"`));
}

export function isGateExempt(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/health" || pathname === "/gate";
}

export async function accessGate(app: FastifyInstance, basePath = ""): Promise<void> {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    }
  );

  app.post(`${basePath}/gate`, async (request, reply) => {
    const token = configuredToken();
    const submitted = (request.body as Record<string, string> | null)?.token;
    if (
      !token ||
      typeof submitted !== "string" ||
      submitted.length === 0 ||
      !safeEqual(submitted, token)
    ) {
      return sendGateForm(reply, basePath);
    }
    return reply
      .header("Set-Cookie", serializeAuthCookie(GATE_COOKIE, sha256Hex(token), basePath))
      .code(303)
      .header("location", `${basePath}/`)
      .send();
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.split("?")[0] === "/health") return;
    // Gate exemptions use the raw pathname: decoding here would turn an encoded
    // frontend path into the unauthenticated provisioning exemption.
    const pathname = stripBasePath(request.url.split("?")[0], basePath) ?? "";
    if (isGateExempt(pathname)) return;
    if (hasValidGateCookie(request.headers.cookie)) return;
    return sendGateForm(reply, basePath);
  });
}
