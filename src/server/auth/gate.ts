import { stripBasePath } from "../../shared/base-path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { GATE_COOKIE, serializeAuthCookie } from "./cookies";

const ACCESS_ENV = "MP_ACCESS_TOKEN";

export { GATE_COOKIE };

const FORM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Access</title></head>
<body><main data-testid="access-gate-form">
<h1>Access required</h1>
<form method="POST" action="/gate">
<label>Access token <input type="password" name="token" autocomplete="off"></label>
<button type="submit">Enter</button>
</form></main></body></html>`;

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
