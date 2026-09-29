import { createHash } from "node:crypto";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Headers } from "undici";
import {
  ExternalSourceValidationError,
  resolveExternalSourceUrl,
  type ResolveExternalSourceHost,
  type ResolvedAddress,
} from "./external-sources";

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type CalendarFeedErrorCode =
  "unsafe_url" | "unavailable" | "timeout" | "too_large" | "invalid_calendar";

export class CalendarFeedFetchError extends Error {
  readonly code: CalendarFeedErrorCode;

  constructor(code: CalendarFeedErrorCode) {
    super(code);
    this.name = "CalendarFeedFetchError";
    this.code = code;
  }
}

export interface CalendarFeedHttpResponse {
  status: number;
  headers: Pick<Headers, "get">;
  body: ReadableStream<Uint8Array> | null;
  dispose: () => Promise<void>;
}

export interface CalendarFeedRequestContext {
  url: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
  lookup: LookupFunction;
}

export type CalendarFeedRequest = (
  context: CalendarFeedRequestContext
) => Promise<CalendarFeedHttpResponse>;
export type CalendarFeedTransport = (url: URL) => Promise<string>;

export interface FetchIcsDependencies {
  lookup?: ResolveExternalSourceHost;
  request?: CalendarFeedRequest;
  transport?: CalendarFeedTransport;
  log?: (message: string, details: { code: CalendarFeedErrorCode }) => void;
}

export interface FetchIcsValidators {
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

export type FetchIcsResult =
  | { kind: "not_modified" }
  | {
      kind: "unchanged";
      contentHash: string;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      kind: "modified";
      body: string;
      contentHash: string;
      etag: string | null;
      lastModified: string | null;
    };

function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return ((_hostname, options, callback) => {
    if (options.all) {
      callback(
        null,
        pinned.map(({ address, family }) => ({ address, family }))
      );
      return;
    }
    const first = pinned[0];
    callback(null, first.address, first.family);
  }) as LookupFunction;
}

async function defaultRequest(
  context: CalendarFeedRequestContext
): Promise<CalendarFeedHttpResponse> {
  const dispatcher = new Agent({
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout: FETCH_TIMEOUT_MS,
    connect: { lookup: context.lookup },
  });
  try {
    const response = await undiciFetch(context.url, {
      dispatcher,
      headers: context.headers,
      redirect: "manual",
      signal: context.signal,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      dispose: async () => {
        await dispatcher.destroy();
      },
    };
  } catch (error) {
    await dispatcher.destroy().catch(() => undefined);
    throw error;
  }
}

function conditionalHeaders(validators: FetchIcsValidators): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators.etag) headers["if-none-match"] = validators.etag;
  if (validators.lastModified) headers["if-modified-since"] = validators.lastModified;
  return headers;
}

async function discardBody(response: CalendarFeedHttpResponse): Promise<void> {
  if (response.body) await response.body.cancel().catch(() => undefined);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function readBoundedBody(
  response: CalendarFeedHttpResponse,
  signal: AbortSignal
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await discardBody(response);
      throw new CalendarFeedFetchError("too_large");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CalendarFeedFetchError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodePayload(bytes: Uint8Array, contentType: string | null): string {
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CalendarFeedFetchError("invalid_calendar");
  }
  const normalized = body.replace(/^\uFEFF/, "").trim();
  const structuralCalendar =
    normalized.startsWith("BEGIN:VCALENDAR") && normalized.endsWith("END:VCALENDAR");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/calendar" && !structuralCalendar)
    throw new CalendarFeedFetchError("invalid_calendar");
  return body;
}

function stableError(error: unknown, signal: AbortSignal): CalendarFeedFetchError {
  if (error instanceof CalendarFeedFetchError) return error;
  if (error instanceof ExternalSourceValidationError)
    return new CalendarFeedFetchError("unsafe_url");
  if (signal.aborted) return new CalendarFeedFetchError("timeout");
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(
      String(error.code)
    )
  )
    return new CalendarFeedFetchError("timeout");
  return new CalendarFeedFetchError("unavailable");
}

/** Retrieves one feed without allowing DNS to change between validation and connection. Every
 * redirect is resolved, validated, and pinned independently before the next request is made.
 */
export async function fetchIcsResult(
  rawUrl: string,
  validators: FetchIcsValidators = {},
  dependencies: FetchIcsDependencies = {}
): Promise<FetchIcsResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new CalendarFeedFetchError("timeout")),
    FETCH_TIMEOUT_MS
  );
  timeout.unref();

  try {
    let nextUrl = rawUrl;
    for (let redirects = 0; ; redirects++) {
      const resolved = await abortable(
        resolveExternalSourceUrl(nextUrl, dependencies.lookup),
        controller.signal
      );
      const response = await abortable(
        (dependencies.request ?? defaultRequest)({
          url: resolved.url,
          headers: conditionalHeaders(validators),
          signal: controller.signal,
          lookup: pinnedLookup(resolved.addresses),
        }),
        controller.signal
      );
      try {
        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects >= MAX_REDIRECTS) throw new CalendarFeedFetchError("unavailable");
          const location = response.headers.get("location");
          if (!location) throw new CalendarFeedFetchError("unavailable");
          await discardBody(response);
          try {
            nextUrl = new URL(location, resolved.url).toString();
          } catch {
            throw new CalendarFeedFetchError("unsafe_url");
          }
          continue;
        }
        if (response.status === 304) {
          await discardBody(response);
          return { kind: "not_modified" };
        }
        if (response.status < 200 || response.status >= 300) {
          await discardBody(response);
          throw new CalendarFeedFetchError("unavailable");
        }

        const bytes = await readBoundedBody(response, controller.signal);
        const body = decodePayload(bytes, response.headers.get("content-type"));
        const contentHash = createHash("sha256").update(bytes).digest("hex");
        const metadata = {
          contentHash,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
        if (validators.contentHash === contentHash) return { kind: "unchanged", ...metadata };
        return { kind: "modified", body, ...metadata };
      } finally {
        await response.dispose().catch(() => undefined);
      }
    }
  } catch (error) {
    const safe = stableError(error, controller.signal);
    try {
      dependencies.log?.("calendar_feed_fetch_failed", { code: safe.code });
    } catch {
      // Diagnostics are best-effort and must never replace the stable retrieval outcome.
    }
    throw safe;
  } finally {
    clearTimeout(timeout);
  }
}

/** compatibility facade. The controlled transport remains dependency-injected; production
 * retrieval always uses the bounded, redirect-aware, DNS-pinned implementation above.
 */
export async function fetchIcs(
  rawUrl: string,
  dependencies: FetchIcsDependencies = {}
): Promise<string> {
  if (dependencies.transport) {
    const { url } = await resolveExternalSourceUrl(rawUrl, dependencies.lookup);
    const body = await dependencies.transport(url);
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new CalendarFeedFetchError("too_large");
    return decodePayload(bytes, null);
  }

  const result = await fetchIcsResult(rawUrl, {}, dependencies);
  if (result.kind !== "modified") throw new CalendarFeedFetchError("unavailable");
  return result.body;
}
