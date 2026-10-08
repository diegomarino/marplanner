import { log } from "@/lib/logger";

export class LocalizedApiError extends Error {}

/** Translate by stable codes, never by server/browser prose. Operational details stay in logs. */
export async function responseMessage(
  response: Response,
  fallback: string,
  codeMessages: Readonly<Record<string, string>> = {}
): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : "unknown";
  log("warn", "admin", "request_failed", { status: response.status, code });
  return Object.hasOwn(codeMessages, code) ? codeMessages[code] : fallback;
}
